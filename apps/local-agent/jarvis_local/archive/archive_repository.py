"""The archive's entire public surface.

Deliberately insert-and-read only. There is no update, delete, or purge
method, and no private helper that performs one -- the database triggers
would refuse anyway, but the API should not suggest the operation exists.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jarvis_local.archive.content_store import (
    ContentObservation,
    canonical_content_hash,
    normalize_nfc,
)
from jarvis_local.archive.database import ArchiveDatabase
from jarvis_local.clock import utc_now_iso

_EVENT_FIELDS = (
    "event_id",
    "event_sequence",
    "event_type",
    "principal_id",
    "session_id",
    "canonical_text",
    "occurred_at",
    "producer_version",
)


@dataclass(frozen=True, slots=True)
class ArchivedEvent:
    event_id: str
    event_sequence: int
    event_type: str
    principal_id: str
    session_id: str
    canonical_text: str
    content_hash: str
    occurred_at: str
    ingested_at: str
    producer_version: str


class ArchiveRepository:
    """Append-only access to the permanent archive."""

    def __init__(self, database: ArchiveDatabase) -> None:
        self._database = database

    @classmethod
    def open(cls, path: Path, *, now: str | None = None) -> ArchiveRepository:
        return cls(ArchiveDatabase.open(Path(path), now=now or utc_now_iso()))

    @property
    def connection(self) -> sqlite3.Connection:
        return self._database.connection

    def close(self) -> None:
        self._database.close()

    # -- events -----------------------------------------------------------

    def insert_event_if_absent(self, event: Mapping[str, Any], *, now: str | None = None) -> bool:
        """Store an event. Returns False if this exact event is already held.

        Replication is at-least-once, so re-delivery is normal and must be a
        no-op. Re-delivery with *different* content under the same id is not a
        retry -- it is the one route by which history could be rewritten past
        the append-only triggers, so it is refused loudly.
        """
        missing = [name for name in _EVENT_FIELDS if name not in event]
        if missing:
            raise ValueError(f"event is missing required fields: {', '.join(missing)}")

        canonical_text = normalize_nfc(str(event["canonical_text"]))
        content_hash = canonical_content_hash(canonical_text)
        event_id = str(event["event_id"])

        existing = self.connection.execute(
            "SELECT content_hash, event_sequence FROM archive_event WHERE event_id = ?", (event_id,)
        ).fetchone()
        if existing is not None:
            if existing[0] != content_hash or existing[1] != int(event["event_sequence"]):
                raise ValueError(f"conflicting event already archived under {event_id}")
            return False

        self.connection.execute(
            """
            INSERT INTO archive_event (
                event_id, event_sequence, event_type, principal_id, session_id,
                canonical_text, content_hash, occurred_at, ingested_at, producer_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                int(event["event_sequence"]),
                str(event["event_type"]),
                str(event["principal_id"]),
                str(event["session_id"]),
                canonical_text,
                content_hash,
                str(event["occurred_at"]),
                now or utc_now_iso(),
                str(event["producer_version"]),
            ),
        )
        return True

    def events_after(self, sequence: int) -> Iterable[ArchivedEvent]:
        """Every event with a sequence strictly greater, in ascending order.

        Ascending and contiguous is what the replication cursor depends on:
        it may only advance its highest-contiguous mark after a durable write.
        """
        rows = self.connection.execute(
            """
            SELECT event_id, event_sequence, event_type, principal_id, session_id,
                   canonical_text, content_hash, occurred_at, ingested_at, producer_version
            FROM archive_event WHERE event_sequence > ? ORDER BY event_sequence ASC
            """,
            (int(sequence),),
        ).fetchall()
        return [ArchivedEvent(*row) for row in rows]

    def count_events(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM archive_event").fetchone()[0])

    # -- documents --------------------------------------------------------

    def store_document(self, content: str, observation: ContentObservation) -> str:
        """Record one sighting of a document, storing its text only once."""
        canonical_text = normalize_nfc(content)
        content_hash = canonical_content_hash(canonical_text)

        if self.connection.execute(
            "SELECT 1 FROM content_seen WHERE observation_id = ?", (observation.id,)
        ).fetchone():
            raise ValueError(f"observation {observation.id} is already recorded")

        self.connection.execute("BEGIN")
        try:
            # The blob may already exist from an earlier sighting; that is the
            # point of content addressing, so INSERT OR IGNORE rather than a
            # pre-check, which would race.
            self.connection.execute(
                "INSERT OR IGNORE INTO content_blob (content_hash, canonical_text, created_at) VALUES (?, ?, ?)",
                (content_hash, canonical_text, observation.seen_at),
            )
            self.connection.execute(
                """
                INSERT INTO content_seen (observation_id, content_hash, source_event_id, seen_at)
                VALUES (?, ?, ?, ?)
                """,
                (observation.id, content_hash, observation.source_event_id, observation.seen_at),
            )
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        self.connection.execute("COMMIT")
        return content_hash

    def count_content_blobs(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM content_blob").fetchone()[0])

    def count_content_seen(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM content_seen").fetchone()[0])
