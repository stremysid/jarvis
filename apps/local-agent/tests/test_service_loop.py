"""Stopping is where the three-commitment cycle design gets tested for real.

`agent.run_cycle` is built so that dying between replicate and promote is
survivable. Survivable is not free: the next cycle has to notice and resume.
So the loop reads the stop flag only between cycles, and the first test here
is the one that says so -- a stop arriving mid-cycle costs seconds and saves
the resumption.

The rest guard the property that makes a background service worth running: it
must outlive its own bad days. One failed cycle, one raised exception, one
model outage -- none of them may end the process. Exactly one thing may, and
it is the failure that no amount of waiting fixes.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from jarvis_local.agent import CycleResult
from jarvis_local.node import _QuarantineRetryCoordinator
from jarvis_local.scheduler import (
    STOP_AUTHENTICATION,
    WAKE_BACKOFF,
    WAKE_CADENCE,
    SchedulePolicy,
    Scheduler,
)
from jarvis_local.service import (
    INVALID_ARGUMENT,
    RECENT_CYCLE_LIMIT,
    RETRY_FAILED,
    STOPPED_ON_REQUEST,
    TRIGGER_REQUESTED,
    LocalAgentService,
    RunLoop,
    ServiceState,
    control_handlers,
)
from jarvis_local.sync.cloud_client import CloudAuthError
from jarvis_local.transport.cli_protocol import OK, CliCommand

START = datetime(2026, 9, 2, 9, 0, 0, tzinfo=UTC)


class TickingClock:
    """Advances a second per reading, so a record's start and finish differ."""

    def __init__(self, start: datetime = START) -> None:
        self.now = start

    def __call__(self) -> datetime:
        self.now += timedelta(seconds=1)
        return self.now


class FakeSleeper:
    """Records what it was asked to wait, and waits for none of it."""

    def __init__(self, during_sleep: Callable[[], None] | None = None) -> None:
        self.delays: list[float] = []
        self.during_sleep = during_sleep

    def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)
        if self.during_sleep is not None:
            self.during_sleep()


def ok(events: int = 1) -> CycleResult:
    return CycleResult(events, 1, 1, 0, failure=None)


def transient() -> CycleResult:
    return CycleResult(0, 0, 0, 0, failure="sync: gateway unreachable")


def authentication() -> CycleResult:
    return CycleResult(0, 0, 0, 0, failure="authentication: device rejected")


def steady_scheduler() -> Scheduler:
    """A scheduler with the jitter removed, so delays can be asserted exactly."""

    def top_of_range(low: float, high: float) -> float:
        return high

    return Scheduler(policy=SchedulePolicy(), clock=TickingClock(), jitter=top_of_range)


def loop_over(
    results: list[CycleResult],
    state: ServiceState | None = None,
    sleeper: FakeSleeper | None = None,
) -> tuple[RunLoop, ServiceState, FakeSleeper, list[int]]:
    """A loop that serves `results` in order and stops itself when they run out.

    Stopping on exhaustion rather than on a counter keeps every test's cycle
    budget visible in the list it passed in.
    """
    service_state = state or ServiceState()
    sleep = sleeper or FakeSleeper()
    remaining = list(results)
    ran: list[int] = []

    def run_cycle() -> CycleResult:
        ran.append(len(ran))
        result = remaining.pop(0)
        if not remaining:
            service_state.request_stop()
        return result

    loop = RunLoop(
        run_cycle=run_cycle,
        scheduler=steady_scheduler(),
        state=service_state,
        sleep=sleep,
        clock=TickingClock(),
    )
    return loop, service_state, sleep, ran


