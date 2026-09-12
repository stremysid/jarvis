"""The background agent: replication, diagnostics, and the local command surface.

Effectful commands are gated here before they reach the cloud, not instead of
it. The cloud revalidates device signature, session evidence and policy
independently -- this check exists so an obviously illegitimate command never
leaves the machine.

The run loop below is the other half. It is background-first: there is no
window, so the only way to ask how it is going is the control channel, and the
only way to answer without waking the databases is to remember. It therefore
keeps a bounded ring of recent cycles in memory -- bounded because this
process is meant to sit resident for months, and an unbounded list of every
cycle it ever ran is a leak with a slow fuse.

Stopping is where the design earns its keep. `agent.run_cycle` is three
separate commitments precisely so that dying between them is survivable, but
survivable is not free: the next cycle has to notice and resume. So the loop
reads the stop flag only between cycles. A stop that arrives mid-cycle waits
for that cycle to finish, which costs seconds and saves the resumption.
"""

from __future__ import annotations

import re
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from jarvis_local.agent import CycleResult
from jarvis_local.clock import format_iso
from jarvis_local.scheduler import (
    AUTHENTICATION_FAILURE_PREFIX,
    Decision,
    Scheduler,
    SchedulerState,
    utc_now,
)
from jarvis_local.sync.cloud_client import CloudAuthError
from jarvis_local.transport.cli_protocol import (
    CONFIRMATION_REQUIRED,
    EFFECTFUL_COMMANDS,
    INTERACTIVE_LOCAL_SESSION_REQUIRED,
    LOCAL_ONLY_COMMANDS,
    OK,
    SERVICE_CONTROL_COMMANDS,
    UNKNOWN_COMMAND,
    CliCommand,
    CliResponse,
    is_interactive_local_session,
)

#: How many finished cycles the service remembers for `status`. Twenty at the
#: ordinary cadence is most of a working day, which is the window in which
#: anyone asks "what has it been doing".
RECENT_CYCLE_LIMIT = 20

#: What provoked a cycle, recorded so that a run triggered by hand is
#: distinguishable from one the cadence produced.
TRIGGER_REQUESTED = "requested"

#: Why the loop returned.
STOPPED_ON_REQUEST = "stopped"

RUNNING = "running"
INVALID_ARGUMENT = "invalid_argument"
FACT_NOT_QUARANTINED = "fact_not_quarantined"
RETRY_FAILED = "retry_failed"
_FACT_ID = re.compile(r"fact_[0-9a-f]{32}\Z")


class CommandHandler(Protocol):
    def __call__(self, command: CliCommand) -> CliResponse: ...


@dataclass
class LocalAgentService:
    """Routes CLI commands, refusing effectful ones from untrusted sessions."""

    handlers: dict[str, CommandHandler]

    def handle(self, command: CliCommand) -> CliResponse:
        if command.name not in EFFECTFUL_COMMANDS | LOCAL_ONLY_COMMANDS | SERVICE_CONTROL_COMMANDS:
            return CliResponse(UNKNOWN_COMMAND)

        if command.name in EFFECTFUL_COMMANDS:
            # Session first, then confirmation. A command from a service or an
            # RDP session must be refused whether or not it claims confirmation,
            # so that a caller cannot learn which check it failed by toggling
            # the flag.
            if not is_interactive_local_session(command.evidence):
                return CliResponse(INTERACTIVE_LOCAL_SESSION_REQUIRED)
            if command.arguments.get("confirm") is not True:
                return CliResponse(CONFIRMATION_REQUIRED)

        handler = self.handlers.get(command.name)
        if handler is None:
            return CliResponse(UNKNOWN_COMMAND)
        return handler(command)


def accepted(lines: tuple[str, ...] = ()) -> CliResponse:
    return CliResponse(OK, lines)


