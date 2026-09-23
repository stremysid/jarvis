"""Embedding storage and exact cosine ranking over SQLite BLOBs.

This is the mandatory strategy from the release plan: vectors are stored as
little-endian float32 BLOBs and scored in process. It scans every row for the
active model, and that is the point -- an exact scan returns the same ranking
on every machine, with no extension to load, no approximate-neighbour
parameters to explain, and no second index to keep consistent. A native vector
extension is a *candidate* that has to beat this on the compatibility gate
before it is used; this is what runs when it does not.

The store is derived data. It can be deleted and rebuilt from the archive at
any time, which is why it lives in its own database file created with
CREATE TABLE IF NOT EXISTS rather than in the memory schema's migration chain:
there is nothing here worth migrating, and a stale index is fixed by throwing
it away.
"""

from __future__ import annotations

import math
import sqlite3
import struct
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from jarvis_local.archive.database import connect
from jarvis_local.clock import utc_now_iso
from jarvis_local.memory.embeddings import EmbeddingProvider

FLOAT32_BYTES = 4
DEFAULT_LIMIT = 8

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS event_embedding (
    event_id   TEXT NOT NULL,
    model_id   TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedding  BLOB NOT NULL,
    indexed_at TEXT NOT NULL,
    PRIMARY KEY (event_id, model_id)
) STRICT;
"""


class VectorEncodingError(ValueError):
    """A stored or supplied vector is not a usable float32 vector.

    Raised instead of coercing, truncating, or padding. A blob of the wrong
    length is corruption, and corruption that still produces a number would
    rank an event by a score that means nothing.
    """


class VectorIndexError(RuntimeError):
    """The index on disk does not match the model being used against it."""


@dataclass(frozen=True, slots=True)
class VectorMatch:
    event_id: str
    score: float


@dataclass(frozen=True, slots=True)
class IndexedDocument:
    """One archive event's canonical text, ready to embed."""

    event_id: str
    text: str


def encode_f32(vector: Sequence[float]) -> bytes:
    """Pack a vector as little-endian float32.

    Little-endian is stated explicitly rather than left to native order: the
    same database file has to decode identically if it is ever restored onto a
    different machine.
    """
    for position, value in enumerate(vector):
        if not math.isfinite(value):
            raise VectorEncodingError(f"vector component {position} is not finite: {value!r}")
    try:
        return struct.pack(f"<{len(vector)}f", *vector)
    except (struct.error, OverflowError) as error:
        raise VectorEncodingError(f"vector is not encodable as float32: {error}") from error


def decode_f32(blob: bytes, *, dimensions: int | None = None) -> list[float]:
    """Unpack a stored vector, refusing anything that is not exactly one.

    `dimensions` is checked when the caller knows the expected width, so a
    blob that is well-formed but belongs to a different model fails loudly
    rather than being compared against vectors it shares no basis with.
    """
    if len(blob) % FLOAT32_BYTES != 0:
        raise VectorEncodingError(f"vector blob is {len(blob)} bytes, not a multiple of {FLOAT32_BYTES}")
    values = list(struct.unpack(f"<{len(blob) // FLOAT32_BYTES}f", blob))
    if dimensions is not None and len(values) != dimensions:
        raise VectorEncodingError(f"vector blob holds {len(values)} components, expected {dimensions}")
    for position, value in enumerate(values):
        # NaN in a score sorts unpredictably and compares false against
        # everything, so it would corrupt the ranking silently.
        if not math.isfinite(value):
            raise VectorEncodingError(f"vector blob component {position} is not finite: {value!r}")
    return values


