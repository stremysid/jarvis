"""Jarvis Brain Bridge contract primitives."""

from .canonical import CanonicalJsonError, canonical_json_bytes, decode_json_bytes, sha256_hex
from .contracts import ContractError

__all__ = [
    "CanonicalJsonError",
    "ContractError",
    "canonical_json_bytes",
    "decode_json_bytes",
    "sha256_hex",
]

__version__ = "0.1.0"
