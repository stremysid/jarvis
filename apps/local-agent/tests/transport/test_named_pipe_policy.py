"""Effectful commands require a person at a real console on this machine.

The CLI must never be a privileged bypass around cloud authentication. A
scheduled task, a service, or someone on Remote Desktop must not be able to
make Jarvis place a call, whatever they claim in the request.
"""

from __future__ import annotations

import pytest

from jarvis_local.service import LocalAgentService, accepted
from jarvis_local.transport.cli_protocol import (
    CONFIRMATION_REQUIRED,
    INTERACTIVE_LOCAL_SESSION_REQUIRED,
    OK,
    UNKNOWN_COMMAND,
    CliCommand,
    CliResponse,
    SessionEvidence,
    is_interactive_local_session,
)


def session(**overrides: object) -> SessionEvidence:
    """A legitimate interactive local session, minus whatever is overridden."""
    base = {
        "windows_sid": "S-1-5-21-1-2-3-1001",
        "session_id": 1,
        "is_interactive": True,
        "stdin_redirected": False,
        "remote_desktop": False,
        "is_service": False,
    }
    base.update(overrides)
    return SessionEvidence(**base)  # type: ignore[arg-type]


def fake_dependencies() -> dict[str, object]:
    calls: list[CliCommand] = []

    def handler(command: CliCommand) -> CliResponse:
        calls.append(command)
        return accepted(("dispatched",))

    return {"handlers": {"call-me": handler, "doctor": handler}, "calls": calls}


def build() -> tuple[LocalAgentService, list[CliCommand]]:
    dependencies = fake_dependencies()
    handlers = dependencies["handlers"]
    calls = dependencies["calls"]
    assert isinstance(handlers, dict)
    assert isinstance(calls, list)
    return LocalAgentService(handlers), calls


@pytest.mark.parametrize(
    "evidence",
    [
        session(remote_desktop=True),
        session(stdin_redirected=True),
        session(is_service=True),
        session(is_interactive=False),
        session(windows_sid=""),
        session(session_id=-1),
    ],
)
def test_untrusted_sessions_cannot_issue_an_effectful_command(evidence: SessionEvidence) -> None:
    service, calls = build()
    response = service.handle(CliCommand("call-me", {"confirm": True}, evidence))
    assert response.code == INTERACTIVE_LOCAL_SESSION_REQUIRED
    assert calls == []


def test_default_evidence_is_refused() -> None:
    """Evidence that was never collected must read as untrusted, not as absent
    grounds for refusal."""
    service, calls = build()
    response = service.handle(CliCommand("call-me", {"confirm": True}, SessionEvidence()))
    assert response.code == INTERACTIVE_LOCAL_SESSION_REQUIRED
    assert calls == []


def test_an_interactive_local_session_still_needs_explicit_confirmation() -> None:
    service, calls = build()
    response = service.handle(CliCommand("call-me", {}, session()))
    assert response.code == CONFIRMATION_REQUIRED
    assert calls == []


def test_confirmation_must_be_exactly_true() -> None:
    """Truthy is not enough: "false", 1 and "yes" must not pass for a command
    that places a real phone call."""
    service, calls = build()
    for value in ("true", 1, "yes", [1]):
        response = service.handle(CliCommand("call-me", {"confirm": value}, session()))
        assert response.code == CONFIRMATION_REQUIRED, value
    assert calls == []


def test_a_confirmed_command_from_a_real_console_is_dispatched() -> None:
    service, calls = build()
    response = service.handle(CliCommand("call-me", {"confirm": True}, session()))
    assert response.code == OK
    assert len(calls) == 1


def test_session_is_checked_before_confirmation() -> None:
    """Toggling the confirm flag must not reveal which check failed."""
    service, _ = build()
    without = service.handle(CliCommand("call-me", {}, session(is_service=True)))
    with_flag = service.handle(CliCommand("call-me", {"confirm": True}, session(is_service=True)))
    assert without.code == with_flag.code == INTERACTIVE_LOCAL_SESSION_REQUIRED


def test_read_only_commands_are_allowed_from_any_session() -> None:
    service, calls = build()
    response = service.handle(CliCommand("doctor", {}, session(is_service=True, stdin_redirected=True)))
    assert response.code == OK
    assert len(calls) == 1


def test_unknown_commands_are_refused() -> None:
    service, calls = build()
    assert service.handle(CliCommand("rm-rf", {}, session())).code == UNKNOWN_COMMAND
    assert calls == []


def test_the_effectful_set_is_explicit() -> None:
    """A command added later must not become effectful-gated by accident, nor
    silently escape the gate."""
    from jarvis_local.transport.cli_protocol import EFFECTFUL_COMMANDS, LOCAL_ONLY_COMMANDS

    assert {"call-me"} == EFFECTFUL_COMMANDS
    assert EFFECTFUL_COMMANDS.isdisjoint(LOCAL_ONLY_COMMANDS)


def test_predicate_requires_every_condition() -> None:
    assert is_interactive_local_session(session())
    for override in (
        {"is_interactive": False},
        {"stdin_redirected": True},
        {"remote_desktop": True},
        {"is_service": True},
        {"windows_sid": ""},
        {"session_id": -1},
    ):
        assert not is_interactive_local_session(session(**override)), override
