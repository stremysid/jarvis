"""Linux sealing backed by a separate owner-readable file key.

Linux has no DPAPI equivalent. The home node instead protects one random
wrapping key with the operating system's file permissions and uses that key
to encrypt the device identity. Copying only the device-key file is therefore
insufficient, while copying either file to another account is refused before
decryption if its mode grants group or world access.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEY_BYTES = 32
NONCE_BYTES = 12
FILE_KEY_PREFIX = b"FILEKEY:"
_AAD = b"jarvis-linux-device-key-v1"


class FileKeyProtector:
    """Encrypts bytes with an owner-only key stored in a separate file."""

    def __init__(self, key_path: Path) -> None:
        self.key_path = Path(key_path)

    def protect(self, plaintext: bytes) -> bytes:
        key = self._load_or_create_key()
        nonce = os.urandom(NONCE_BYTES)
        return nonce + AESGCM(key).encrypt(nonce, plaintext, _AAD)

    def unprotect(self, ciphertext: bytes) -> bytes:
        if len(ciphertext) <= NONCE_BYTES:
            raise ValueError("file-key ciphertext is truncated")
        key = self._load_key()
        nonce = ciphertext[:NONCE_BYTES]
        return AESGCM(key).decrypt(nonce, ciphertext[NONCE_BYTES:], _AAD)

    def _load_or_create_key(self) -> bytes:
        if self.key_path.exists():
            return self._load_key()
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        key = os.urandom(KEY_BYTES)
        descriptor = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
        try:
            os.write(descriptor, key)
        finally:
            os.close(descriptor)
        return key

    def _load_key(self) -> bytes:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(self.key_path, flags)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise PermissionError("the Linux sealing key is not a regular file")
            if metadata.st_uid != os.geteuid():  # type: ignore[attr-defined,unused-ignore]
                raise PermissionError("the Linux sealing key is not owned by this user")
            if metadata.st_mode & 0o077:
                raise PermissionError("the Linux sealing key is accessible to group or world")
            key = os.read(descriptor, KEY_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(key) != KEY_BYTES:
            raise ValueError("the Linux sealing key has the wrong length")
        return key