def test_the_loop_finishes_the_cycle_in_flight_when_asked_to_stop() -> None:
    """A stop arriving between replicate and promote is exactly the state the
    three-commitment design exists to survive -- but surviving it costs the
    next cycle work, so the flag is read between cycles and not inside one."""
    state = ServiceState()
    finished: list[str] = []

    def run_cycle() -> CycleResult:
        state.request_stop()  # arrives mid-cycle
        finished.append("cycle completed")
        return ok(events=7)

    sleeper = FakeSleeper()
    loop = RunLoop(run_cycle=run_cycle, scheduler=steady_scheduler(), state=state, sleep=sleeper)

    assert loop.run() == STOPPED_ON_REQUEST
    assert finished == ["cycle completed"]
    # Completed *and* recorded. An abandoned cycle would leave nothing here.
    recent = state.recent()
    assert len(recent) == 1
    assert recent[0].events_replicated == 7
    assert recent[0].failure is None
    # And it stopped there rather than waiting out another cadence first. Only
    # the startup wait happened. This is the assertion that distinguishes the
    # check at the top of the loop from the one after the wait: with an
    # event-backed sleeper the two look identical, and a sleeper that does not
    # wake early -- which is any sleeper someone might inject later -- turns
    # the missing check into a `jarvis stop` that takes half an hour.
    assert sleeper.delays == [0.0]


def test_a_stop_arriving_during_the_wait_does_not_start_another_cycle() -> None:
    """The other side of the same rule: nothing is in flight during the wait,
    so there is nothing to finish and a cycle must not be begun."""
    state = ServiceState()
    started: list[int] = []
    sleeps: list[int] = []

    def run_cycle() -> CycleResult:
        started.append(1)
        return ok()

    def stop_during_the_second_wait() -> None:
        sleeps.append(1)
        if len(sleeps) == 2:
            state.request_stop()

    sleeper = FakeSleeper(during_sleep=stop_during_the_second_wait)
    loop = RunLoop(run_cycle=run_cycle, scheduler=steady_scheduler(), state=state, sleep=sleeper)

    assert loop.run() == STOPPED_ON_REQUEST
    # One cycle ran after the startup wait; the stop landed in the wait that
    # followed it, and the cycle that wait was leading up to never began.
    assert started == [1]


def test_a_stop_arriving_before_the_first_cycle_leaves_the_databases_untouched() -> None:
    """Installed, started, and immediately stopped. The service must not open a
    cycle it has already been told not to run."""
    state = ServiceState()
    started: list[int] = []

    def run_cycle() -> CycleResult:
        started.append(1)
        return ok()

    sleeper = FakeSleeper(during_sleep=state.request_stop)
    loop = RunLoop(run_cycle=run_cycle, scheduler=steady_scheduler(), state=state, sleep=sleeper)

    assert loop.run() == STOPPED_ON_REQUEST
    assert started == []
    assert state.recent() == ()


def test_one_failing_cycle_does_not_end_the_service() -> None:
    loop, state, _, ran = loop_over([transient(), transient(), ok()])

    assert loop.run() == STOPPED_ON_REQUEST
    assert len(ran) == 3
    assert [record.failure for record in state.recent()][-1] is None


def test_an_exception_from_a_cycle_is_a_transient_failure_not_a_crash() -> None:
    """`run_cycle` reports its own three stages, but promotion and anything a
    later stage adds can still raise. A service meant to run for months must
    not be ended by one of them."""
    state = ServiceState()
    attempts: list[int] = []

    def run_cycle() -> CycleResult:
        attempts.append(len(attempts))
        if len(attempts) == 1:
            raise RuntimeError("the index rebuild blew up")
        state.request_stop()
        return ok()

    loop = RunLoop(run_cycle=run_cycle, scheduler=steady_scheduler(), state=state, sleep=FakeSleeper())

    assert loop.run() == STOPPED_ON_REQUEST
    assert len(attempts) == 2
    first = state.recent()[0]
    assert first.failure is not None
    assert "the index rebuild blew up" in first.failure


def test_a_raised_authentication_error_stops_the_service_like_a_reported_one() -> None:
    """A stage that raises `CloudAuthError` instead of reporting it must not
    become an ordinary failure that backs off against a wrong key forever.

    The attempt counter is the assertion, not a safety net. "Forever" is the
    failure being ruled out, and a loop that never stops does not fail a test
    -- it hangs one, which reads as an infrastructure problem rather than as
    the defect it is.

    The bound is a stop request rather than a raised error, and that is not a
    style choice: `_run_one` catches `Exception`, so a guard that raises one is
    swallowed by the containment it was meant to escape and the loop spins on
    regardless. Measured, not assumed -- the first version of this test hung.
    """
    state = ServiceState()
    attempts: list[int] = []

    def run_cycle() -> CycleResult:
        attempts.append(len(attempts))
        if len(attempts) > 3:
            state.request_stop()
        raise CloudAuthError("device rejected")

    loop = RunLoop(run_cycle=run_cycle, scheduler=steady_scheduler(), state=state, sleep=FakeSleeper())

    assert loop.run() == STOP_AUTHENTICATION
    assert len(attempts) == 1


