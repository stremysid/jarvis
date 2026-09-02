"""Replication must never leave a silent gap in the permanent record.

The dangerous failure is not losing a page -- that is recoverable by pulling
again. It is advancing the cursor past events that were never stored, because
the cursor is the only thing that says what has been seen. Nothing detects
that later; the events are simply gone.

These tests drive the crash and failure boundaries directly.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.sync.event_replicator import (
    EventPage,
    EventReplicator,
    SyncAckPending,
)

OCCURRED_AT = "2026-09-01T12:00:00.000Z"


class SimulatedCrash(RuntimeError):  # noqa: N818 - reads better than SimulatedCrashError
    """Stands in for the process dying mid-transaction."""


def event(sequence: int, text: str = "turn") -> dict[str, object]:
    return {
        "event_id": f"event_{sequence:026d}",
        "event_sequence": sequence,
        "event_type": "conversation.turn.v1",
        "principal_id": "principal-a",
        "session_id": "session-a",
        "canonical_text": f"{text} {sequence}",
        "occurred_at": OCCURRED_AT,
        "producer_version": "cloud-gateway@0.1.0",
    }


def page(first: int, last: int) -> EventPage:
    events = tuple(event(sequence) for sequence in range(first, last + 1))
    return EventPage(events=events, highest_sequence=last)


class FakeCloud:
    """Serves pre-baked pages and records what was asked of it."""

    def __init__(self, pages: list[EventPage], *, ack_mode: str = "accept") -> None:
        self.pages = pages
        self.ack_mode = ack_mode
        self.cursor = 0
        self.pull_calls = 0

    def pull(self, after_sequence: int) -> EventPage:
        self.pull_calls += 1
        if not self.pages:
            return EventPage(events=(), highest_sequence=after_sequence)
        return self.pages.pop(0)

    def acknowledge(self, through_sequence: int) -> None:
        if self.ack_mode == "fail":
            raise ConnectionError("cloud unreachable")
        self.cursor = through_sequence


@pytest.fixture
def archive(tmp_path: Path) -> Iterator[ArchiveRepository]:
    repository = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    yield repository
    repository.close()


def test_a_clean_cycle_stores_events_advances_the_cursor_and_acknowledges(archive: ArchiveRepository) -> None:
    cloud = FakeCloud([page(1, 2)])
    replicator = EventReplicator(cloud, archive)

    progress = replicator.sync_once()

    assert progress.events_written == 2
    assert progress.highest_contiguous_sequence == 2
    assert archive.count_events() == 2
    assert cloud.cursor == 2
    assert replicator.cursors.pending_ack() is None


def test_cursor_does_not_advance_when_the_process_crashes_before_commit(archive: ArchiveRepository) -> None:
    """The single most important property here.

    Events written, cursor advanced, ACK staged -- then the process dies before
    COMMIT. All three must vanish together, or the cursor would claim events
    that are not in the archive.
    """
    cloud = FakeCloud([page(1, 2)])

    def crash() -> None:
        raise SimulatedCrash("died before commit")

    replicator = EventReplicator(cloud, archive, crash_after_event_write=crash)

    with pytest.raises(SimulatedCrash):
        replicator.sync_once()

    assert archive.count_events() == 0
    assert replicator.cursor() == 0
    assert replicator.cursors.pending_ack() is None
    assert cloud.cursor == 0


def test_duplicate_page_is_idempotent_and_the_cursor_stays_contiguous(archive: ArchiveRepository) -> None:
    cloud = FakeCloud([page(1, 2), page(1, 2)])
    replicator = EventReplicator(cloud, archive)

    replicator.sync_once()
    progress = replicator.sync_once()

    assert progress.highest_contiguous_sequence == 2
    assert archive.count_events() == 2


def test_restart_drains_a_durable_pending_ack_before_pulling_another_page(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    cloud = FakeCloud([page(1, 2)], ack_mode="fail")

    first = ArchiveRepository.open(path)
    replicator = EventReplicator(cloud, first)
    with pytest.raises(SyncAckPending):
        replicator.sync_once()

    # Events are durable and the cursor moved; only the cloud does not know.
    assert first.count_events() == 2
    assert replicator.cursor() == 2
    pending = replicator.cursors.pending_ack()
    assert pending is not None and pending.through_sequence == 2
    first.close()

    cloud.ack_mode = "accept"
    second = ArchiveRepository.open(path)
    restarted = EventReplicator(cloud, second)
    restarted.sync_once()

    assert restarted.cursors.pending_ack() is None
    assert cloud.cursor == 2
    # The owed acknowledgement was the whole cycle: no second pull.
    assert cloud.pull_calls == 1
    second.close()


def test_an_empty_page_is_not_an_error_and_does_not_move_the_cursor(archive: ArchiveRepository) -> None:
    cloud = FakeCloud([])
    replicator = EventReplicator(cloud, archive)

    progress = replicator.sync_once()

    assert progress == type(progress)(0, 0)
    assert replicator.cursors.pending_ack() is None


def test_out_of_order_pages_do_not_rewind_the_cursor(archive: ArchiveRepository) -> None:
    """A replayed earlier page must not reopen events already acknowledged."""
    cloud = FakeCloud([page(1, 3), page(1, 2)])
    replicator = EventReplicator(cloud, archive)

    replicator.sync_once()
    replicator.sync_once()

    assert replicator.cursor() == 3


def test_events_are_applied_in_ascending_sequence_order(archive: ArchiveRepository) -> None:
    """The cursor means "everything at or below is durable", which only holds
    if the page was applied in order."""
    shuffled = EventPage(events=(event(3), event(1), event(2)), highest_sequence=3)
    replicator = EventReplicator(FakeCloud([shuffled]), archive)

    replicator.sync_once()

    assert [item.event_sequence for item in archive.events_after(0)] == [1, 2, 3]


def test_a_tampered_replay_is_refused_and_nothing_is_committed(archive: ArchiveRepository) -> None:
    """Same event id, different text: corruption, not a retry.

    The whole page must roll back -- accepting the untouched events while
    rejecting the altered one would leave the archive partially advanced.
    """
    cloud = FakeCloud([page(1, 2), EventPage(events=(event(1, text="tampered"),), highest_sequence=1)])
    replicator = EventReplicator(cloud, archive)
    replicator.sync_once()

    with pytest.raises(ValueError, match="conflicting"):
        replicator.sync_once()

    assert archive.count_events() == 2
    assert replicator.cursor() == 2


def test_a_failed_acknowledgement_keeps_the_events(archive: ArchiveRepository) -> None:
    """The ACK is about telling the cloud, not about local durability."""
    cloud = FakeCloud([page(1, 2)], ack_mode="fail")
    replicator = EventReplicator(cloud, archive)

    with pytest.raises(SyncAckPending):
        replicator.sync_once()

    assert archive.count_events() == 2
    assert replicator.cursor() == 2
