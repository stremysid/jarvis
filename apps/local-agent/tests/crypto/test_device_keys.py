"""Device key storage.

The device key signs every request the agent makes to the cloud, so it must
never sit on disk unprotected. Preferred path: a non-exportable CNG key, where
the private bytes never enter the process at all. Fallback: an Ed25519 key
sealed with DPAPI, which binds it to this Windows user.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from jarvis_local.crypto.device_keys import DPAPI_PREFIX, DeviceKeyStore


class FakeCng:
    """Stands in for Windows CNG. Records whether it was asked for a key."""

    def __init__(self, *, supports_non_exportable: bool) -> None:
        self.supports_non_exportable = supports_non_exportable
        self.created = 0

    def create_non_exportable_key(self, name: str) -> bytes:
        if not self.supports_non_exportable:
            raise RuntimeError("non-exportable keys unavailable")
        self.created += 1
        return f"cng-handle:{name}".encode()


class FakeDpapi:
    """Reversible stand-in for CryptProtectData/CryptUnprotectData."""

    def __init__(self) -> None:
        self.protected = 0
        self.unprotected = 0

    def protect(self, plaintext: bytes) -> bytes:
        self.protected += 1
        return b"sealed:" + plaintext[::-1]

    def unprotect(self, ciphertext: bytes) -> bytes:
        self.unprotected += 1
        if not ciphertext.startswith(b"sealed:"):
            raise ValueError("not sealed by this protector")
        return ciphertext[len(b"sealed:") :][::-1]


def test_fallback_private_key_is_dpapi_protected(tmp_path: Path) -> None:
    store = DeviceKeyStore(tmp_path / "device.key", FakeCng(supports_non_exportable=False), FakeDpapi())
    store.load_or_create()
    assert (tmp_path / "device.key").read_bytes().startswith(DPAPI_PREFIX)


def test_fallback_never_writes_raw_private_key_bytes(tmp_path: Path) -> None:
    path = tmp_path / "device.key"
    dpapi = FakeDpapi()
    key = DeviceKeyStore(path, FakeCng(supports_non_exportable=False), dpapi).load_or_create()

    on_disk = path.read_bytes()
    raw = key.private_bytes_raw()
    assert raw not in on_disk
    assert dpapi.protected == 1


def test_reload_returns_the_same_key_without_regenerating(tmp_path: Path) -> None:
    path = tmp_path / "device.key"
    dpapi = FakeDpapi()
    first = DeviceKeyStore(path, FakeCng(supports_non_exportable=False), dpapi).load_or_create()
    sealed = path.read_bytes()

    second = DeviceKeyStore(path, FakeCng(supports_non_exportable=False), dpapi).load_or_create()

    assert first.private_bytes_raw() == second.private_bytes_raw()
    assert path.read_bytes() == sealed  # untouched on reload
    assert dpapi.protected == 1  # sealed once, not again


def test_prefers_non_exportable_cng_and_writes_no_private_material(tmp_path: Path) -> None:
    path = tmp_path / "device.key"
    cng = FakeCng(supports_non_exportable=True)
    dpapi = FakeDpapi()

    DeviceKeyStore(path, cng, dpapi).load_or_create()

    assert cng.created == 1
    assert dpapi.protected == 0  # DPAPI is the fallback, not the default
    assert not path.exists()  # nothing private ever reaches the filesystem


def test_corrupt_key_file_is_rejected_rather_than_silently_replaced(tmp_path: Path) -> None:
    """Silently regenerating would revoke the device's enrollment without warning."""
    path = tmp_path / "device.key"
    path.write_bytes(DPAPI_PREFIX + b"not-actually-sealed")

    with pytest.raises(ValueError):
        DeviceKeyStore(path, FakeCng(supports_non_exportable=False), FakeDpapi()).load_or_create()


def test_unprefixed_key_file_is_rejected(tmp_path: Path) -> None:
    """An unsealed file means something wrote a raw key; refuse to use it."""
    path = tmp_path / "device.key"
    path.write_bytes(b"raw-private-key-bytes")

    with pytest.raises(ValueError):
        DeviceKeyStore(path, FakeCng(supports_non_exportable=False), FakeDpapi()).load_or_create()


@pytest.mark.skipif(sys.platform == "win32", reason="st_mode does not reflect NTFS ACLs")
def test_key_file_is_created_with_restrictive_permissions(tmp_path: Path) -> None:
    """On POSIX the mode is the whole story; on Windows, DPAPI sealing is.

    Windows reports 0o666 regardless of the real ACL, so asserting the mode
    there would be theatre. What protects the key on Windows is that the file
    contents are sealed to this user account -- covered by the sealing tests
    above -- not the permission bits.
    """
    path = tmp_path / "device.key"
    DeviceKeyStore(path, FakeCng(supports_non_exportable=False), FakeDpapi()).load_or_create()
    assert path.exists()
    mode = path.stat().st_mode & 0o777
    assert mode & 0o077 == 0, f"key file is group/world accessible: {mode:o}"
