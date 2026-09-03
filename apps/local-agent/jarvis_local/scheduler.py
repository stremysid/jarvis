"""When the background agent wakes next, and whether it should wake at all.

A failed cycle is not one kind of event, and treating it as one is the mistake
this module exists to prevent. A transient failure -- the gateway is
unreachable, a model call timed out -- deserves patience: the next wake is
pushed out, and pushed out again if the next attempt also fails. An
authentication failure deserves none. The key, the device registration or the
clock is wrong, every retry produces the identical rejection, and backing off
converts a one-line problem into an agent that looks alive for days while
achieving nothing. So it stops and surfaces instead.

The jitter is not decoration either. Two devices installed from the same image
and started by the same logon script fail together and back off together, and
an unjittered backoff walks them onto the same wake instant and then holds
them there, which is exactly when the gateway is least able to serve either.
Jitter is applied downward only, so a delay is bounded by its own cap without
a clamp -- clamping a symmetric jitter would pile probability mass onto the
cap itself, which is the one instant the jitter exists to spread devices away
from.

Nothing here sleeps or blocks. The policy answers "when" and "whether"; the
loop that owns the waiting lives in `service.py`. That separation is what lets
a test assert a cadence measured in half-hours without spending them.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from jarvis_local.agent import CycleResult

#: Why the next wake was chosen. Reported rather than inferred, so `status` can
#: distinguish "quiet because all is well" from "quiet because it is backing
#: off", which look identical from the outside.
WAKE_STARTUP = "startup"
WAKE_CADENCE = "cadence"
WAKE_BACKOFF = "backoff"

#: Why the service stopped waking.
STOP_AUTHENTICATION = "authentication"

#: `agent.run_cycle` writes `f"authentication: {error}"` for the one failure
#: that must never be retried. Matched on rather than imported because
#: `agent.py` owns that wording and this module owns the reaction to it;
#: `test_the_scheduler_recognises_the_failure_run_cycle_actually_writes` pins
#: the two together against a real `run_cycle`, so the coupling cannot drift
#: into a scheduler that quietly retries an auth failure forever.
AUTHENTICATION_FAILURE_PREFIX = "authentication:"

_SYSTEM_RANDOM = random.SystemRandom()


def utc_now() -> datetime:
    """The clock, as an injectable default in the style `run_doctor` uses."""
    return datetime.now(UTC)


def _uniform(low: float, high: float) -> float:
    return _SYSTEM_RANDOM.uniform(low, high)


@dataclass(frozen=True, slots=True)
class SchedulePolicy:
    """The cadence numbers, separated from the rules that apply them."""

    #: Daytime cadence: a wake somewhere in [cadence, cadence + spread].
    cadence_seconds: float = 20.0 * 60.0
    cadence_spread_seconds: float = 10.0 * 60.0
    first_backoff_seconds: float = 60.0
    backoff_multiplier: float = 2.0
    #: The ceiling is the top of the ordinary cadence on purpose. A failing
    #: agent that backs off for hours is indistinguishable from a dead one, and
    #: the failure it is waiting out is usually a laptop lid.
    maximum_backoff_seconds: float = 30.0 * 60.0
    #: Applied downward: a delay is drawn from [(1 - fraction) * d, d].
    jitter_fraction: float = 0.25

    def __post_init__(self) -> None:
        if self.cadence_seconds <= 0 or self.cadence_spread_seconds < 0:
            raise ValueError("cadence must be positive and its spread non-negative")
        if self.first_backoff_seconds <= 0:
            raise ValueError("the first backoff must be positive")
        if self.backoff_multiplier <= 1.0:
            # Not fussiness. `_backoff_delay` doubles until it reaches the cap
            # and a multiplier of 1.0 never reaches it, so the loop's
            # termination argument is this check.
            raise ValueError("the backoff multiplier must exceed 1.0")
        if self.maximum_backoff_seconds < self.first_backoff_seconds:
            raise ValueError("the backoff ceiling must not be below the first backoff")
        if not 0.0 <= self.jitter_fraction < 1.0:
            raise ValueError("the jitter fraction must be in [0.0, 1.0)")


@dataclass(frozen=True, slots=True)
class SchedulerState:
    """Everything the policy remembers between cycles.

    Carried by the caller rather than held on the scheduler, so that deciding
    is a function of its arguments and a test can ask about the tenth
    consecutive failure without staging the nine before it.
    """

    consecutive_failures: int = 0


@dataclass(frozen=True, slots=True)
class Decision:
    state: SchedulerState
    keep_running: bool
    #: One of the WAKE_* constants when running, a STOP_* constant when not.
    reason: str
    delay_seconds: float = 0.0
    #: `None` exactly when `keep_running` is false: there is no next wake.
    wake_at: datetime | None = None


class Scheduler:
    """The cadence policy. Pure: no sleeping, no I/O, no hidden state."""

    def __init__(
        self,
        policy: SchedulePolicy | None = None,
        clock: Callable[[], datetime] = utc_now,
        jitter: Callable[[float, float], float] = _uniform,
    ) -> None:
        self.policy = policy or SchedulePolicy()
        self.clock = clock
        #: Seeded from the OS by default so two devices do not draw the same
        #: sequence; tests inject `random.Random(seed).uniform` for a
        #: repeatable draw.
        self.jitter = jitter

    def after(self, state: SchedulerState, result: CycleResult | None) -> Decision:
        """Given the cycle that just finished, say when to wake and whether to.

        `result` is `None` only at startup, before any cycle has run.
        """
        now = self.clock()

        if result is None:
            # Run immediately. The service may have been down for a day, and
            # waiting out a full cadence before the first look is the one delay
            # nothing justifies.
            return self._wake(state, WAKE_STARTUP, 0.0, now)

        if result.failure is None:
            return self._wake(SchedulerState(0), WAKE_CADENCE, self._cadence_delay(), now)

        if result.failure.startswith(AUTHENTICATION_FAILURE_PREFIX):
            # No backoff, not even a long one. Retrying reproduces the
            # rejection exactly, so the only useful action is to be seen.
            return Decision(state=state, keep_running=False, reason=STOP_AUTHENTICATION)

        failures = state.consecutive_failures + 1
        return self._wake(SchedulerState(failures), WAKE_BACKOFF, self._backoff_delay(failures), now)

    def _wake(self, state: SchedulerState, reason: str, delay: float, now: datetime) -> Decision:
        return Decision(
            state=state,
            keep_running=True,
            reason=reason,
            delay_seconds=delay,
            wake_at=now + timedelta(seconds=delay),
        )

    def _cadence_delay(self) -> float:
        low = self.policy.cadence_seconds
        return self.jitter(low, low + self.policy.cadence_spread_seconds)

    def _backoff_delay(self, failures: int) -> float:
        """Exponential, capped, then jittered downward.

        Multiplied in a loop rather than raised to a power: a service that has
        been failing for a week reaches a `failures` in the thousands, and
        `multiplier ** failures` overflows a float long before that. The result
        is capped anyway, so the loop stops as soon as it must -- five or six
        iterations for any sane policy, and `SchedulePolicy` refuses a
        multiplier that would not terminate it.
        """
        delay = self.policy.first_backoff_seconds
        for _ in range(max(failures - 1, 0)):
            if delay >= self.policy.maximum_backoff_seconds:
                break
            delay *= self.policy.backoff_multiplier
        delay = min(delay, self.policy.maximum_backoff_seconds)
        return delay * self.jitter(1.0 - self.policy.jitter_fraction, 1.0)
