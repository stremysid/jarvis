"""One-shot Windows owner-phone enrollment over the device-signed gateway path."""

from __future__ import annotations

import base64
import getpass
import re
import secrets
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.sync.cloud_client import (
    CloudAuthError,
    CloudRequestExpiredError,
    CloudSyncError,
    HttpCloudClient,
)

OWNER_PHONE_ENROLLMENT_PATH = "/identity/owner-phone-enrollment"
AUDIENCE = "jarvis-local-agent"
E164 = re.compile(r"^\+[1-9]\d{7,14}$", re.ASCII)
SAFE_ATOM = re.compile(r"^[^\x00-\x1f\x7f\r\n]{1,256}$")
RESPONSE = re.compile(r"^\d{6}$", re.ASCII)
STATES = frozenset({"absent", "pending", "expired", "active", "conflict"})
REQUIRED = (
    "JARVIS_CLOUD_BASE_URL",
    "JARVIS_DEVICE_ID",
    "JARVIS_PRINCIPAL_ID",
    "JARVIS_DEVICE_KEY_PATH",
)


@dataclass(frozen=True, slots=True)
class PhoneEnrollmentResponse:
    state: str
    challenge_id: str | None = None
    response: str | None = None
    expires_at: str | None = None


class PhoneEnrollmentConfigurationError(RuntimeError):
    """Required local enrollment settings are unavailable."""


class PhoneEnrollmentKeyUnavailableError(RuntimeError):
    """The configured device key cannot be loaded safely."""


class OwnerPhoneEnrollmentClient:
    """Validates the fixed public contract over the shared signed transport."""

    def __init__(self, transport: HttpCloudClient) -> None:
        self._transport = transport

    def preflight(self) -> bool:
        result = self._transport.post_signed(
            OWNER_PHONE_ENROLLMENT_PATH,
            {"schemaVersion": "1.0", "operation": "preflight"},
        )
        if set(result) != {"schemaVersion", "deviceKeyMatches"}:
            raise CloudSyncError("gateway returned an invalid phone enrollment preflight")
        if result["schemaVersion"] != "1.0" or result["deviceKeyMatches"] is not True:
            raise CloudSyncError("gateway returned an invalid phone enrollment preflight")
        return True

    def status(self) -> PhoneEnrollmentResponse:
        result = self._transport.post_signed(
            OWNER_PHONE_ENROLLMENT_PATH,
            {"schemaVersion": "1.0", "operation": "status"},
        )
        return self._state(result, allow_challenge=False)

    def begin(self, phone_number: str) -> PhoneEnrollmentResponse:
        request_salt = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
        result = self._transport.post_signed(
            OWNER_PHONE_ENROLLMENT_PATH,
            {
                "schemaVersion": "1.0",
                "operation": "begin",
                "phoneNumber": phone_number,
                "requestSalt": request_salt,
            },
        )
        return self._state(result, allow_challenge=True)

    def _state(self, result: dict[str, Any], *, allow_challenge: bool) -> PhoneEnrollmentResponse:
        base = {"schemaVersion", "deviceKeyMatches", "enrollmentState"}
        if not base.issubset(result) or result["schemaVersion"] != "1.0" or result["deviceKeyMatches"] is not True:
            raise CloudSyncError("gateway returned an invalid phone enrollment state")
        state = result["enrollmentState"]
        if not isinstance(state, str) or state not in STATES:
            raise CloudSyncError("gateway returned an invalid phone enrollment state")
        if state != "pending" or not allow_challenge:
            if set(result) != base:
                raise CloudSyncError("gateway returned an invalid phone enrollment state")
            return PhoneEnrollmentResponse(state)
        challenge_fields = base | {"challengeId", "response", "expiresAt"}
        if set(result) != challenge_fields:
            raise CloudSyncError("gateway returned an invalid phone enrollment challenge")
        challenge_id = result["challengeId"]
        challenge_response = result["response"]
        expires_at = result["expiresAt"]
        if not isinstance(challenge_id, str) or SAFE_ATOM.fullmatch(challenge_id) is None:
            raise CloudSyncError("gateway returned an invalid phone enrollment challenge")
        if not isinstance(challenge_response, str) or RESPONSE.fullmatch(challenge_response) is None:
            raise CloudSyncError("gateway returned an invalid phone enrollment challenge")
        if not isinstance(expires_at, str) or not _canonical_timestamp(expires_at):
            raise CloudSyncError("gateway returned an invalid phone enrollment challenge")
        return PhoneEnrollmentResponse(state, challenge_id, challenge_response, expires_at)


