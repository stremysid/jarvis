"""One failing stage must not discard the work of the stages before it.

The three stages are separate commitments. Wrapping them together would mean
losing replicated events because a model call failed, which trades durable
work for a tidier abstraction.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from jarvis_local.agent import CycleResult, run_cycle
from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.memory.distillation import DistillationCoordinator
from jarvis_local.memory.facts import FactOrigin, FactProposal, FactRepository
from jarvis_local.sync.cloud_client import CloudAuthError, CloudSyncError
from jarvis_local.sync.cursor_store import PendingSyncAck
from jarvis_local.sync.event_replicator import EventPage, EventReplicator, SyncAckPending
from jarvis_local.sync.memory_projection import ProjectionResult

PRINCIPAL = "principal-a"


def event(sequence: int, text: str = "I like coffee") -> dict[str, object]:
    return {
        "event_id": f"{sequence:026x}",
        "event_sequence": sequence,
        "event_type": "conversation.user_committed",
        "principal_id": PRINCIPAL,
        "session_id": "session-a",
        "canonical_text": text,
        "occurred_at": "2026-09-02T12:00:00.000Z",
        "producer_version": "conversation-v1",
    }


class FakeCloud:
    def __init__(
        self,
        pages: list[EventPage],
        error: Exception | None = None,
        ack_error: Exception | None = None,
    ) -> None:
        self.pages = pages
        self.error = error
        self.ack_error = ack_error

    def pull(self, after_sequence: int) -> EventPage:
        if self.error is not None:
            raise self.error
        if not self.pages:
            return EventPage(events=(), highest_sequence=after_sequence)
        return self.pages.pop(0)

    def acknowledge(self, acknowledgement: PendingSyncAck) -> None:
        if self.ack_error is not None:
            raise self.ack_error
        return None


class FakeDistiller:
    def __init__(self, proposals: list[dict[str, object]] | None = None, error: Exception | None = None) -> None:
        self.proposals = proposals or []
        self.error = error

    def distill(self, excerpts: object) -> list[dict[str, object]]:
        if self.error is not None:
            raise self.error
        return self.proposals


class FakeProjector:
    def __init__(
        self,
        facts: FactRepository,
        *,
        pending: bool = False,
        resume_error: Exception | None = None,
        project_error: Exception | None = None,
        resume_result: ProjectionResult | None = None,
        project_result: ProjectionResult | None = None,
    ) -> None:
        self.facts = facts
        self.pending = pending
        self.resume_error = resume_error
        self.project_error = project_error
        self.resume_result = resume_result
        self.project_result = project_result
        self.resume_calls = 0
        self.project_calls = 0
        self.active_when_projected = -1

    def resume_pending(self) -> ProjectionResult | None:
        self.resume_calls += 1
        if self.resume_error is not None:
            raise self.resume_error
        if self.resume_result is not None:
            return self.resume_result
        return ProjectionResult(True, 0) if self.pending else None

    def project(self) -> ProjectionResult:
        self.project_calls += 1
        self.active_when_projected = len(self.facts.active_facts(PRINCIPAL))
        if self.project_error is not None:
            raise self.project_error
        return self.project_result or ProjectionResult(True, self.active_when_projected)


@pytest.fixture
def stores(tmp_path: Path) -> Iterator[tuple[ArchiveRepository, FactRepository]]:
    archive = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    facts = FactRepository.open(tmp_path / "memory.sqlite3")
    yield archive, facts
    archive.close()
    facts.close()


def build(
    archive: ArchiveRepository, facts: FactRepository, cloud: FakeCloud, distiller: FakeDistiller
) -> tuple[EventReplicator, DistillationCoordinator]:
    return (
        EventReplicator(cloud, archive),
        DistillationCoordinator(archive, facts, distiller, principal_id=PRINCIPAL),
    )


def test_a_clean_cycle_replicates_distils_and_leaves_proposals_unpromoted(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    page = EventPage(events=(event(1),), highest_sequence=1)
    replicator, distiller = build(
        archive,
        facts,
        FakeCloud([page]),
        FakeDistiller([{"text": "Likes coffee", "sourceEventIds": [f"{1:026x}"]}]),
    )

    result = run_cycle(replicator, distiller, facts, PRINCIPAL)

    assert result.events_replicated == 1
    assert result.excerpts_distilled == 1
    assert result.proposals_recorded == 1
    # A model inference stays proposed. That boundary is the whole design.
    assert result.facts_promoted == 0
    assert result.failure is None


def test_a_failed_distillation_keeps_the_replicated_events(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    page = EventPage(events=(event(1),), highest_sequence=1)
    replicator, distiller = build(
        archive, facts, FakeCloud([page]), FakeDistiller(error=RuntimeError("model down"))
    )

    result = run_cycle(replicator, distiller, facts, PRINCIPAL)

    assert result.events_replicated == 1
    assert result.failure is not None and "distillation" in result.failure
    # The events are durable; only the derived work is undone.
    assert archive.count_events() == 1


def test_an_authentication_failure_during_distillation_stops_retrying(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    page = EventPage(events=(event(1),), highest_sequence=1)
    replicator, distiller = build(
        archive,
        facts,
        FakeCloud([page]),
        FakeDistiller(error=CloudAuthError("device rejected")),
    )

    result = run_cycle(replicator, distiller, facts, PRINCIPAL)

    assert result.events_replicated == 1
    assert result.failure is not None and result.failure.startswith("authentication:")
    assert archive.count_events() == 1


def test_an_authentication_failure_is_reported_distinctly(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    """Not retryable: the key, the registration or the clock is wrong, and
    backing off would repeat it forever."""
    archive, facts = stores
    replicator, distiller = build(
        archive, facts, FakeCloud([], CloudAuthError("device rejected")), FakeDistiller()
    )

    result = run_cycle(replicator, distiller, facts, PRINCIPAL)
    assert result.failure is not None and result.failure.startswith("authentication")


def test_an_authentication_failure_during_ack_stays_staged_and_stops_retrying(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    cloud = FakeCloud(
        [EventPage(events=(event(1),), highest_sequence=1)],
        ack_error=CloudAuthError("device rejected"),
    )
    replicator, distiller = build(archive, facts, cloud, FakeDistiller())

    result = run_cycle(replicator, distiller, facts, PRINCIPAL)

    assert result.events_replicated == 0
    assert result.failure is not None and result.failure.startswith("authentication")
    assert archive.count_events() == 1
    pending = replicator.cursors.pending_ack()
    assert pending is not None and pending.through_sequence == 1


def test_a_transient_sync_failure_is_reported_as_sync(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(
        archive, facts, FakeCloud([], CloudSyncError("gateway unreachable")), FakeDistiller()
    )

    result = run_cycle(replicator, distiller, facts, PRINCIPAL)
    assert result.failure is not None and result.failure.startswith("sync")


def test_an_owed_acknowledgement_does_not_look_like_an_auth_failure(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(
        archive, facts, FakeCloud([], SyncAckPending("ack owed")), FakeDistiller()
    )

    result = run_cycle(replicator, distiller, facts, PRINCIPAL)
    assert result.failure is not None and result.failure.startswith("sync")


def test_an_empty_cycle_is_not_a_failure(stores: tuple[ArchiveRepository, FactRepository]) -> None:
    archive, facts = stores
    replicator, distiller = build(archive, facts, FakeCloud([]), FakeDistiller())

    assert run_cycle(replicator, distiller, facts, PRINCIPAL) == CycleResult(0, 0, 0, 0, None)


def test_replication_runs_before_distillation(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    """Otherwise the first cycle distils a stale view and the new events wait
    a whole cycle to be considered."""
    archive, facts = stores
    page = EventPage(events=(event(1), event(2, "I work Tuesdays")), highest_sequence=2)
    replicator, distiller = build(archive, facts, FakeCloud([page]), FakeDistiller())

    result = run_cycle(replicator, distiller, facts, PRINCIPAL)

    # Both freshly replicated events were visible to distillation in the same
    # cycle that fetched them.
    assert (result.events_replicated, result.excerpts_distilled) == (2, 2)


def test_projection_runs_after_an_eligible_fact_is_promoted(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    facts.record_proposal(
        FactProposal(
            principal_id=PRINCIPAL,
            text="Likes coffee",
            origin=FactOrigin.AUTHENTICATED_FIRST_PERSON,
            source_event_ids=(f"{1:026x}",),
        )
    )
    replicator, distiller = build(archive, facts, FakeCloud([]), FakeDistiller())
    projector = FakeProjector(facts)

    result = run_cycle(replicator, distiller, facts, PRINCIPAL, projector=projector)

    assert result.facts_promoted == 1
    assert projector.active_when_projected == 1


def test_an_owed_projection_is_retried_before_fresh_distillation(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(
        archive,
        facts,
        FakeCloud([EventPage(events=(event(1),), highest_sequence=1)]),
        FakeDistiller(error=RuntimeError("model unavailable")),
    )
    projector = FakeProjector(facts, pending=True)

    result = run_cycle(replicator, distiller, facts, PRINCIPAL, projector=projector)

    assert projector.resume_calls == 1
    assert projector.project_calls == 0
    assert result.failure is not None and result.failure.startswith("distillation:")


def test_stop_from_resumed_projection_preserves_its_quarantine_count(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(archive, facts, FakeCloud([]), FakeDistiller())
    projector = FakeProjector(
        facts,
        resume_result=ProjectionResult(False, 0, stopped=True, quarantined=3),
    )

    result = run_cycle(replicator, distiller, facts, PRINCIPAL, projector=projector)

    assert result.failure is None
    assert result.facts_quarantined == 3
    assert projector.project_calls == 0


def test_stop_after_resume_preserves_quarantine_and_skips_distillation(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(archive, facts, FakeCloud([]), FakeDistiller(error=AssertionError("called")))
    projector = FakeProjector(facts, resume_result=ProjectionResult(False, 0, quarantined=3))
    stop_answers = iter((False, True))

    result = run_cycle(
        replicator, distiller, facts, PRINCIPAL, projector=projector,
        should_stop=lambda: next(stop_answers),
    )

    assert result.failure is None
    assert result.facts_quarantined == 3
    assert projector.project_calls == 0


def test_distillation_failure_preserves_quarantine_from_recovery(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(
        archive,
        facts,
        FakeCloud([EventPage(events=(event(1),), highest_sequence=1)]),
        FakeDistiller(error=RuntimeError("model unavailable")),
    )
    projector = FakeProjector(facts, resume_result=ProjectionResult(False, 0, quarantined=3))

    result = run_cycle(replicator, distiller, facts, PRINCIPAL, projector=projector)

    assert result.failure is not None and result.failure.startswith("distillation:")
    assert result.facts_quarantined == 3
    assert result.events_replicated == 1


def test_stop_before_fresh_projection_preserves_recovery_quarantine(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(archive, facts, FakeCloud([]), FakeDistiller())
    projector = FakeProjector(facts, resume_result=ProjectionResult(False, 0, quarantined=3))
    stop_answers = iter((False, False, True))

    result = run_cycle(
        replicator, distiller, facts, PRINCIPAL, projector=projector,
        should_stop=lambda: next(stop_answers),
    )

    assert result.failure is None
    assert result.facts_quarantined == 3
    assert projector.project_calls == 0


def test_fresh_projection_does_not_erase_recovery_quarantine(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(archive, facts, FakeCloud([]), FakeDistiller())
    projector = FakeProjector(
        facts,
        resume_result=ProjectionResult(False, 0, quarantined=3),
        project_result=ProjectionResult(True, 0, quarantined=0),
    )

    result = run_cycle(replicator, distiller, facts, PRINCIPAL, projector=projector)

    assert result.failure is None
    assert result.facts_quarantined == 3


def test_projection_authentication_failure_preserves_earlier_cycle_counts(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(
        archive,
        facts,
        FakeCloud([EventPage(events=(event(1),), highest_sequence=1)]),
        FakeDistiller(),
    )
    projector = FakeProjector(facts, project_error=CloudAuthError("device revoked"))

    result = run_cycle(replicator, distiller, facts, PRINCIPAL, projector=projector)

    assert result.events_replicated == 1
    assert result.excerpts_distilled == 1
    assert result.failure is not None and result.failure.startswith("authentication:")


def test_promotion_failure_preserves_completed_replication_and_distillation(
    stores: tuple[ArchiveRepository, FactRepository], monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive, facts = stores
    replicator, distiller = build(
        archive,
        facts,
        FakeCloud([EventPage(events=(event(1),), highest_sequence=1)]),
        FakeDistiller(),
    )

    def fail_promotion(_facts: FactRepository, _principal_id: str) -> list[object]:
        raise RuntimeError("promotion failed")

    monkeypatch.setattr("jarvis_local.agent.promote_new_facts", fail_promotion)
    result = run_cycle(replicator, distiller, facts, PRINCIPAL)

    assert result.events_replicated == 1
    assert result.excerpts_distilled == 1
    assert result.failure == "promotion: promotion failed"


def test_promotion_authentication_failure_stops_instead_of_backing_off(
    stores: tuple[ArchiveRepository, FactRepository], monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive, facts = stores
    replicator, distiller = build(
        archive,
        facts,
        FakeCloud([EventPage(events=(event(1),), highest_sequence=1)]),
        FakeDistiller(),
    )

    def reject_promotion(_facts: FactRepository, _principal_id: str) -> list[object]:
        raise CloudAuthError("device rejected")

    monkeypatch.setattr("jarvis_local.agent.promote_new_facts", reject_promotion)
    result = run_cycle(replicator, distiller, facts, PRINCIPAL)

    assert result.events_replicated == 1
    assert result.excerpts_distilled == 1
    assert result.failure == "authentication: device rejected"


def test_unexpected_projection_failure_preserves_completed_stage_counts(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(
        archive,
        facts,
        FakeCloud([EventPage(events=(event(1),), highest_sequence=1)]),
        FakeDistiller(),
    )
    projector = FakeProjector(facts, project_error=RuntimeError("projection failed"))

    result = run_cycle(replicator, distiller, facts, PRINCIPAL, projector=projector)

    assert result.events_replicated == 1
    assert result.excerpts_distilled == 1
    assert result.failure == "projection: projection failed"


def test_stop_after_sync_prevents_another_cloud_stage(
    stores: tuple[ArchiveRepository, FactRepository],
) -> None:
    archive, facts = stores
    replicator, distiller = build(archive, facts, FakeCloud([]), FakeDistiller())
    projector = FakeProjector(facts, pending=True)

    result = run_cycle(
        replicator,
        distiller,
        facts,
        PRINCIPAL,
        projector=projector,
        should_stop=lambda: True,
    )

    assert result == CycleResult(0, 0, 0, 0)
    assert projector.resume_calls == projector.project_calls == 0
