"""The agent loop: replicate, resume owed projection, distil, promote, project.

Order matters and is not interchangeable. Distillation reads the archive, so
replication runs first or it distils a stale view. An owed immutable projection
is retried before new model work. Promotion then decides what a proposal is
entitled to become before the complete active snapshot is projected.

Each cycle is independently recoverable. A failure in one stage leaves the
earlier stages' work durable and the later ones simply undone, so the next
cycle resumes rather than restarts. That is why nothing here wraps the stages
in a single transaction: they are separate commitments, and pretending
otherwise would mean losing replication work because distillation failed.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.memory.distillation import DistillationCoordinator, promote_new_facts
from jarvis_local.memory.facts import FactRepository
from jarvis_local.sync.cloud_client import CloudAuthError, CloudSyncError
from jarvis_local.sync.event_replicator import EventReplicator, SyncAckPending
from jarvis_local.sync.memory_projection import ProjectionRecoveryError


class ProjectionAttempt(Protocol):
    @property
    def stopped(self) -> bool: ...

    @property
    def quarantined(self) -> int: ...


class FactProjector(Protocol):
    def resume_pending(self) -> ProjectionAttempt | None: ...

    def project(self) -> ProjectionAttempt: ...


@dataclass(frozen=True, slots=True)
class CycleResult:
    events_replicated: int
    excerpts_distilled: int
    proposals_recorded: int
    facts_promoted: int
    #: Set when a stage failed. The cycle is still reported rather than raised,
    #: so a scheduler can decide whether to back off without parsing an
    #: exception.
    failure: str | None = None
    facts_quarantined: int = 0


def run_cycle(
    replicator: EventReplicator,
    distiller: DistillationCoordinator,
    facts: FactRepository,
    principal_id: str,
    *,
    projector: FactProjector | None = None,
    should_stop: Callable[[], bool] = lambda: False,
) -> CycleResult:
    replicated = 0
    try:
        replicated = replicator.sync_once().events_written
    except CloudAuthError as error:
        # Not retryable: the key, the device registration or the clock is
        # wrong. Backing off would just repeat it forever.
        return CycleResult(0, 0, 0, 0, failure=f"authentication: {error}")
    except (CloudSyncError, SyncAckPending) as error:
        # The events are durable either way; only the cloud's view is behind.
        return CycleResult(0, 0, 0, 0, failure=f"sync: {error}")

    if should_stop():
        return CycleResult(replicated, 0, 0, 0)

    quarantined = 0
    if projector is not None:
        try:
            resumed = projector.resume_pending()
        except CloudAuthError as error:
            return CycleResult(replicated, 0, 0, 0, failure=f"authentication: {error}")
        except ProjectionRecoveryError:
            return CycleResult(replicated, 0, 0, 0, failure="projection_recovery: pending")
        except CloudSyncError as error:
            return CycleResult(replicated, 0, 0, 0, failure=f"projection: {error}", facts_quarantined=quarantined)
        if resumed is not None and resumed.stopped:
            return CycleResult(replicated, 0, 0, 0, facts_quarantined=resumed.quarantined)
        if resumed is not None:
            quarantined = resumed.quarantined

    if should_stop():
        return CycleResult(replicated, 0, 0, 0, facts_quarantined=quarantined)

    try:
        progress = distiller.run_once()
    except CloudAuthError as error:
        return CycleResult(replicated, 0, 0, 0, failure=f"authentication: {error}", facts_quarantined=quarantined)
    except Exception as error:
        # Replication already committed. Reporting rather than raising keeps
        # that work rather than discarding a good cycle for a bad model call.
        return CycleResult(replicated, 0, 0, 0, failure=f"distillation: {error}", facts_quarantined=quarantined)

    try:
        promoted = promote_new_facts(facts, principal_id)
    except CloudAuthError as error:
        return CycleResult(
            replicated,
            progress.excerpts_submitted,
            progress.proposals_recorded,
            0,
            failure=f"authentication: {error}",
            facts_quarantined=quarantined,
        )
    except Exception as error:
        return CycleResult(
            replicated,
            progress.excerpts_submitted,
            progress.proposals_recorded,
            0,
            failure=f"promotion: {error}",
            facts_quarantined=quarantined,
        )
    result = CycleResult(
        events_replicated=replicated,
        excerpts_distilled=progress.excerpts_submitted,
        proposals_recorded=progress.proposals_recorded,
        facts_promoted=len(promoted),
    )
    if projector is None:
        return result
    if should_stop():
        return replace(result, facts_quarantined=quarantined)
    try:
        projected = projector.project()
        quarantined = max(quarantined, projected.quarantined)
    except ProjectionRecoveryError:
        return replace(result, failure="projection_recovery: pending", facts_quarantined=quarantined)
    except CloudAuthError as error:
        return CycleResult(
            replicated,
            progress.excerpts_submitted,
            progress.proposals_recorded,
            len(promoted),
            failure=f"authentication: {error}",
            facts_quarantined=quarantined,
        )
    except CloudSyncError as error:
        return CycleResult(
            replicated,
            progress.excerpts_submitted,
            progress.proposals_recorded,
            len(promoted),
            failure=f"projection: {error}",
            facts_quarantined=quarantined,
        )
    except Exception as error:
        return CycleResult(
            replicated,
            progress.excerpts_submitted,
            progress.proposals_recorded,
            len(promoted),
            failure=f"projection: {error}",
            facts_quarantined=quarantined,
        )
    return replace(result, facts_quarantined=quarantined)


def open_stores(archive_path: Path, memory_path: Path) -> tuple[ArchiveRepository, FactRepository]:
    """Open both databases. Separate files: they enforce different rules.

    The archive forbids every UPDATE; memory must permit state transitions
    while protecting content and provenance.

    The store root each one may change permissions inside is its own parent
    directory as configured -- the archive's store and memory's store are
    separate directories, and the boundary has to be the configured one rather
    than something derived from the path being changed, or the guard in
    `store_permissions` would accept anything.

    **This is the one caller that passes `repair_permissions=True`.** Every
    opener defaults to False so that opening a store can never rewrite a
    permission by accident, and this is the path `jarvis serve` runs -- it starts
    a service that owns these directories and is the only thing that can repair
    a tree created by an elevated process the old way.
    """
    archive = ArchiveRepository.open(archive_path, store_root=archive_path.parent, repair_permissions=True)
    try:
        facts = FactRepository.open(memory_path, store_root=memory_path.parent, repair_permissions=True)
    except BaseException:
        archive.close()
        raise
    return archive, facts
