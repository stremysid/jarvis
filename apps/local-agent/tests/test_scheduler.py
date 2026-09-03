"""A failed cycle is not one kind of event, and the difference is the point.

Transient failure earns patience. An authentication failure earns none: every
retry reproduces the same rejection, so a scheduler that backs off turns a
wrong key into an agent that looks alive for a week. These tests exist mostly
to pin that asymmetry, and to pin the jitter, which is the kind of thing that
gets simplified away by someone who reads it as decoration.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from jarvis_local.agent import CycleResult, run_cycle
from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.memory.distillation import DistillationCoordinator
from jarvis_local.memory.facts import FactRepository
from jarvis_local.scheduler import (
    STOP_AUTHENTICATION,
    WAKE_BACKOFF,
    WAKE_CADENCE,
    WAKE_STARTUP,
    SchedulePolicy,
    Scheduler,
    SchedulerState,
)
from jarvis_local.sync.cloud_client import CloudAuthError, CloudSyncError
from jarvis_local.sync.event_replicator import EventPage, EventReplicator

MOMENT = datetime(2026, 9, 2, 9, 0, 0, tzinfo=UTC)
PRINCIPAL = "principal-a"


def fixed_clock() -> datetime:
    return MOMENT


def seeded_jitter(seed: int) -> Callable[[float, float], float]:
    """A repeatable draw, standing in for the production system source.

    `Scheduler` defaults to `random.SystemRandom` so two machines do not share
    a sequence. These tests need the opposite -- the same sequence twice, and
    two sequences that are known to differ -- which a system source cannot
    give. Nothing drawn here protects anything, so a seeded generator is the
    right instrument rather than a weakened one.
    """
    return random.Random(seed).uniform  # noqa: S311


def highest_jitter(low: float, high: float) -> float:
    """Removes the jitter by always drawing its ceiling, so a shape can be asserted."""
    return high


def lowest_jitter(low: float, high: float) -> float:
    return low


def success() -> CycleResult:
    return CycleResult(1, 1, 1, 0, failure=None)


def transient() -> CycleResult:
    return CycleResult(0, 0, 0, 0, failure="sync: gateway unreachable")


def authentication() -> CycleResult:
    return CycleResult(0, 0, 0, 0, failure="authentication: device rejected")


def build(
    policy: SchedulePolicy | None = None,
    jitter: Callable[[float, float], float] = highest_jitter,
) -> Scheduler:
    return Scheduler(policy=policy, clock=fixed_clock, jitter=jitter)


def test_the_first_wake_after_startup_is_immediate() -> None:
    """The service may have been down all night; waiting out a full cadence
    before the first look is the one delay nothing justifies."""
    decision = build().after(SchedulerState(), None)
    assert decision.keep_running
    assert decision.reason == WAKE_STARTUP
    assert decision.delay_seconds == 0.0


def test_a_successful_cycle_wakes_again_on_the_ordinary_cadence() -> None:
    decision = build().after(SchedulerState(), success())
    assert decision.reason == WAKE_CADENCE
    assert 20 * 60 <= decision.delay_seconds <= 30 * 60


def test_the_cadence_is_drawn_across_the_whole_twenty_to_thirty_minute_band() -> None:
    """Both ends, so a mutant that collapses the band to one of its edges is
    visible rather than merely still in range."""
    assert build(jitter=lowest_jitter).after(SchedulerState(), success()).delay_seconds == 20 * 60
    assert build(jitter=highest_jitter).after(SchedulerState(), success()).delay_seconds == 30 * 60


def test_a_transient_failure_backs_off_rather_than_keeping_the_cadence() -> None:
    scheduler = build()
    decision = scheduler.after(SchedulerState(), transient())

    assert decision.keep_running
    assert decision.reason == WAKE_BACKOFF
    assert decision.state.consecutive_failures == 1
    assert decision.delay_seconds == SchedulePolicy().first_backoff_seconds


def test_consecutive_transient_failures_back_off_further_each_time() -> None:
    scheduler = build()
    delays: list[float] = []
    state = SchedulerState()
    for _ in range(4):
        decision = scheduler.after(state, transient())
        state = decision.state
        delays.append(decision.delay_seconds)

    assert delays == sorted(delays)
    assert delays[0] < delays[-1]
    assert state.consecutive_failures == 4


def test_the_cadence_returns_to_normal_after_a_success() -> None:
    """The whole reason the failure count lives in the state: one good cycle
    must clear the debt, not merely stop adding to it."""
    scheduler = build()
    state = scheduler.after(scheduler.after(SchedulerState(), transient()).state, transient()).state
    assert state.consecutive_failures == 2

    recovered = scheduler.after(state, success())

    assert recovered.reason == WAKE_CADENCE
    assert recovered.state.consecutive_failures == 0
    assert 20 * 60 <= recovered.delay_seconds <= 30 * 60


def test_an_authentication_failure_stops_rather_than_backing_off() -> None:
    decision = build().after(SchedulerState(), authentication())

    assert not decision.keep_running
    assert decision.reason == STOP_AUTHENTICATION
    # Not "a very long delay". There is no next wake at all.
    assert decision.wake_at is None
    assert decision.delay_seconds == 0.0


def test_an_authentication_failure_stops_however_many_failures_precede_it() -> None:
    """A backoff streak must not become a reason to keep retrying an auth
    failure once one finally arrives."""
    decision = build().after(SchedulerState(consecutive_failures=9), authentication())
    assert not decision.keep_running


def test_the_scheduler_recognises_the_failure_run_cycle_actually_writes(tmp_path: Path) -> None:
    """The one coupling this module cannot check by reading itself.

    `agent.run_cycle` owns the wording of the failure string and this module
    owns the reaction to it. Matching on a prefix is only correct while the two
    agree, so this drives a real `run_cycle` into a real `CloudAuthError` and
    feeds the actual result to the scheduler. If the wording moves, this fails
    rather than the service quietly retrying a wrong key forever.
    """
    archive = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    facts = FactRepository.open(tmp_path / "memory.sqlite3")
    try:
        replicator = EventReplicator(_RefusingCloud(CloudAuthError("device rejected")), archive)
        distiller = DistillationCoordinator(archive, facts, _UnusedDistiller(), principal_id=PRINCIPAL)

        result = run_cycle(replicator, distiller, facts, PRINCIPAL)

        assert result.failure is not None
        assert not build().after(SchedulerState(), result).keep_running
    finally:
        archive.close()
        facts.close()


def test_a_transient_cloud_failure_from_run_cycle_backs_off_instead(tmp_path: Path) -> None:
    """The other half of the same coupling: the scheduler must not mistake an
    ordinary sync failure for the one that stops the service."""
    archive = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    facts = FactRepository.open(tmp_path / "memory.sqlite3")
    try:
        replicator = EventReplicator(_RefusingCloud(CloudSyncError("gateway unreachable")), archive)
        distiller = DistillationCoordinator(archive, facts, _UnusedDistiller(), principal_id=PRINCIPAL)

        result = run_cycle(replicator, distiller, facts, PRINCIPAL)

        decision = build().after(SchedulerState(), result)
        assert decision.keep_running
        assert decision.reason == WAKE_BACKOFF
    finally:
        archive.close()
        facts.close()


def test_the_backoff_is_bounded_however_long_the_failure_lasts() -> None:
    """Including at failure counts a real week of outage would reach, where a
    naive `multiplier ** failures` overflows a float rather than capping."""
    policy = SchedulePolicy()
    scheduler = Scheduler(policy=policy, clock=fixed_clock, jitter=highest_jitter)

    for failures in (1, 5, 20, 500, 100_000):
        decision = scheduler.after(SchedulerState(consecutive_failures=failures - 1), transient())
        assert 0.0 < decision.delay_seconds <= policy.maximum_backoff_seconds, failures


def test_the_backoff_is_bounded_under_a_real_random_source() -> None:
    """The bound must hold for every draw, not for the two the fake jitter makes."""
    policy = SchedulePolicy()
    scheduler = Scheduler(policy=policy, clock=fixed_clock, jitter=seeded_jitter(7))

    state = SchedulerState()
    for _ in range(500):
        decision = scheduler.after(state, transient())
        state = decision.state
        assert 0.0 < decision.delay_seconds <= policy.maximum_backoff_seconds


def test_the_backoff_is_jittered_rather_than_a_fixed_ladder() -> None:
    """Two devices from the same image fail together. Without jitter they also
    wake together, forever, which is when the gateway can least serve them."""
    scheduler = Scheduler(clock=fixed_clock, jitter=seeded_jitter(11))
    state = SchedulerState(consecutive_failures=6)

    delays = {scheduler.after(state, transient()).delay_seconds for _ in range(30)}

    # From one fixed state, so a ladder that merely grows would still collapse
    # this to a single value.
    assert len(delays) > 1


def test_two_devices_drawing_independently_do_not_share_a_wake_instant() -> None:
    first = Scheduler(clock=fixed_clock, jitter=seeded_jitter(1))
    second = Scheduler(clock=fixed_clock, jitter=seeded_jitter(2))
    state = SchedulerState(consecutive_failures=3)

    assert first.after(state, transient()).delay_seconds != second.after(state, transient()).delay_seconds


def test_jitter_only_ever_shortens_a_delay() -> None:
    """Which is why the bound needs no clamp. A symmetric jitter would need
    one, and a clamp piles probability onto the cap itself -- the single
    instant the jitter exists to spread devices away from."""
    policy = SchedulePolicy()
    capped = Scheduler(policy=policy, clock=fixed_clock, jitter=seeded_jitter(3))
    state = SchedulerState(consecutive_failures=40)

    delays = [capped.after(state, transient()).delay_seconds for _ in range(200)]

    assert max(delays) <= policy.maximum_backoff_seconds
    assert min(delays) >= policy.maximum_backoff_seconds * (1.0 - policy.jitter_fraction)


def test_the_wake_instant_comes_from_the_injected_clock() -> None:
    """Otherwise a scheduler reporting `wake_at` would be reading the machine's
    clock while the loop reads the injected one."""
    decision = build().after(SchedulerState(), success())
    assert decision.wake_at == MOMENT + timedelta(seconds=decision.delay_seconds)


def test_a_policy_whose_backoff_cannot_grow_is_refused() -> None:
    """Not fussiness: the backoff multiplies until it reaches the cap, and a
    multiplier of 1.0 never does. This check is the loop's termination proof."""
    with pytest.raises(ValueError, match="multiplier"):
        SchedulePolicy(backoff_multiplier=1.0)


@pytest.mark.parametrize(
    "overrides",
    [
        {"cadence_seconds": 0.0},
        {"cadence_spread_seconds": -1.0},
        {"first_backoff_seconds": 0.0},
        {"maximum_backoff_seconds": 1.0},
        {"jitter_fraction": 1.0},
        {"jitter_fraction": -0.1},
    ],
)
def test_a_policy_that_would_produce_an_unbounded_or_negative_delay_is_refused(
    overrides: dict[str, float],
) -> None:
    with pytest.raises(ValueError):
        SchedulePolicy(**overrides)


class _RefusingCloud:
    """A cloud that only ever raises, to drive `run_cycle` down one branch."""

    def __init__(self, error: Exception) -> None:
        self.error = error

    def pull(self, after_sequence: int) -> EventPage:
        raise self.error

    def acknowledge(self, through_sequence: int) -> None:
        return None


class _UnusedDistiller:
    """Never reached: replication fails first in both coupling tests."""

    def distill(self, excerpts: object) -> list[dict[str, object]]:
        raise AssertionError("distillation must not run after a replication failure")
