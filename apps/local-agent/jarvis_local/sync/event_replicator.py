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
from typing import Any, Protocol, runtime_checkable

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.archive.content_store import canonical_content_hash
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


@runtime_checkable
class RecoverableAckClient(Protocol):
    def recover_ack_page(self, acknowledgement: PendingSyncAck) -> EventPage: ...


class EventReplicator:
    """Drives one replication cycle at a time."""

    def __init__(
        self,
        cloud: CloudClient,
        archive: ArchiveRepository,
        *,
        consumer: str = LOCAL_AGENT,
        crash_after_event_write: Callable[[], None] | None = None,
        crash_after_ack_rebind: Callable[[], None] | None = None,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> None:
        self.cloud = cloud
        self.archive = archive
        self.consumer = consumer
        self.cursors = CursorStore(archive.connection)
        # Test seam for the crash-boundary case. Invoked after the events are
        # written but before COMMIT, which is the exact window that must leave
        # no trace.
        self._crash_after_event_write = crash_after_event_write
        self._crash_after_ack_rebind = crash_after_ack_rebind
        self._should_stop = should_stop

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
        from jarvis_local.sync.cloud_client import CloudAckRejectedError, CloudAuthError

        pending = self.cursors.pending_ack(self.consumer)
        if pending is None:
            return
        try:
            self.cloud.acknowledge(pending)
        except CloudAuthError:
            # Keep the staged acknowledgement, but preserve the one failure
            # class the scheduler must stop retrying immediately.
            raise
        except CloudAckRejectedError:
            try:
                self._recover_rejected_ack(pending)
            except CloudAuthError:
                raise
            except Exception as error:
                raise SyncAckPending(
                    f"acknowledgement through {pending.through_sequence} was not accepted"
                ) from error
        except Exception as error:
            raise SyncAckPending(
                f"acknowledgement through {pending.through_sequence} was not accepted"
            ) from error
        self.cursors.clear_pending_ack(self.consumer)

    def _recover_rejected_ack(self, pending: PendingSyncAck) -> None:
        if self._should_stop():
            raise SyncAckPending("stop requested before acknowledgement recovery")
        if not isinstance(self.cloud, RecoverableAckClient):
            raise SyncAckPending("the cloud client cannot recover a rejected acknowledgement")
        page = self.cloud.recover_ack_page(pending)
        self._validate_recovery_page(page, pending)
        identity = page.acknowledgement
        if identity is None:
            raise SyncAckPending("the recovery page has no acknowledgement identity")

        connection = self.archive.connection
        connection.execute("BEGIN")
        try:
            replacement = self.cursors.replace_pending_ack_identity(pending, identity)
            if self._crash_after_ack_rebind is not None:
                self._crash_after_ack_rebind()
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        connection.execute("COMMIT")
        if self._should_stop():
            raise SyncAckPending("stop requested before recovered acknowledgement")
        self.cloud.acknowledge(replacement)

    def _validate_recovery_page(self, page: EventPage, pending: PendingSyncAck) -> None:
        if (
            pending.expected_current is None
            or page.highest_sequence != pending.through_sequence
            or len(page.events) != pending.through_sequence - pending.expected_current
            or page.acknowledgement is None
            or page.acknowledgement.expected_current != pending.expected_current
            or page.acknowledgement.gateway_origin != pending.gateway_origin
            or page.acknowledgement.device_id != pending.device_id
            or page.acknowledgement.principal_id != pending.principal_id
        ):
            raise SyncAckPending("the recovery page does not match the pending acknowledgement")
        for offset, event in enumerate(page.events, start=1):
            sequence = pending.expected_current + offset
            row = self.archive.connection.execute(
                """
                SELECT event_id, event_sequence, event_type, principal_id, session_id,
                       canonical_text, content_hash, occurred_at, producer_version
                FROM archive_event WHERE event_sequence = ?
                """,
                (sequence,),
            ).fetchone()
            try:
                expected = (
                    str(event["event_id"]),
                    int(event["event_sequence"]),
                    str(event["event_type"]),
                    str(event["principal_id"]),
                    str(event["session_id"]),
                    str(event["canonical_text"]),
                    canonical_content_hash(str(event["canonical_text"])),
                    str(event["occurred_at"]),
                    str(event["producer_version"]),
                )
            except (KeyError, TypeError, ValueError) as error:
                raise SyncAckPending("the recovery page contains an invalid event") from error
            if row is None or tuple(row) != expected or expected[1] != sequence:
                raise SyncAckPending("the recovery page differs from the durable archive")

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
