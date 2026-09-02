"""Durable replication cursor and pending-acknowledgement state.

Both live in the archive database so they can commit in the same transaction
as the events they describe. Every method here takes the connection it should
use rather than opening its own, precisely so a caller cannot accidentally
split that transaction.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from jarvis_local.clock import utc_now_iso

LOCAL_AGENT = "local-agent"


@dataclass(frozen=True, slots=True)
class PendingSyncAck:
    consumer: str
    through_sequence: int
    staged_at: str


class CursorStore:
    """Reads and writes replication progress on an existing connection."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def cursor(self, consumer: str = LOCAL_AGENT) -> int:
        """The highest sequence known to be durably stored.

        Zero when nothing has been replicated: sequences start at 1, so zero
        is unambiguously "nothing yet" rather than a valid position.
        """
        row = self.connection.execute(
            "SELECT highest_contiguous_sequence FROM sync_cursor WHERE consumer = ?", (consumer,)
        ).fetchone()
        return int(row[0]) if row else 0

    def advance_and_stage_ack(
        self,
        through_sequence: int,
        *,
        consumer: str = LOCAL_AGENT,
        now: str | None = None,
    ) -> None:
        """Move the cursor and record that an acknowledgement is owed.

        Called inside the caller's transaction, alongside the event writes.
        The cursor never moves backwards: an out-of-order or replayed page
        must not rewind progress and cause events to be re-processed.
        """
        current = self.cursor(consumer)
        if through_sequence < current:
            return
        stamp = now or utc_now_iso()
        self.connection.execute(
            """
            INSERT INTO sync_cursor (consumer, highest_contiguous_sequence, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(consumer) DO UPDATE SET
                highest_contiguous_sequence = excluded.highest_contiguous_sequence,
                updated_at = excluded.updated_at
            """,
            (consumer, int(through_sequence), stamp),
        )
        self.connection.execute(
            """
            INSERT INTO pending_sync_ack (consumer, through_sequence, staged_at)
            VALUES (?, ?, ?)
            ON CONFLICT(consumer) DO UPDATE SET
                through_sequence = excluded.through_sequence,
                staged_at = excluded.staged_at
            """,
            (consumer, int(through_sequence), stamp),
        )

    def pending_ack(self, consumer: str = LOCAL_AGENT) -> PendingSyncAck | None:
        row = self.connection.execute(
            "SELECT consumer, through_sequence, staged_at FROM pending_sync_ack WHERE consumer = ?",
            (consumer,),
        ).fetchone()
        return PendingSyncAck(row[0], int(row[1]), row[2]) if row else None

    def clear_pending_ack(self, consumer: str = LOCAL_AGENT) -> None:
        """Called only after the cloud has accepted the acknowledgement."""
        self.connection.execute("DELETE FROM pending_sync_ack WHERE consumer = ?", (consumer,))
