"""Windows DPAPI sealing for the device key.

DPAPI binds ciphertext to the current Windows user account, so a copied key
file is useless on another machine or under another user. That is the whole
reason the fallback path is acceptable at all.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from typing import Protocol

# Ties the ciphertext to this application's purpose. DPAPI requires the same
# entropy on unprotect, so a blob sealed by Jarvis cannot be opened by another
# process that merely runs as the same user.
_ENTROPY = b"jarvis-local-agent-device-key-v1"

CRYPTPROTECT_UI_FORBIDDEN = 0x1


class DpapiProtector(Protocol):
    """Seals and opens bytes for the current user."""

    def protect(self, plaintext: bytes) -> bytes: ...

    def unprotect(self, ciphertext: bytes) -> bytes: ...


class _DataBlob(ctypes.Structure):
    _fields_ = (("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char)))


def _blob(data: bytes) -> _DataBlob:
    buffer = ctypes.create_string_buffer(data, len(data))
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))


def _read_and_free(blob: _DataBlob) -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob.pbData)  # type: ignore[attr-defined,unused-ignore]


class WindowsDpapi:
    """Real DPAPI via CryptProtectData/CryptUnprotectData."""

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("WindowsDpapi requires Windows")

    def protect(self, plaintext: bytes) -> bytes:
        source, entropy, out = _blob(plaintext), _blob(_ENTROPY), _DataBlob()
        ok = ctypes.windll.crypt32.CryptProtectData(  # type: ignore[attr-defined,unused-ignore]
            ctypes.byref(source), None, ctypes.byref(entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out)
        )
        if not ok:
            raise OSError(ctypes.get_last_error(), "CryptProtectData failed")
        return _read_and_free(out)

    def unprotect(self, ciphertext: bytes) -> bytes:
        source, entropy, out = _blob(ciphertext), _blob(_ENTROPY), _DataBlob()
        ok = ctypes.windll.crypt32.CryptUnprotectData(  # type: ignore[attr-defined,unused-ignore]
            ctypes.byref(source), None, ctypes.byref(entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out)
        )
        if not ok:
            raise OSError(ctypes.get_last_error(), "CryptUnprotectData failed")
        return _read_and_free(out)
