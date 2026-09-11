"""The agent loop: replicate, then distil, then promote.

Order matters and is not interchangeable. Distillation reads the archive, so
replication runs first or it distils a stale view. Promotion runs last,
because it decides what a proposal is entitled to become and there is nothing
to decide before the proposals exist.

Each cycle is independently recoverable. A failure in one stage leaves the
earlier stages' work durable and the later ones simply undone, so the next
cycle resumes rather than restarts. That is why nothing here wraps the three
in a single transaction: they are separate commitments, and pretending
otherwise would mean losing replication work because distillation failed.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.memory.distillation import DistillationCoordinator, promote_new_facts
from jarvis_local.memory.facts import FactRepository
from jarvis_local.sync.cloud_client import CloudAuthError, CloudSyncError
from jarvis_local.sync.event_replicator import EventReplicator, SyncAckPending


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


def run_cycle(
    replicator: EventReplicator,
    distiller: DistillationCoordinator,
    facts: FactRepository,
    principal_id: str,
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

    try:
        progress = distiller.run_once()
    except CloudAuthError as error:
        return CycleResult(replicated, 0, 0, 0, failure=f"authentication: {error}")
    except Exception as error:
        # Replication already committed. Reporting rather than raising keeps
        # that work rather than discarding a good cycle for a bad model call.
        return CycleResult(replicated, 0, 0, 0, failure=f"distillation: {error}")

    promoted = promote_new_facts(facts, principal_id)
    return CycleResult(
        events_replicated=replicated,
        excerpts_distilled=progress.excerpts_submitted,
        proposals_recorded=progress.proposals_recorded,
        facts_promoted=len(promoted),
    )


def open_stores(archive_path: Path, memory_path: Path) -> tuple[ArchiveRepository, FactRepository]:
    """Open both databases. Separate files: they enforce different rules.

    The archive forbids every UPDATE; memory must permit state transitions
    while protecting content and provenance.
    """
    archive = ArchiveRepository.open(archive_path)
    try:
        facts = FactRepository.open(memory_path)
    except BaseException:
        archive.close()
        raise
    return archive, facts
