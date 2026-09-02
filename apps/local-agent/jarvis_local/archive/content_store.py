"""Content addressing for archived documents.

The same document is often observed many times. Storing its text once under a
hash and appending one small row per sighting keeps the archive proportional
to distinct content rather than to observation count, while still recording
when each sighting happened and which event produced it.
"""

from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass

import rfc8785


def normalize_nfc(text: str) -> str:
    """Unicode NFC, matching the canonical form used across every Jarvis payload.

    Without this, "café" composed and decomposed -- visually identical -- would
    hash differently and become two blobs, so a fact citing one would not match
    a retrieval of the other.
    """
    return unicodedata.normalize("NFC", text)


def canonical_content_hash(text: str) -> str:
    """SHA-256 over the RFC 8785 canonical JSON of the normalized text.

    Wrapped in an object rather than hashing raw bytes so the digest carries
    its own framing: a future document with structure alongside its text
    extends the object without colliding with today's text-only digests.
    """
    return hashlib.sha256(rfc8785.dumps({"text": normalize_nfc(text)})).hexdigest()


@dataclass(frozen=True, slots=True)
class ContentObservation:
    """One sighting of a document.

    `id` is the idempotency key: replaying the same observation must not
    manufacture a second sighting.
    """

    id: str
    source_event_id: str
    seen_at: str
