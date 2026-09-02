"""Device signing key: created once, protected always.

Every request the agent sends to the cloud is signed with this key, so
possession of it is possession of the device's identity.

Two storage strategies, in order of preference:

1. A non-exportable CNG key, where the private bytes never enter this process.
2. An Ed25519 key sealed with DPAPI and written to disk.

In practice (2) is the path taken on Windows today: CNG exposes no Ed25519
provider, and the foundation design fixes Ed25519 as the signature algorithm.
`WindowsCng` therefore reports the capability as unavailable rather than
pretending, and the fallback is the real mechanism — which is exactly why it
seals rather than storing raw bytes.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path
from typing import Protocol

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.crypto.dpapi import DpapiProtector

# Marks a file as sealed. Its absence means something wrote unprotected
# material, which is refused rather than trusted.
DPAPI_PREFIX = b"DPAPI:"


class CngProvider(Protocol):
    supports_non_exportable: bool

    def create_non_exportable_key(self, name: str) -> bytes: ...


class WindowsCng:
    """Windows CNG. Reports no Ed25519 non-exportable support, because there is none."""

    # Kept as an attribute rather than a constant so a future CNG release, or a
    # change of signature algorithm, only needs this flag flipped.
    supports_non_exportable = False

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("WindowsCng requires Windows")

    def create_non_exportable_key(self, name: str) -> bytes:
        raise RuntimeError("CNG exposes no Ed25519 provider; use the DPAPI-sealed fallback")


class CngDeviceKey:
    """A key living inside CNG. The private bytes are not retrievable by design."""

    def __init__(self, handle: bytes) -> None:
        self.handle = handle


class DeviceKeyStore:
    """Loads the device key, creating and protecting it on first use."""

    def __init__(self, path: Path, cng: CngProvider, dpapi: DpapiProtector, *, key_name: str = "jarvis-device") -> None:
        self.path = Path(path)
        self.cng = cng
        self.dpapi = dpapi
        self.key_name = key_name

    def load_or_create(self) -> Ed25519PrivateKey | CngDeviceKey:
        if self.cng.supports_non_exportable:
            # Nothing private reaches the filesystem on this path.
            return CngDeviceKey(self.cng.create_non_exportable_key(self.key_name))
        if self.path.exists():
            return self._load_sealed()
        return self._create_sealed()

    def _load_sealed(self) -> Ed25519PrivateKey:
        sealed = self.path.read_bytes()
        if not sealed.startswith(DPAPI_PREFIX):
            # An unsealed file means some other writer put raw material here.
            # Refuse it; do not silently overwrite, which would revoke the
            # device's enrollment without anyone noticing.
            raise ValueError(f"{self.path} is not DPAPI-sealed")
        try:
            raw = self.dpapi.unprotect(sealed[len(DPAPI_PREFIX) :])
        except Exception as error:
            raise ValueError(f"{self.path} could not be unsealed") from error
        try:
            return Ed25519PrivateKey.from_private_bytes(raw)
        except Exception as error:
            raise ValueError(f"{self.path} does not contain an Ed25519 private key") from error

    def _create_sealed(self) -> Ed25519PrivateKey:
        key = Ed25519PrivateKey.generate()
        sealed = DPAPI_PREFIX + self.dpapi.protect(key.private_bytes_raw())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Create with owner-only permissions before any bytes are written, so
        # the key is never briefly world-readable. O_BINARY is essential on
        # Windows: os.open defaults to text mode there, and os.write would
        # expand every 0x0A in the sealed key to 0x0D 0x0A, silently corrupting
        # it. The damage only surfaces on the next load, as an unparseable key.
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        descriptor = os.open(self.path, flags, stat.S_IRUSR | stat.S_IWUSR)
        try:
            os.write(descriptor, sealed)
        finally:
            os.close(descriptor)
        return key
