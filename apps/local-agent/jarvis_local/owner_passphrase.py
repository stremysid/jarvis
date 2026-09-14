"""Attended Windows CLI for device-signed Worker-side phrase generation."""

from __future__ import annotations

import base64
import os
import re
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.sync.cloud_client import (
    CloudAuthError,
    CloudPassphraseStateChangedError,
    CloudRequestExpiredError,
    CloudSyncError,
    HttpCloudClient,
)

OWNER_PASSPHRASE_PATH = "/identity/owner-passphrase"  # noqa: S105 - HTTP path, not a credential
AUDIENCE = "jarvis-local-agent"
WORD_LIST_VERSION = "eff-long-cmudict-2026-09-v1"
_PHRASE = re.compile(r"^[a-z]{4,8} [a-z]{4,8} [a-z]{4,8}$", re.ASCII)
_REQUIRED = (
    "JARVIS_CLOUD_BASE_URL",
    "JARVIS_DEVICE_ID",
    "JARVIS_PRINCIPAL_ID",
    "JARVIS_DEVICE_KEY_PATH",
)


@dataclass(frozen=True, slots=True)
class OwnerPassphraseStatus:
    active_verifier_version: int | None


@dataclass(frozen=True, slots=True)
class GeneratedOwnerPassphrase:
    phrase: str
    verifier_version: int


class OwnerPassphraseConfigurationError(RuntimeError):
    """Required local generation settings are unavailable."""


class OwnerPassphraseKeyUnavailableError(RuntimeError):
    """The configured device key cannot be loaded safely."""


class OwnerPassphraseClient:
    def __init__(self, transport: HttpCloudClient) -> None:
        self._transport = transport

    def status(self) -> OwnerPassphraseStatus:
        result = self._transport.post_signed(
            OWNER_PASSPHRASE_PATH,
            {"schemaVersion": "1.0", "operation": "status"},
        )
        if set(result) != {"schemaVersion", "deviceKeyMatches", "activeVerifierVersion"}:
            raise CloudSyncError("gateway returned an invalid owner passphrase status")
        version = result["activeVerifierVersion"]
        if (
            result["schemaVersion"] != "1.0"
            or result["deviceKeyMatches"] is not True
            or (
                version is not None
                and (not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= 2_147_483_647)
            )
        ):
            raise CloudSyncError("gateway returned an invalid owner passphrase status")
        return OwnerPassphraseStatus(version)

    def generate(self, expected_verifier_version: int | None) -> GeneratedOwnerPassphrase:
        request_salt = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
        result = self._transport.post_signed(
            OWNER_PASSPHRASE_PATH,
            {
                "schemaVersion": "1.0",
                "operation": "generate",
                "expectedVerifierVersion": expected_verifier_version,
                "requestSalt": request_salt,
            },
        )
        expected_fields = {
            "schemaVersion", "deviceKeyMatches", "activeVerifierVersion", "wordListVersion", "phrase",
        }
        if set(result) != expected_fields:
            raise CloudSyncError("gateway returned an invalid generated owner passphrase")
        version = result["activeVerifierVersion"]
        phrase = result["phrase"]
        if (
            result["schemaVersion"] != "1.0"
            or result["deviceKeyMatches"] is not True
            or result["wordListVersion"] != WORD_LIST_VERSION
            or not isinstance(version, int)
            or isinstance(version, bool)
            or version != (1 if expected_verifier_version is None else expected_verifier_version + 1)
            or not isinstance(phrase, str)
            or _PHRASE.fullmatch(phrase) is None
        ):
            raise CloudSyncError("gateway returned an invalid generated owner passphrase")
        return GeneratedOwnerPassphrase(phrase, version)


def _is_windows() -> bool:
    return os.name == "nt"


def _interactive_terminal() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def _client(config: JarvisLocalConfig) -> OwnerPassphraseClient:
    values: dict[str, str] = {}
    for name in _REQUIRED:
        value = config.environment.get(name, "").strip()
        if not value:
            raise OwnerPassphraseConfigurationError("owner passphrase configuration missing")
        values[name] = value
    try:
        key = platform_device_key_store(Path(values["JARVIS_DEVICE_KEY_PATH"])).load_existing()
    except Exception as error:
        raise OwnerPassphraseKeyUnavailableError("device key unavailable") from error
    if not isinstance(key, Ed25519PrivateKey):
        raise OwnerPassphraseKeyUnavailableError("device key unavailable")
    try:
        transport = HttpCloudClient(
            base_url=values["JARVIS_CLOUD_BASE_URL"],
            device_id=values["JARVIS_DEVICE_ID"],
            principal_id=values["JARVIS_PRINCIPAL_ID"],
            audience=AUDIENCE,
            key=key,
        )
    except (TypeError, ValueError) as error:
        raise OwnerPassphraseConfigurationError("owner passphrase configuration invalid") from error
    return OwnerPassphraseClient(transport)


def _failure(error: Exception, action: str) -> int:
    if isinstance(error, CloudRequestExpiredError):
        print("device clock is outside the gateway freshness window")
        return 2
    if isinstance(error, CloudAuthError):
        print("device key does not match the active production record")
        return 1
    if isinstance(error, CloudPassphraseStateChangedError):
        print("owner passphrase changed during generation; run the command again")
        return 1
    print(f"owner passphrase {action} is unavailable")
    return 4


def run_owner_passphrase(config: JarvisLocalConfig, operation: str) -> int:
    if operation not in {"status", "generate"}:
        raise AssertionError(f"unknown owner passphrase operation: {operation}")
    if not _is_windows():
        print("owner passphrase generation must run from the enrolled Windows 11 PC")
        return 2
    if operation == "generate" and not _interactive_terminal():
        print("owner passphrase generation requires an interactive terminal")
        return 2
    try:
        client = _client(config)
    except OwnerPassphraseConfigurationError:
        print("owner passphrase configuration is incomplete")
        return 2
    except OwnerPassphraseKeyUnavailableError:
        print("configured device key is missing or unreadable")
        return 1

    try:
        status = client.status()
    except (CloudRequestExpiredError, CloudAuthError, CloudSyncError) as error:
        return _failure(error, "status")
    if operation == "status":
        if status.active_verifier_version is None:
            print("owner passphrase is not configured")
            return 1
        print(f"owner passphrase verifier version is {status.active_verifier_version}")
        return 0

    action = "replace" if status.active_verifier_version is not None else "create"
    if input(f"{action.capitalize()} the owner passphrase? Type yes to continue: ").strip().lower() != "yes":
        print("owner passphrase generation cancelled")
        return 1
    try:
        generated = client.generate(status.active_verifier_version)
    except (CloudRequestExpiredError, CloudAuthError, CloudPassphraseStateChangedError, CloudSyncError) as error:
        return _failure(error, "generation")
    print("Owner passphrase (shown once):")
    print(generated.phrase)
    print(f"Verifier version: {generated.verifier_version}")
    print("Store the phrase in the owner's password manager, then close this terminal.")
    return 0
