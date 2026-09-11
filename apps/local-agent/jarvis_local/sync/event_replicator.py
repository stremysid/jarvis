"""Pull events from the cloud into the permanent local archive.

The ordering here is the whole design, and it is not arbitrary:

1. Drain any acknowledgement owed from a previous run, before pulling.
2. Pull one page.
3. Write the events, advance the cursor, and stage the acknowledgement --
   all in ONE transaction.
4. Only after that commits, tell the cloud.

Step 3 is why replication state lives in the archive database. Split across
two stores there is a window where events are durable but the cursor is not
(harmless: re-fetch) or the cursor is durable but the events are not (a
permanent, silent gap in the permanent record).

Step 1 exists because the cloud does not know the write committed until it is
acknowledged. Pulling again first would re-deliver the same page forever.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.sync.cursor_store import LOCAL_AGENT, CursorStore, PendingSyncAck, SyncAckIdentity


class SyncAckPending(RuntimeError):  # noqa: N818 - name fixed by the plan's interface
    """Events are durable locally but the cloud has not accepted the ACK.

    Raised rather than swallowed: the caller must not treat the sync as
    complete, and the next run has to drain the ACK before doing anything else.
    """


@dataclass(frozen=True, slots=True)
class EventPage:
    events: tuple[dict[str, Any], ...]
    highest_sequence: int
    acknowledgement: SyncAckIdentity | None = None


@dataclass(frozen=True, slots=True)
class SyncProgress:
    events_written: int
    highest_contiguous_sequence: int


class CloudClient(Protocol):
    """The cloud side of replication, as this module needs it."""

    def pull(self, after_sequence: int) -> EventPage: ...

    def acknowledge(self, acknowledgement: PendingSyncAck) -> None: ...


class EventReplicator:
    """Drives one replication cycle at a time."""

    def __init__(
        self,
        cloud: CloudClient,
        archive: ArchiveRepository,
        *,
        consumer: str = LOCAL_AGENT,
        crash_after_event_write: Callable[[], None] | None = None,
    ) -> None:
        self.cloud = cloud
        self.archive = archive
        self.consumer = consumer
        self.cursors = CursorStore(archive.connection)
        # Test seam for the crash-boundary case. Invoked after the events are
        # written but before COMMIT, which is the exact window that must leave
        # no trace.
        self._crash_after_event_write = crash_after_event_write

    def cursor(self, consumer: str | None = None) -> int:
        return self.cursors.cursor(consumer or self.consumer)

    def sync_once(self) -> SyncProgress:
        # A previously-owed acknowledgement is the entire cycle. Pulling in the
        # same pass would ask for a page the cloud still believes we never
        # stored, and it would keep re-sending it until the ACK lands.
        if self.cursors.pending_ack(self.consumer) is not None:
            self._drain_pending_ack()
            return SyncProgress(0, self.cursor())

        page = self.cloud.pull(self.cursor())
        if not page.events:
            return SyncProgress(0, self.cursor())

        written = self._commit_page(page)
        self._drain_pending_ack()
        return SyncProgress(written, self.cursor())

    # -- internals --------------------------------------------------------

    def _drain_pending_ack(self) -> None:
        # Function-local because cloud_client imports EventPage from this
        # module. By now both modules are fully loaded.
        from jarvis_local.sync.cloud_client import CloudAuthError

        pending = self.cursors.pending_ack(self.consumer)
        if pending is None:
            return
        try:
            self.cloud.acknowledge(pending)
        except CloudAuthError:
            # Keep the staged acknowledgement, but preserve the one failure
            # class the scheduler must stop retrying immediately.
            raise
        except Exception as error:
            raise SyncAckPending(
                f"acknowledgement through {pending.through_sequence} was not accepted"
            ) from error
        self.cursors.clear_pending_ack(self.consumer)

    def _commit_page(self, page: EventPage) -> int:
        connection = self.archive.connection
        connection.execute("BEGIN")
        try:
            written = self._write_events(page.events)
            self.cursors.advance_and_stage_ack(
                page.highest_sequence,
                consumer=self.consumer,
                acknowledgement=page.acknowledgement,
            )
            if self._crash_after_event_write is not None:
                # Everything above is inside the transaction, so whatever this
                # raises must leave the database exactly as it was.
                self._crash_after_event_write()
        except Exception:
            connection.execute("ROLLBACK")
            raise
        connection.execute("COMMIT")
        return written

    def _write_events(self, events: Sequence[dict[str, Any]]) -> int:
        written = 0
        # Ascending order matters: the cursor means "every sequence at or below
        # this is durable", which is only true if they were applied in order.
        for event in sorted(events, key=lambda item: int(item["event_sequence"])):
            # Re-delivery is normal; insert_event_if_absent makes it a no-op,
            # and refuses altered content under a known id.
            if self.archive.insert_event_if_absent(event):
                written += 1
        return written