def _canonical_timestamp(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return value.endswith("Z") and parsed.tzinfo is not None


def _is_windows() -> bool:
    # Behind a function so mypy cannot erase the Windows body on another platform run.
    return sys.platform == "win32"


def _interactive_terminal() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def _client(config: JarvisLocalConfig) -> OwnerPhoneEnrollmentClient:
    values = {name: config.environment.get(name, "").strip() for name in REQUIRED}
    if any(not value for value in values.values()):
        raise PhoneEnrollmentConfigurationError("phone enrollment configuration incomplete")
    try:
        key = platform_device_key_store(Path(values["JARVIS_DEVICE_KEY_PATH"])).load_existing()
    except Exception as error:
        raise PhoneEnrollmentKeyUnavailableError("device key unavailable") from error
    if not isinstance(key, Ed25519PrivateKey):
        raise PhoneEnrollmentKeyUnavailableError("device key unavailable")
    try:
        transport = HttpCloudClient(
            base_url=values["JARVIS_CLOUD_BASE_URL"],
            device_id=values["JARVIS_DEVICE_ID"],
            principal_id=values["JARVIS_PRINCIPAL_ID"],
            audience=AUDIENCE,
            key=key,
        )
    except (TypeError, ValueError) as error:
        raise PhoneEnrollmentConfigurationError("phone enrollment configuration invalid") from error
    return OwnerPhoneEnrollmentClient(transport)


def run_phone_enrollment(config: JarvisLocalConfig, operation: str) -> int:
    """Run one enrollment action with fixed, non-disclosing operator output."""
    if operation not in {"preflight", "status", "begin"}:
        raise AssertionError(f"unknown phone enrollment operation: {operation}")
    if not _is_windows():
        print("owner phone enrollment must run from the enrolled Windows 11 PC")
        return 2
    if operation == "begin" and not _interactive_terminal():
        print("owner phone enrollment requires an interactive terminal")
        return 2
    try:
        client = _client(config)
    except PhoneEnrollmentConfigurationError:
        print("owner phone enrollment configuration is incomplete")
        return 2
    except PhoneEnrollmentKeyUnavailableError:
        print("configured device key is missing or unreadable")
        return 1

    if operation == "preflight":
        try:
            client.preflight()
        except CloudRequestExpiredError:
            print("device clock is outside the gateway freshness window")
            return 2
        except CloudAuthError:
            print("device key does not match the active production record")
            return 1
        except CloudSyncError:
            print("device key preflight is unavailable")
            return 4
        print("device key matches the active production record")
        return 0

    if operation == "status":
        try:
            state = client.status().state
        except CloudRequestExpiredError:
            print("device clock is outside the gateway freshness window")
            return 2
        except CloudAuthError:
            print("device key does not match the active production record")
            return 1
        except CloudSyncError:
            print("owner phone enrollment status is unavailable")
            return 4
        print(f"owner phone enrollment is {state}")
        return 0 if state in {"pending", "active"} else 1

    # A begin command performs its own key-match gate. The owner cannot bypass
    # the preflight by skipping the standalone --preflight command.
    try:
        client.preflight()
    except CloudRequestExpiredError:
        print("device clock is outside the gateway freshness window")
        return 2
    except CloudAuthError:
        print("device key does not match the active production record")
        return 1
    except CloudSyncError:
        print("device key preflight is unavailable")
        return 4
    phone_number = getpass.getpass("Phone number in E.164 form (input hidden): ").strip()
    if E164.fullmatch(phone_number) is None:
        print("phone number must use E.164 form")
        return 2
    repeated_phone_number = getpass.getpass("Re-enter the same phone number (input hidden): ").strip()
    if repeated_phone_number != phone_number:
        print("phone entries do not match")
        return 2
    if input(f"Enroll phone ending {phone_number[-4:]}? Type yes to continue: ").strip().lower() != "yes":
        print("owner phone enrollment cancelled")
        return 1
    try:
        result = client.begin(phone_number)
    except CloudRequestExpiredError:
        print("device clock is outside the gateway freshness window")
        return 2
    except CloudAuthError:
        print("device key does not match the active production record")
        return 1
    except CloudSyncError:
        print("owner phone enrollment request is unavailable")
        return 4
    if result.state != "pending":
        print(f"owner phone enrollment is {result.state}")
        return 0 if result.state == "active" else 1
    print(f"Enter response {result.response} during the attended inbound call before {result.expires_at}.")
    print("Then run: jarvis enroll-phone --status")
    return 0