def test_an_authentication_failure_ends_the_loop_without_waiting_again() -> None:
    state = ServiceState()
    sleeper = FakeSleeper()

    def run_cycle() -> CycleResult:
        return authentication()

    loop = RunLoop(run_cycle=run_cycle, scheduler=steady_scheduler(), state=state, sleep=sleeper)

    assert loop.run() == STOP_AUTHENTICATION
    # One wait, before the single cycle that failed. Nothing was slept off
    # afterwards: the delay for a wrong key is not "long", it is absent.
    assert sleeper.delays == [0.0]


def test_a_transient_failure_makes_the_loop_wait_longer_than_the_cadence_would() -> None:
    loop, _, sleeper, _ = loop_over([transient(), ok()])
    loop.run()

    startup, after_failure = sleeper.delays[0], sleeper.delays[1]
    assert startup == 0.0
    assert after_failure == SchedulePolicy().first_backoff_seconds
    assert after_failure < SchedulePolicy().cadence_seconds


def test_a_successful_cycle_makes_the_loop_wait_out_the_ordinary_cadence() -> None:
    loop, _, sleeper, _ = loop_over([ok(), ok()])
    loop.run()

    assert sleeper.delays[1] == SchedulePolicy().cadence_seconds + SchedulePolicy().cadence_spread_seconds


def test_the_record_of_recent_cycles_is_bounded() -> None:
    """Resident for months. An unbounded list of every cycle it ever ran is a
    leak with a slow fuse, and the control channel only ever shows the tail."""
    state = ServiceState()
    loop, _, _, _ = loop_over([ok(events=n) for n in range(RECENT_CYCLE_LIMIT + 7)], state=state)
    loop.run()

    recent = state.recent()
    assert len(recent) == RECENT_CYCLE_LIMIT
    # The tail was kept, not the head: `status` should show what just happened.
    assert recent[-1].events_replicated == RECENT_CYCLE_LIMIT + 6


def test_a_cycle_records_the_counts_the_result_carried() -> None:
    state = ServiceState()
    loop, _, _, _ = loop_over([CycleResult(3, 5, 2, 1, failure=None)], state=state)
    loop.run()

    record = state.recent()[0]
    assert (
        record.events_replicated,
        record.excerpts_distilled,
        record.proposals_recorded,
        record.facts_promoted,
    ) == (3, 5, 2, 1)
    assert record.started_at < record.finished_at


def test_a_requested_cycle_is_recorded_as_requested_not_as_cadence() -> None:
    state = ServiceState()
    loop, _, _, _ = loop_over([ok(), ok()], state=state, sleeper=FakeSleeper(during_sleep=state.request_cycle))
    loop.run()

    triggers = [record.trigger for record in state.recent()]
    assert triggers[1] == TRIGGER_REQUESTED


def test_one_run_once_request_produces_exactly_one_extra_cycle() -> None:
    """The flag is consumed on use. Left set, it would fire a spurious cycle
    on every wake that followed."""
    state = ServiceState()
    state.request_cycle()
    loop, _, _, _ = loop_over([ok(), ok(), ok()], state=state)
    loop.run()

    triggers = [record.trigger for record in state.recent()]
    assert triggers.count(TRIGGER_REQUESTED) == 1
    assert triggers[1:] == [WAKE_CADENCE, WAKE_CADENCE]


def test_quarantine_is_visible_without_turning_success_into_backoff() -> None:
    result = CycleResult(1, 1, 1, 1, failure=None, facts_quarantined=3)
    loop, state, sleeper, _ = loop_over([result, ok()])

    loop.run()

    records = state.recent()
    assert records[0].failure is None
    assert records[0].facts_quarantined == 3
    assert records[1].trigger == WAKE_CADENCE
    assert sleeper.delays == [0.0, 1800.0]


