"""The command surface the CLI speaks to the background service.

The CLI must never be a privileged bypass around cloud authentication. It
carries evidence about the Windows session it was invoked from, the service
checks that evidence locally, and the cloud policy service revalidates
everything again before anything external happens.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Commands that cause an external effect -- placing a call, reaching another
# person. These require an interactive local session AND explicit confirmation.
EFFECTFUL_COMMANDS: frozenset[str] = frozenset({"call-me"})

# Commands that only read local state. Safe from any session.
LOCAL_ONLY_COMMANDS: frozenset[str] = frozenset({"doctor", "status", "sync"})

# Commands that steer the background loop on this machine and nothing beyond
# it: run a cycle now, stop waking. Deliberately not in EFFECTFUL_COMMANDS,
# which gates things that reach another person and therefore demand a console
# and a confirmation. The boundary that protects these is the pipe's ACL --
# whoever can open the channel is already the owner of the agent they would be
# steering -- so requiring an interactive console here would only break
# `jarvis stop` from a shutdown script while protecting nobody.
SERVICE_CONTROL_COMMANDS: frozenset[str] = frozenset({"run-once", "stop", "retry-quarantined"})

INTERACTIVE_LOCAL_SESSION_REQUIRED = "interactive_local_session_required"
CONFIRMATION_REQUIRED = "confirmation_required"
UNKNOWN_COMMAND = "unknown_command"
OK = "ok"


@dataclass(frozen=True, slots=True)
class SessionEvidence:
    """What the CLI can prove about where it was invoked from.

    Every field defaults to the unsafe answer, so evidence that was never
    collected reads as "not an interactive local session" rather than
    accidentally passing.
    """

    windows_sid: str = ""
    session_id: int = -1
    is_interactive: bool = False
    stdin_redirected: bool = True
    remote_desktop: bool = False
    is_service: bool = False


@dataclass(frozen=True, slots=True)
class CliCommand:
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    evidence: SessionEvidence = field(default_factory=SessionEvidence)


@dataclass(frozen=True, slots=True)
class CliResponse:
    code: str
    lines: tuple[str, ...] = ()


def is_interactive_local_session(evidence: SessionEvidence) -> bool:
    """Whether this looks like Sid at a real console on this machine.

    Denied by default: Remote Desktop, service sessions, scheduled tasks and
    redirected input all fail, because none of them proves a person is present.
    """
    return (
        evidence.is_interactive
        and not evidence.stdin_redirected
        and not evidence.remote_desktop
        and not evidence.is_service
        and bool(evidence.windows_sid)
        and evidence.session_id >= 0
    )
