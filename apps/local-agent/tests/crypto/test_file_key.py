"""Linux device-key sealing keeps encryption and file permissions inseparable."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.crypto.file_key import FILE_KEY_PREFIX, FileKeyProtector


@pytest.mark.skipif(sys.platform == "win32", reason="the home-node key boundary is POSIX-only")
def test_the_linux_device_key_is_encrypted_with_a_separate_owner_only_key(tmp_path: Path) -> None:
    device_path = tmp_path / "device.key"
    first = platform_device_key_store(device_path).load_or_create()

    wrapping_path = tmp_path / "device.key.seal-key"
    assert device_path.read_bytes().startswith(FILE_KEY_PREFIX)
    assert first.private_bytes_raw() not in device_path.read_bytes()
    assert wrapping_path.read_bytes() not in device_path.read_bytes()
    assert wrapping_path.stat().st_mode & 0o077 == 0

    second = platform_device_key_store(device_path).load_or_create()
    assert second.private_bytes_raw() == first.private_bytes_raw()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX modes do not describe Windows ACLs")
def test_a_linux_wrapping_key_exposed_to_other_users_is_refused(tmp_path: Path) -> None:
    key_path = tmp_path / "wrapping.key"
    protector = FileKeyProtector(key_path)
    ciphertext = protector.protect(b"private material")
    os.chmod(key_path, 0o644)

    with pytest.raises(PermissionError, match="group or world"):
        protector.unprotect(ciphertext)


@pytest.mark.skipif(sys.platform == "win32", reason="the home-node key boundary is POSIX-only")
def test_a_copied_device_key_cannot_be_opened_without_its_wrapping_key(tmp_path: Path) -> None:
    original = tmp_path / "original" / "device.key"
    platform_device_key_store(original).load_or_create()
    copied = tmp_path / "copied" / "device.key"
    copied.parent.mkdir()
    copied.write_bytes(original.read_bytes())

    with pytest.raises(ValueError, match="could not be unsealed"):
        platform_device_key_store(copied).load_or_create()


@pytest.mark.skipif(sys.platform == "win32", reason="the home-node key boundary is POSIX-only")
def test_a_symlink_cannot_redirect_the_linux_wrapping_key(tmp_path: Path) -> None:
    target = tmp_path / "target.key"
    target.write_bytes(os.urandom(32))
    os.chmod(target, 0o600)
    link = tmp_path / "wrapping.key"
    link.symlink_to(target)

    with pytest.raises(OSError):
        FileKeyProtector(link).protect(b"private material")