@dataclass(frozen=True, slots=True)
class CycleRecord:
    """One finished cycle, in the shape `status` reports it.

    Holds counts and the failure string, not the objects a cycle touched. The
    point of the ring is to answer questions without reopening a database, and
    a record that keeps a repository alive defeats that twice over.
    """

    started_at: str
    finished_at: str
    trigger: str
    events_replicated: int
    excerpts_distilled: int
    proposals_recorded: int
    facts_promoted: int
    facts_quarantined: int
    failure: str | None

    def summary(self) -> str:
        outcome = "ok" if self.failure is None else self.failure
        counts = (
            f"replicated={self.events_replicated} distilled={self.excerpts_distilled} "
            f"proposed={self.proposals_recorded} promoted={self.facts_promoted} "
            f"quarantined={self.facts_quarantined}"
        )
        return f"{self.finished_at} {self.trigger} {counts} {outcome}"


class ServiceState:
    """What the loop has done, and what the control channel has asked of it.

    Touched by exactly two threads: the run loop, and the thread accepting
    control connections. One lock covers the lot; there is nothing here worth
    finer granularity, and a second lock would only be a second thing to get
    wrong.

    The wake event is the loop's sleep and its doorbell at once. That is why
    there is no poller and no timer thread: `Event.wait(timeout)` returns
    either when the cadence elapses or the moment a command arrives, so a
    `run-once` is acted on immediately without anything spinning to notice it.
    """

    def __init__(self, recent_limit: int = RECENT_CYCLE_LIMIT) -> None:
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._recent: deque[CycleRecord] = deque(maxlen=recent_limit)
        self._stop_requested = False
        self._cycle_requested = False
        self._started_at: str | None = None
        self._status = RUNNING

    def mark_started(self, moment: datetime) -> None:
        with self._lock:
            self._started_at = format_iso(moment)
            self._status = RUNNING

    def mark_stopped(self, reason: str) -> None:
        with self._lock:
            self._status = reason

    def request_stop(self) -> None:
        with self._lock:
            self._stop_requested = True
        self._wake.set()

    def request_cycle(self) -> None:
        with self._lock:
            self._cycle_requested = True
        self._wake.set()

    def stop_requested(self) -> bool:
        """Sample the stop flag now.

        A method rather than a property, and the difference is load-bearing. A
        property reads as an attribute, and both a type checker and a reader
        will carry the first answer forward -- but another thread sets this
        flag, so every read is a fresh observation of a moving fact and none of
        them says anything about the next one.
        """
        with self._lock:
            return self._stop_requested

    def take_cycle_request(self) -> bool:
        """Consume a pending `run-once`, so one request produces one cycle."""
        with self._lock:
            requested = self._cycle_requested
            self._cycle_requested = False
            return requested

    def record(self, cycle: CycleRecord) -> None:
        with self._lock:
            self._recent.append(cycle)

    def recent(self) -> tuple[CycleRecord, ...]:
        with self._lock:
            return tuple(self._recent)

    def report(self) -> tuple[str, ...]:
        with self._lock:
            started = self._started_at or "never"
            status = self._status
            cycles = tuple(self._recent)
        header = (f"status {status}", f"started_at {started}", f"cycles_recorded {len(cycles)}")
        return header + tuple(f"cycle {cycle.summary()}" for cycle in cycles)

    def wait(self, seconds: float) -> None:
        """Sleep until the cadence elapses or a command arrives, whichever first."""
        self._wake.wait(timeout=seconds)
        self._wake.clear()