def test_status_reports_the_recent_cycles() -> None:
    """The control channel must answer "how is it going" from memory. Reaching
    into the databases to answer a status query is the thing the ring exists
    to avoid."""
    state = ServiceState()
    loop, _, _, _ = loop_over([ok(events=4), transient(), ok(events=6)], state=state)
    loop.run()

    service = LocalAgentService(control_handlers(state))
    response = service.handle(CliCommand("status"))

    assert response.code == OK
    body = "\n".join(response.lines)
    assert "cycles_recorded 3" in body
    assert "replicated=4" in body
    assert "replicated=6" in body
    assert "sync: gateway unreachable" in body
    assert f"status {STOPPED_ON_REQUEST}" in body


def test_status_before_any_cycle_says_so_rather_than_failing() -> None:
    service = LocalAgentService(control_handlers(ServiceState()))
    response = service.handle(CliCommand("status"))

    assert response.code == OK
    assert "started_at never" in "\n".join(response.lines)
    assert "cycles_recorded 0" in "\n".join(response.lines)


def test_run_once_only_asks_and_does_not_run_a_cycle_on_the_callers_thread() -> None:
    """Two cycles over one append-only archive at once is the one thing it
    cannot be asked to referee, so the handler sets a flag and returns."""
    state = ServiceState()
    response = LocalAgentService(control_handlers(state)).handle(CliCommand("run-once"))

    assert response.code == OK
    assert state.take_cycle_request() is True
    assert state.take_cycle_request() is False


def test_stop_only_asks_and_leaves_the_cycle_boundary_to_the_loop() -> None:
    state = ServiceState()
    response = LocalAgentService(control_handlers(state)).handle(CliCommand("stop"))

    assert response.code == OK
    assert state.stop_requested() is True


def test_retry_quarantined_clears_one_fact_and_wakes_the_loop() -> None:
    state = ServiceState()
    retried: list[str] = []

    def retry(fact_id: str) -> bool:
        retried.append(fact_id)
        state.request_cycle()
        return True

    service = LocalAgentService(control_handlers(
        state,
        retry_quarantined=retry,
    ))

    response = service.handle(CliCommand("retry-quarantined", {"fact_id": "fact_" + "a" * 32}))

    assert response.code == OK
    assert retried == ["fact_" + "a" * 32]
    assert state.take_cycle_request() is True


def test_retry_quarantined_refuses_an_unknown_or_malformed_fact(
    retry_factory: Callable[[ServiceState], _QuarantineRetryCoordinator],
) -> None:
    state = ServiceState()
    coordinator = retry_factory(state)
    service = LocalAgentService(control_handlers(state, retry_quarantined=coordinator.submit))
    try:
        assert service.handle(CliCommand("retry-quarantined", {"fact_id": "not-a-fact"})).code == INVALID_ARGUMENT
        assert service.handle(CliCommand("retry-quarantined", {"fact_id": "fact_" + "a" * 32})).code == "queued"
        coordinator.drain(lambda _: False)
        assert any(f"projection_retry fact_{'a' * 32} not_quarantined" in line for line in state.report())
        assert state.take_cycle_request() is False
    finally:
        coordinator.close()


def test_retry_quarantined_contains_store_failure() -> None:
    state = ServiceState()

    def fail(_fact_id: str) -> bool:
        raise RuntimeError("database unavailable")

    service = LocalAgentService(control_handlers(state, retry_quarantined=fail))

    response = service.handle(CliCommand("retry-quarantined", {"fact_id": "fact_" + "a" * 32}))

    assert response.code == RETRY_FAILED
    assert response.lines == ()


def test_the_backoff_reason_is_reported_so_quiet_can_be_told_from_stuck() -> None:
    """A service backing off and a service idling look identical from outside.
    The recorded reason is the only thing that separates them."""
    state = ServiceState()
    loop, _, _, _ = loop_over([transient(), ok()], state=state)
    loop.run()

    assert [record.trigger for record in state.recent()][1] == WAKE_BACKOFF