def cosine(left: Sequence[float], right: Sequence[float]) -> float:
    """Cosine similarity, order-independent to the last bit.

    `fsum` is exactly rounded, so the score does not depend on the order rows
    came back from SQLite -- which is what makes a rebuilt index reproduce the
    previous ranking exactly rather than approximately.
    """
    if len(left) != len(right):
        raise VectorEncodingError(f"cannot compare vectors of width {len(left)} and {len(right)}")
    left_norm = math.sqrt(math.fsum(value * value for value in left))
    right_norm = math.sqrt(math.fsum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return math.fsum(a * b for a, b in zip(left, right, strict=True)) / (left_norm * right_norm)


def cosine_search(query: Sequence[float], rows: Iterable[tuple[str, bytes]], limit: int) -> list[VectorMatch]:
    """Rank rows by cosine similarity, breaking ties by event id.

    The tie-break is not cosmetic. Equal scores are common (repeated text,
    zero vectors), and without a total order the top-k would depend on SQLite's
    row order, which would make the gate's rebuild check pass or fail by luck.
    """
    return sorted(
        (VectorMatch(event_id, cosine(query, decode_f32(blob))) for event_id, blob in rows),
        key=lambda item: (-item.score, item.event_id),
    )[:limit]


class VectorIndex:
    """Vectors for one model, in one SQLite file, searched by exact scan."""

    def __init__(self, connection: sqlite3.Connection, provider: EmbeddingProvider) -> None:
        self.connection = connection
        self._provider = provider

    @classmethod
    def open(cls, path: Path, provider: EmbeddingProvider, *, store_root: Path | None = None) -> VectorIndex:
        connection = connect(Path(path), store_root=store_root)
        connection.executescript(_CREATE_TABLE)
        # Reject an index built by a different model rather than quietly
        # returning nothing for it: an empty result set reads like "no
        # matches", and the operator would go looking for the wrong bug.
        foreign = connection.execute(
            "SELECT DISTINCT model_id FROM event_embedding WHERE model_id <> ? ORDER BY model_id",
            (provider.model_id,),
        ).fetchall()
        if foreign:
            connection.close()
            names = ", ".join(str(row[0]) for row in foreign)
            raise VectorIndexError(
                f"vector index at {path} was built by {names}; delete it and rebuild for {provider.model_id}"
            )
        return cls(connection, provider)

    @property
    def model_id(self) -> str:
        return self._provider.model_id

    @property
    def dimensions(self) -> int:
        return self._provider.dimensions

    def close(self) -> None:
        self.connection.close()

    def index(self, documents: Sequence[IndexedDocument], *, now: str | None = None) -> int:
        """Embed and store documents, replacing any existing row per event."""
        if not documents:
            return 0
        indexed_at = now or utc_now_iso()
        vectors = self._provider.embed([document.text for document in documents])
        if len(vectors) != len(documents):
            raise VectorIndexError(f"provider returned {len(vectors)} vectors for {len(documents)} documents")

        rows = [
            (
                document.event_id,
                self._provider.model_id,
                self._provider.dimensions,
                self._encode(vector),
                indexed_at,
            )
            for document, vector in zip(documents, vectors, strict=True)
        ]
        self.connection.execute("BEGIN")
        try:
            self.connection.executemany(
                """
                INSERT INTO event_embedding (event_id, model_id, dimensions, embedding, indexed_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (event_id, model_id) DO UPDATE
                    SET embedding = excluded.embedding,
                        dimensions = excluded.dimensions,
                        indexed_at = excluded.indexed_at
                """,
                rows,
            )
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        self.connection.execute("COMMIT")
        return len(rows)

    def rebuild(self, documents: Sequence[IndexedDocument], *, now: str | None = None) -> int:
        """Discard this model's vectors and index the given documents again.

        Rebuild is the recovery path for every kind of drift -- a changed
        embedder, a partial index, a restored backup -- so it clears first
        instead of upserting: an event that has since left the corpus must not
        survive as a stale row that can still be returned.
        """
        self.connection.execute("DELETE FROM event_embedding WHERE model_id = ?", (self._provider.model_id,))
        return self.index(documents, now=now)

    def search(self, vector: Sequence[float], limit: int = DEFAULT_LIMIT) -> list[VectorMatch]:
        if limit < 1:
            raise ValueError("limit must be at least 1")
        if len(vector) != self._provider.dimensions:
            raise VectorEncodingError(f"query vector has width {len(vector)}, index holds {self._provider.dimensions}")
        rows = self.connection.execute(
            "SELECT event_id, embedding FROM event_embedding WHERE model_id = ?",
            (self._provider.model_id,),
        ).fetchall()
        # Decoded with the expected width, so a truncated blob raises here
        # rather than scoring against a shorter vector.
        decoded = [(str(row[0]), self._checked_blob(str(row[0]), row[1])) for row in rows]
        return cosine_search(vector, decoded, limit)

    def search_text(self, query: str, limit: int = DEFAULT_LIMIT) -> list[VectorMatch]:
        return self.search(self._provider.embed([query])[0], limit)

    def count(self) -> int:
        return int(
            self.connection.execute(
                "SELECT COUNT(*) FROM event_embedding WHERE model_id = ?",
                (self._provider.model_id,),
            ).fetchone()[0]
        )

    def _encode(self, vector: Sequence[float]) -> bytes:
        if len(vector) != self._provider.dimensions:
            raise VectorEncodingError(
                f"provider {self._provider.model_id} returned width {len(vector)}, declared {self._provider.dimensions}"
            )
        return encode_f32(vector)

    def _checked_blob(self, event_id: str, blob: object) -> bytes:
        # Width only: `cosine_search` decodes each blob once and rejects
        # non-finite components there, so unpacking here as well would double
        # the cost of every query to re-learn the same thing.
        if not isinstance(blob, bytes):
            raise VectorEncodingError(f"embedding for {event_id} is {type(blob).__name__}, not a blob")
        expected = self._provider.dimensions * FLOAT32_BYTES
        if len(blob) != expected:
            raise VectorEncodingError(f"embedding for {event_id} is {len(blob)} bytes, expected {expected}")
        return blob
