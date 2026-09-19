"""Python side of the versioned owner-passphrase known-answer contract."""

from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Set

CANONICALIZER_VERSION = "ascii-v1"
WORD_LIST_VERSION = "eff-long-cmudict-2026-09-v2"
DOMAIN = b"jarvis.owner-passphrase/v1"
# Production workerd rejects a single PBKDF2 call above 100,000 iterations, so the
# Worker reaches its 600,000-iteration work factor as six chained passes over the
# same salt, each taking the previous 32-byte result as its password. One 600,000
# iteration call is NOT the same derivation, and the shared known-answer fixture
# exists to catch exactly that divergence: this side follows the chain, not the
# total. ITERATIONS stays as the documented total for anything reporting the cost.
PASSES = 6
PASS_ITERATIONS = 100_000
ITERATIONS = PASSES * PASS_ITERATIONS
_IDENTITY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$", re.ASCII)
_IGNORED = frozenset("!\"',.:;?")
_WHITESPACE = frozenset("\t\n\v\f\r ")


def canonicalize_owner_passphrase(candidate: str, allowed_words: Set[str]) -> bytes:
    """Apply ASCII-v1 and require exactly three words from the supplied versioned list."""
    if not isinstance(candidate, str) or not 0 < len(candidate) <= 128:
        raise ValueError("owner_passphrase_candidate_invalid")
    output: list[str] = []
    pending_space = False
    for character in candidate:
        code = ord(character)
        if code > 0x7F:
            raise ValueError("owner_passphrase_candidate_invalid")
        if "A" <= character <= "Z":
            character = chr(code + 0x20)
        if "a" <= character <= "z":
            if pending_space and output:
                output.append(" ")
            output.append(character)
            pending_space = False
        elif character in _WHITESPACE:
            pending_space = bool(output)
        elif character not in _IGNORED:
            raise ValueError("owner_passphrase_candidate_invalid")
    canonical = "".join(output)
    words = canonical.split(" ")
    if len(words) != 3 or any(word not in allowed_words for word in words):
        raise ValueError("owner_passphrase_candidate_invalid")
    return canonical.encode("ascii")


def derive_owner_passphrase_digest(
    *,
    pepper: bytes,
    owner_identity_id: str,
    verifier_version: int,
    canonical_phrase: bytes,
    salt: bytes,
) -> bytes:
    """Build the reviewed HMAC then PBKDF2 verifier for cross-runtime vectors."""
    if len(pepper) != 32 or len(salt) != 16:
        raise ValueError("owner_passphrase_vector_invalid")
    if _IDENTITY_ID.fullmatch(owner_identity_id) is None:
        raise ValueError("owner_passphrase_vector_invalid")
    if not 1 <= verifier_version <= 2_147_483_647:
        raise ValueError("owner_passphrase_vector_invalid")
    material = b"\0".join((
        DOMAIN,
        owner_identity_id.encode("ascii"),
        str(verifier_version).encode("ascii"),
        canonical_phrase,
    ))
    peppered = hmac.digest(pepper, material, "sha256")
    try:
        derived = peppered
        for _ in range(PASSES):
            derived = hashlib.pbkdf2_hmac("sha256", derived, salt, PASS_ITERATIONS, dklen=32)
        return derived
    finally:
        # bytes are immutable in CPython. The production Worker uses mutable
        # Uint8Arrays and clears its copies; this helper exists only for KATs.
        material = b""
        peppered = b""
