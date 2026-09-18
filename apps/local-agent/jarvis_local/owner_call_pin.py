"""Attended Windows CLI for the Worker-side four-digit owner call PIN.

The PIN is the credential Sid speaks, or keys in, immediately before a
sensitive action. It is generated on the Worker so the digits exist in exactly
one response, and this side never writes them anywhere: the owner stores them
the way the passphrase is stored, and the database holds only a verifier under
the same pepper-plus-chained-PBKDF2 construction with its own domain prefix.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.sync.cloud_client import (
    CloudAuthError,
    CloudOwnerCallPinMismatchError,
    CloudOwnerCallPinStateChangedError,
    CloudRequestExpiredError,
    CloudSyncError,
    HttpCloudClient,
)

OWNER_CALL_PIN_PATH = "/identity/owner-call-pin"
AUDIENCE = "jarvis-local-agent"
_DIGITS = re.compile(r"^[0-9]{4}$", re.ASCII)
_REQUIRED = (
    "JARVIS_CLOUD_BASE_URL",
    "JARVIS_DEVICE_ID",
    "JARVIS_PRINCIPAL_ID",
    "JARVIS_DEVICE_KEY_PATH",
)


@dataclass(frozen=True, slots=True)
class OwnerCallPinStatus:
    pin_version: int | None
    pin_status: str | None


@dataclass(frozen=True, slots=True)
class GeneratedOwnerCallPin:
    pin: str
    pin_version: int


class OwnerCallPinConfigurationError(RuntimeError):
    """Required local generation settings are unavailable."""


class OwnerCallPinKeyUnavailableError(RuntimeError):
    """The configured device key cannot be loaded safely."""


class OwnerCallPinClient:
    def __init__(self, transport: HttpCloudClient) -> None:
        self._transport = transport

    def status(self) -> OwnerCallPinStatus:
        result = self._transport.post_signed(
            OWNER_CALL_PIN_PATH,
            {"schemaVersion": "1.0", "operation": "status"},
        )
        if set(result) != {"schemaVersion", "deviceKeyMatches", "pinVersion", "pinStatus"}:
            raise CloudSyncError("gateway returned an invalid owner call PIN status")
        version = result["pinVersion"]
        status = result["pinStatus"]
        if (
            result["schemaVersion"] != "1.0"
            or result["deviceKeyMatches"] is not True
            or status not in {None, "active"}
            or (version is None) != (status is None)
            or (
                version is not None
                and (not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= 2_147_483_646)
            )
        ):
            raise CloudSyncError("gateway returned an invalid owner call PIN status")
        return OwnerCallPinStatus(version, status)

    def generate(self, expected_pin_version: int | None) -> GeneratedOwnerCallPin:
        result = self._transport.post_signed(
            OWNER_CALL_PIN_PATH,
            {
                "schemaVersion": "1.0",
                "operation": "generate",
                "expectedPinVersion": expected_pin_version,
            },
        )
        expected_fields = {"schemaVersion", "deviceKeyMatches", "pinVersion", "pinStatus", "pin"}
        if set(result) != expected_fields:
            raise CloudSyncError("gateway returned an invalid generated owner call PIN")
        version = result["pinVersion"]
        pin = result["pin"]
        if (
            result["schemaVersion"] != "1.0"
            or result["deviceKeyMatches"] is not True
            or result["pinStatus"] != "active"
            or not isinstance(version, int)
            or isinstance(version, bool)
            or version != (1 if expected_pin_version is None else expected_pin_version + 1)
            or not isinstance(pin, str)
            or _DIGITS.fullmatch(pin) is None
        ):
            raise CloudSyncError("gateway returned an invalid generated owner call PIN")
        return GeneratedOwnerCallPin(pin, version)


def _is_windows() -> bool:
    return os.name == "nt"


def _interactive_terminal() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def _client(config: JarvisLocalConfig) -> OwnerCallPinClient:
    values: dict[str, str] = {}
    for name in _REQUIRED:
        value = config.environment.get(name, "").strip()
        if not value:
            raise OwnerCallPinConfigurationError("owner call PIN configuration missing")
        values[name] = value
    try:
        key = platform_device_key_store(Path(values["JARVIS_DEVICE_KEY_PATH"])).load_existing()
    except Exception as error:
        raise OwnerCallPinKeyUnavailableError("device key unavailable") from error
    if not isinstance(key, Ed25519PrivateKey):
        raise OwnerCallPinKeyUnavailableError("device key unavailable")
    try:
        transport = HttpCloudClient(
            base_url=values["JARVIS_CLOUD_BASE_URL"],
            device_id=values["JARVIS_DEVICE_ID"],
            principal_id=values["JARVIS_PRINCIPAL_ID"],
            audience=AUDIENCE,
            key=key,
        )
    except (TypeError, ValueError) as error:
        raise OwnerCallPinConfigurationError("owner call PIN configuration invalid") from error
    return OwnerCallPinClient(transport)


def _failure(error: Exception, action: str) -> int:
    if isinstance(error, CloudRequestExpiredError):
        print("device clock is outside the gateway freshness window")
        return 2
    if isinstance(error, CloudAuthError):
        print("device key does not match the active production record")
        return 1
    if isinstance(error, CloudOwnerCallPinMismatchError):
        print("server owner identity configuration does not match the enrolled device principal")
        return 1
    if isinstance(error, CloudOwnerCallPinStateChangedError):
        print("owner call PIN changed during generation; run the command again")
        return 1
    print(f"owner call PIN {action} is unavailable")
    return 4


def run_owner_call_pin(config: JarvisLocalConfig, operation: str) -> int:
    """Create, rotate or inspect the four digits without writing them to disk."""
    if operation not in {"status", "generate"}:
        raise AssertionError(f"unknown owner call PIN operation: {operation}")
    if not _is_windows():
        print("owner call PIN generation must run from the enrolled Windows 11 PC")
        return 2
    if operation == "generate" and not _interactive_terminal():
        print("owner call PIN generation requires an interactive terminal")
        return 2
    try:
        client = _client(config)
    except OwnerCallPinConfigurationError:
        print("owner call PIN configuration is incomplete")
        return 2
    except OwnerCallPinKeyUnavailableError:
        print("configured device key is missing or unreadable")
        return 1

    try:
        status = client.status()
    except (CloudRequestExpiredError, CloudAuthError, CloudOwnerCallPinMismatchError, CloudSyncError) as error:
        return _failure(error, "status")
    if operation == "status":
        if status.pin_version is None:
            print("owner call PIN is not configured")
            return 1
        print(f"owner call PIN verifier version is {status.pin_version}")
        return 0

    action = "replace" if status.pin_version is not None else "create"
    if input(f"{action.capitalize()} the owner call PIN? Type yes to continue: ").strip().lower() != "yes":
        print("owner call PIN generation cancelled")
        return 1
    try:
        generated = client.generate(status.pin_version)
    except (
        CloudRequestExpiredError,
        CloudAuthError,
        CloudOwnerCallPinMismatchError,
        CloudOwnerCallPinStateChangedError,
        CloudSyncError,
    ) as error:
        return _failure(error, "generation")
    print("Owner call PIN (shown once):")
    print(generated.pin)
    print(f"Pin version: {generated.pin_version}")
    print("Memorise these four digits, then close this terminal.")
    return 0
