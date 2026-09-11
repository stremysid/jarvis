"""Replication must never leave a silent gap in the permanent record.

The dangerous failure is not losing a page -- that is recoverable by pulling
again. It is advancing the cursor past events that were never stored, because
the cursor is the only thing that says what has been seen. Nothing detects
that later; the events are simply gone.

These tests drive the crash and failure boundaries directly.
"""

from __future__ import annotations

import io
import json
import urllib.error
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.sync.cloud_client import CloudAuthError, HttpCloudClient
from jarvis_local.sync.cursor_store import CursorStore, PendingSyncAck
from jarvis_local.sync.event_replicator import (
    EventPage,
    EventReplicator,
    SyncAckPending,
)

OCCURRED_AT = "2026-09-01T12:00:00.000Z"
BASE = "https://gateway.example"
DEVICE = "device-1"
PRINCIPAL = "principal-a"
AUDIENCE = "jarvis-local-agent"


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

    def acknowledge(self, acknowledgement: PendingSyncAck) -> None:
        if self.ack_mode == "fail":
            raise ConnectionError("cloud unreachable")
        self.cursor = acknowledgement.through_sequence


class Response(io.BytesIO):
    def __enter__(self) -> Response:
        return self

    def __exit__(self, *_: object) -> None:
        return None


class QueuedOpener:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float | None = None) -> Response:
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return Response(json.dumps(response).encode("utf-8"))

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.data.decode("utf-8")) for request in self.requests]


def http_page(first: int, last: int, *, snapshot: str, has_more: bool = False) -> dict[str, Any]:
    return {
        "snapshotId": snapshot,
        "snapshotToken": f"token-{snapshot}",
        "fromSequence": first - 1,
        "toSequence": last,
        "events": [
            {
                "eventSequence": sequence,
                "envelope": {
                    "eventId": f"event_{sequence:026d}",
                    "eventType": "conversation.user_committed",
                    "subjectId": PRINCIPAL,
                    "correlationId": "session-a",
                    "occurredAt": OCCURRED_AT,
                    "producerVersion": "conversation-v1",
                    "payload": {"text": f"turn {sequence}"},
                },
            }
            for sequence in range(first, last + 1)
        ],
        "hasMore": has_more,
    }


def http_client(opener: QueuedOpener) -> HttpCloudClient:
    return HttpCloudClient(
        base_url=BASE,
        device_id=DEVICE,
        principal_id=PRINCIPAL,
        audience=AUDIENCE,
        key=Ed25519PrivateKey.from_private_bytes(bytes(range(32))),
        opener=opener,
    )


def stage_real_pending(path: Path, *, snapshot: str = "expired-snapshot") -> PendingSyncAck:
    opener = QueuedOpener(
        [
            http_page(1, 2, snapshot=snapshot),
            urllib.error.URLError("response lost after local commit"),
        ]
    )
    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(http_client(opener), repository)
        with pytest.raises(SyncAckPending):
            replicator.sync_once()
        pending = replicator.cursors.pending_ack()
        assert pending is not None
        return pending
    finally:
        repository.close()


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


def test_a_terminal_snapshot_is_not_reused_in_the_next_cycle(archive: ArchiveRepository) -> None:
    opener = QueuedOpener(
        [
            http_page(1, 1, snapshot="snapshot-one"),
            {"schemaVersion": "1.0", "currentSequence": 1, "replayed": False},
            http_page(2, 2, snapshot="snapshot-two"),
            {"schemaVersion": "1.0", "currentSequence": 2, "replayed": False},
        ]
    )
    replicator = EventReplicator(http_client(opener), archive)

    replicator.sync_once()
    replicator.sync_once()

    assert opener.bodies[0]["snapshotToken"] is None
    assert opener.bodies[2]["snapshotToken"] is None
    assert archive.count_events() == 2
    assert replicator.cursor() == 2


def test_an_acked_nonterminal_snapshot_starts_fresh_on_the_next_cycle(archive: ArchiveRepository) -> None:
    opener = QueuedOpener(
        [
            http_page(1, 1, snapshot="snapshot-one", has_more=True),
            {"schemaVersion": "1.0", "currentSequence": 1, "replayed": False},
            http_page(2, 2, snapshot="snapshot-two"),
            {"schemaVersion": "1.0", "currentSequence": 2, "replayed": False},
        ]
    )
    replicator = EventReplicator(http_client(opener), archive)

    replicator.sync_once()
    replicator.sync_once()

    assert opener.bodies[2]["afterSequence"] == 1
    assert opener.bodies[2]["snapshotToken"] is None
    assert archive.count_events() == 2
    assert replicator.cursor() == 2