class RunLoop:
    """Wake, run a cycle, record it, decide when to wake again.

    Owns the waiting the scheduler refuses to do. Everything that would
    otherwise make this untestable -- the clock and the sleep -- arrives as an
    argument, so a test can drive a week of cadence in a millisecond.
    """

    def __init__(
        self,
        run_cycle: Callable[[], CycleResult],
        scheduler: Scheduler | None = None,
        state: ServiceState | None = None,
        sleep: Callable[[float], None] | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.run_cycle = run_cycle
        self.scheduler = scheduler or Scheduler(clock=clock)
        self.state = state or ServiceState()
        self.sleep = sleep or self.state.wait
        self.clock = clock

    def run(self) -> str:
        """Run until stopped or until the scheduler refuses to continue.

        Returns why it stopped, which is also what `status` will report.
        """
        self.state.mark_started(self.clock())
        scheduler_state = SchedulerState()
        last: CycleResult | None = None

        while True:
            # Read before deciding, so a stop that arrived while the previous
            # cycle was running is honoured with that cycle already recorded
            # rather than abandoned half-done.
            if self.state.stop_requested():
                return self._halt(STOPPED_ON_REQUEST)

            decision = self.scheduler.after(scheduler_state, last)
            scheduler_state = decision.state
            if not decision.keep_running:
                return self._halt(decision.reason)

            self.sleep(decision.delay_seconds)
            if self.state.stop_requested():
                # Nothing is in flight here: the stop arrived during the wait.
                return self._halt(STOPPED_ON_REQUEST)

            last = self._run_one(self._trigger(decision))

    def _trigger(self, decision: Decision) -> str:
        # Taken unconditionally, so a request that raced with a cadence wake is
        # consumed rather than left to fire a spurious extra cycle later.
        return TRIGGER_REQUESTED if self.state.take_cycle_request() else decision.reason

    def _run_one(self, trigger: str) -> CycleResult:
        started = self.clock()
        try:
            result = self.run_cycle()
        except CloudAuthError as error:
            # `run_cycle` converts this to a reported failure for the stages it
            # knows about. Classified again here so a future stage that raises
            # it still stops the service rather than backing off forever.
            result = CycleResult(0, 0, 0, 0, failure=f"{AUTHENTICATION_FAILURE_PREFIX} {error}")
        except Exception as error:
            # One bad cycle must not end a service meant to run for months, so
            # this becomes an ordinary transient failure and backs off like one.
            result = CycleResult(0, 0, 0, 0, failure=f"cycle: {error}")
        self.state.record(
            CycleRecord(
                started_at=format_iso(started),
                finished_at=format_iso(self.clock()),
                trigger=trigger,
                events_replicated=result.events_replicated,
                excerpts_distilled=result.excerpts_distilled,
                proposals_recorded=result.proposals_recorded,
                facts_promoted=result.facts_promoted,
                facts_quarantined=result.facts_quarantined,
                failure=result.failure,
            )
        )
        return result

    def _halt(self, reason: str) -> str:
        self.state.mark_stopped(reason)
        return reason


def control_handlers(
    state: ServiceState,
    *,
    retry_quarantined: Callable[[str], bool] | None = None,
) -> dict[str, CommandHandler]:
    """Commands served by the control channel, bound to one loop's state.

    `run-once` and `stop` only set a flag and ring the doorbell. A configured
    quarantine retry callback must likewise queue its store work for the cycle
    thread before it answers. These handlers must not
    run a cycle on the calling thread: that would put a second cycle over the
    same databases alongside the one the loop may already be running, which is
    the one thing the append-only archive cannot be asked to referee.
    """

    def status(command: CliCommand) -> CliResponse:
        return accepted(state.report())

    def run_once(command: CliCommand) -> CliResponse:
        state.request_cycle()
        return accepted(("cycle requested",))

    def stop(command: CliCommand) -> CliResponse:
        state.request_stop()
        return accepted(("stop requested",))

    handlers: dict[str, CommandHandler] = {"status": status, "run-once": run_once, "stop": stop}
    if retry_quarantined is not None:

        def retry(command: CliCommand) -> CliResponse:
            fact_id = command.arguments.get("fact_id")
            if not isinstance(fact_id, str) or _FACT_ID.fullmatch(fact_id) is None:
                return CliResponse(INVALID_ARGUMENT)
            try:
                retried = retry_quarantined(fact_id)
            except Exception:
                # A malformed request or store failure must not escape through
                # the transport and kill the long-running control server.
                return CliResponse(RETRY_FAILED)
            if not retried:
                return CliResponse(FACT_NOT_QUARANTINED)
            return accepted(("projection retry requested",))

        handlers["retry-quarantined"] = retry
    return handlers
