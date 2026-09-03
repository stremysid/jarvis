"""Lowercase ULIDs, generated and derived.

Every cross-boundary Jarvis payload uses lowercase Crockford base32 ULIDs, so
the local records use them too even though nothing has left the machine yet.
Minting a different local id shape and translating at the boundary would put
the translation on the path where a mistake is least visible: an id that only
becomes wrong when it is uploaded.

Two kinds are issued here and they are not interchangeable. `new_ulid` is
time-ordered and unique per call -- it names an event that happened once.
`derive_ulid` is a pure function of its inputs -- it names a thing that must
get the same id every time it is seen, such as a document identified by where
it sits in the vault. A derived id's leading characters are digest bytes, not
a timestamp, so it sorts arbitrarily; nothing may read a time out of one.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from datetime import UTC, datetime

#: Crockford base32, lowercase, with I, L, O and U removed.
CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

#: The shape every ULID crossing a Jarvis boundary must have. The leading
#: character is capped at 7 because 26 base32 characters hold 130 bits while a
#: ULID carries 128.
ULID_PATTERN = re.compile(r"^[0-7][0-9a-hjkmnp-tv-z]{25}$")

_ULID_LENGTH = 26
_TIMESTAMP_CHARS = 10
_RANDOM_CHARS = 16
_RANDOM_BYTES = 10


def _encode(value: int, length: int) -> str:
    if value < 0:
        raise ValueError("cannot encode a negative value as base32")
    encoded = ""
    remaining = value
    for _ in range(length):
        encoded = CROCKFORD_ALPHABET[remaining % 32] + encoded
        remaining //= 32
    if remaining:
        raise ValueError(f"value does not fit in {length} base32 characters")
    return encoded


def is_ulid(value: str) -> bool:
    return bool(ULID_PATTERN.match(value))


def new_ulid(*, now: datetime | None = None, entropy: bytes | None = None) -> str:
    """A fresh, time-ordered ULID for something that just happened.

    `entropy` exists so a test can pin the value; it is never supplied in
    production, where 80 random bits are what keeps two observations recorded
    in the same millisecond from colliding.
    """
    moment = now or datetime.now(UTC)
    milliseconds = int(moment.timestamp() * 1000)
    if not 0 <= milliseconds < 2**48:
        raise ValueError("ULID time must be a millisecond instant inside the 48-bit range")
    random_bytes = entropy or secrets.token_bytes(_RANDOM_BYTES)
    if len(random_bytes) != _RANDOM_BYTES:
        raise ValueError(f"ULID entropy must be {_RANDOM_BYTES} bytes, got {len(random_bytes)}")
    return _encode(milliseconds, _TIMESTAMP_CHARS) + _encode(int.from_bytes(random_bytes, "big"), _RANDOM_CHARS)


def derive_ulid(namespace: str, *parts: str) -> str:
    """The same id for the same inputs, forever.

    Used for document identity, which must survive a restart with no lookup
    table: re-crawling a vault has to recognise the note it saw yesterday, and
    a table that could disagree with the derivation is a second source of
    truth. Only the first 128 digest bits are used, which is what keeps the
    leading character inside the ULID range.
    """
    material = "\x00".join((namespace, *parts)).encode("utf-8")
    return _encode(int.from_bytes(hashlib.sha256(material).digest()[:16], "big"), _ULID_LENGTH)