def test_an_empty_terminal_snapshot_is_not_reused_in_the_next_cycle(archive: ArchiveRepository) -> None:
    opener = QueuedOpener(
        [
            http_page(1, 0, snapshot="empty-one"),
            http_page(1, 0, snapshot="empty-two"),
        ]
    )
    replicator = EventReplicator(http_client(opener), archive)

    replicator.sync_once()
    replicator.sync_once()

    assert opener.bodies[0]["snapshotToken"] is None
    assert opener.bodies[1]["snapshotToken"] is None


def test_a_recreated_signed_client_drains_the_exact_durable_ack_before_pulling(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    first_opener = QueuedOpener(
        [
            http_page(1, 2, snapshot="durable-snapshot"),
            urllib.error.URLError("offline after commit"),
        ]
    )
    first_archive = ArchiveRepository.open(path)
    with pytest.raises(SyncAckPending):
        first_replicator = EventReplicator(http_client(first_opener), first_archive)
        first_replicator.sync_once()
    before_restart = first_replicator.cursors.pending_ack()
    assert before_restart is not None
    assert before_restart.snapshot_id == "durable-snapshot"
    assert before_restart.expected_current == 0
    assert before_restart.gateway_origin == BASE
    assert before_restart.device_id == DEVICE
    assert before_restart.principal_id == PRINCIPAL
    first_archive.close()

    second_opener = QueuedOpener(
        [{"schemaVersion": "1.0", "currentSequence": 2, "replayed": False}]
    )
    second_archive = ArchiveRepository.open(path)
    try:
        restarted = EventReplicator(http_client(second_opener), second_archive)
        assert restarted.cursors.pending_ack() == before_restart
        restarted.sync_once()
        pending = restarted.cursors.pending_ack()
    finally:
        second_archive.close()

    assert pending is None
    assert len(second_opener.requests) == 1
    assert second_opener.requests[0].full_url == f"{BASE}/sync/ack"
    assert second_opener.bodies[0] == {
        "schemaVersion": "1.0",
        "snapshotId": "durable-snapshot",
        "expectedCurrent": 0,
        "throughSequence": 2,
    }
    signed = json.loads(second_opener.requests[0].headers["X-jarvis-signed-request"])
    assert signed["deviceId"] == DEVICE
    assert signed["principalId"] == PRINCIPAL


def test_a_same_process_retry_after_local_rollback_starts_a_fresh_snapshot(
    archive: ArchiveRepository,
) -> None:
    opener = QueuedOpener(
        [
            http_page(1, 1, snapshot="rolled-back", has_more=True),
            http_page(1, 1, snapshot="fresh-root"),
            {"schemaVersion": "1.0", "currentSequence": 1, "replayed": False},
        ]
    )

    def crash() -> None:
        raise SimulatedCrash("local transaction rolled back")

    cloud = http_client(opener)
    with pytest.raises(SimulatedCrash):
        EventReplicator(cloud, archive, crash_after_event_write=crash).sync_once()
    EventReplicator(cloud, archive).sync_once()

    assert opener.bodies[1]["afterSequence"] == 0
    assert opener.bodies[1]["snapshotToken"] is None
    assert archive.count_events() == 1
    assert CursorStore(archive.connection).pending_ack() is None


def test_an_invalid_ack_receipt_keeps_the_durable_ack(archive: ArchiveRepository) -> None:
    opener = QueuedOpener(
        [
            http_page(1, 1, snapshot="receipt-snapshot"),
            {"schemaVersion": "1.0", "currentSequence": 1, "replayed": 0},
        ]
    )
    replicator = EventReplicator(http_client(opener), archive)

    with pytest.raises(SyncAckPending):
        replicator.sync_once()

    pending = replicator.cursors.pending_ack()
    assert pending is not None
    assert pending.snapshot_id == "receipt-snapshot"


def test_an_expired_ack_rebinds_only_after_the_exact_archived_page_is_refetched(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    original = stage_real_pending(path)
    opener = QueuedOpener(
        [
            urllib.error.HTTPError(BASE, 400, "expired", {}, None),  # type: ignore[arg-type]
            http_page(1, 2, snapshot="replacement-snapshot"),
            {"schemaVersion": "1.0", "currentSequence": 2, "replayed": False},
        ]
    )
    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(http_client(opener), repository)
        before_count = repository.count_events()
        before_cursor = replicator.cursor()
        replicator.sync_once()
        pending = replicator.cursors.pending_ack()
        after_count = repository.count_events()
        after_cursor = replicator.cursor()
    finally:
        repository.close()

    assert original.snapshot_id == "expired-snapshot"
    assert pending is None
    assert [request.full_url for request in opener.requests] == [
        f"{BASE}/sync/ack",
        f"{BASE}/sync/pull",
        f"{BASE}/sync/ack",
    ]
    assert opener.bodies[1]["afterSequence"] == 0
    assert opener.bodies[1]["pageSize"] == 2
    assert opener.bodies[1]["snapshotToken"] is None
    assert opener.bodies[2]["snapshotId"] == "replacement-snapshot"
    assert before_count == 2
    assert before_cursor == 2
    assert after_count == before_count
    assert after_cursor == before_cursor


def test_expiry_recovery_refuses_a_tampered_field_under_the_same_event_id(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    original = stage_real_pending(path)
    changed = http_page(1, 2, snapshot="replacement-snapshot")
    changed["events"][0]["envelope"]["producerVersion"] = "tampered-v2"
    opener = QueuedOpener(
        [
            urllib.error.HTTPError(BASE, 400, "expired", {}, None),  # type: ignore[arg-type]
            changed,
            {"schemaVersion": "1.0", "currentSequence": 2, "replayed": False},
        ]
    )
    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(http_client(opener), repository)
        with pytest.raises(SyncAckPending):
            replicator.sync_once()
        pending = replicator.cursors.pending_ack()
        count = repository.count_events()
        cursor = replicator.cursor()
    finally:
        repository.close()

    assert pending == original
    assert count == 2
    assert cursor == 2
    assert len(opener.requests) == 2


def test_expiry_recovery_refuses_a_changed_page_boundary(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    original = stage_real_pending(path)
    opener = QueuedOpener(
        [
            urllib.error.HTTPError(BASE, 400, "expired", {}, None),  # type: ignore[arg-type]
            http_page(1, 1, snapshot="replacement-snapshot", has_more=True),
            {"schemaVersion": "1.0", "currentSequence": 2, "replayed": False},
        ]
    )
    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(http_client(opener), repository)
        with pytest.raises(SyncAckPending):
            replicator.sync_once()
        pending = replicator.cursors.pending_ack()
    finally:
        repository.close()
    assert pending == original


def test_a_lost_successful_ack_response_replays_without_a_recovery_pull(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    stage_real_pending(path)
    opener = QueuedOpener(
        [{"schemaVersion": "1.0", "currentSequence": 2, "replayed": True}]
    )
    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(http_client(opener), repository)
        replicator.sync_once()
        pending = replicator.cursors.pending_ack()
    finally:
        repository.close()

    assert pending is None
    assert len(opener.requests) == 1
    assert opener.requests[0].full_url == f"{BASE}/sync/ack"


def test_authentication_failure_does_not_attempt_expiry_recovery(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    original = stage_real_pending(path)
    opener = QueuedOpener(
        [urllib.error.HTTPError(BASE, 403, "revoked", {}, None)]  # type: ignore[arg-type]
    )
    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(http_client(opener), repository)
        with pytest.raises(CloudAuthError, match="HTTP 403"):
            replicator.sync_once()
        pending = replicator.cursors.pending_ack()
    finally:
        repository.close()
    assert pending == original
    assert len(opener.requests) == 1


def test_owner_mismatch_does_not_send_or_rebind_the_pending_ack(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    original = stage_real_pending(path)
    opener = QueuedOpener([])
    other = HttpCloudClient(
        base_url=BASE,
        device_id="device-other",
        principal_id=PRINCIPAL,
        audience=AUDIENCE,
        key=Ed25519PrivateKey.from_private_bytes(bytes(range(32))),
        opener=opener,
    )
    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(other, repository)
        with pytest.raises(SyncAckPending):
            replicator.sync_once()
        pending = replicator.cursors.pending_ack()
    finally:
        repository.close()
    assert pending == original
    assert opener.requests == []


def test_a_crash_during_ack_rebind_rolls_back_to_the_original_pending_identity(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    original = stage_real_pending(path)
    opener = QueuedOpener(
        [
            urllib.error.HTTPError(BASE, 400, "expired", {}, None),  # type: ignore[arg-type]
            http_page(1, 2, snapshot="replacement-snapshot"),
        ]
    )

    def crash() -> None:
        raise SimulatedCrash("before ack rebind commit")

    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(http_client(opener), repository, crash_after_ack_rebind=crash)
        with pytest.raises(SyncAckPending):
            replicator.sync_once()
        pending = replicator.cursors.pending_ack()
    finally:
        repository.close()
    assert pending == original
    assert len(opener.requests) == 2


def test_stop_after_rebind_leaves_the_replacement_ack_durable_for_restart(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    stage_real_pending(path)
    opener = QueuedOpener(
        [
            urllib.error.HTTPError(BASE, 400, "expired", {}, None),  # type: ignore[arg-type]
            http_page(1, 2, snapshot="replacement-snapshot"),
        ]
    )
    checks = 0

    def stop_before_second_ack() -> bool:
        nonlocal checks
        checks += 1
        return checks > 1

    repository = ArchiveRepository.open(path)
    try:
        replicator = EventReplicator(http_client(opener), repository, should_stop=stop_before_second_ack)
        with pytest.raises(SyncAckPending, match="not accepted"):
            replicator.sync_once()
        pending = replicator.cursors.pending_ack()
    finally:
        repository.close()

    assert pending is not None
    assert pending.snapshot_id == "replacement-snapshot"
    assert len(opener.requests) == 2
