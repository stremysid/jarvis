"""What `jarvis status` says when there is nothing to say it to.

A background service that is not running is indistinguishable, at the
transport, from a missing file -- because that is literally what it is. The
CLI's one job beyond forwarding is to not pass that distinction on to whoever
typed the command. "No such file or directory" is true and useless.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from jarvis_local.cli import EXIT_SERVICE_UNAVAILABLE, _control, build_parser, main
from jarvis_local.transport.cli_protocol import OK, CliCommand, CliResponse
from jarvis_local.transport.pipe_server import TruncatedFrameError


def absent_pipe_name() -> str:
    """A pipe nothing is serving. Opening it fails at once -- no wait, no network."""
    return rf"\\.\pipe\jarvis-absent-{os.getpid()}-{uuid.uuid4().hex}"


@pytest.mark.parametrize("command", ["status", "run-once", "stop"])
def test_a_control_command_against_a_stopped_service_explains_itself(
    command: str, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main([command, "--pipe-name", absent_pipe_name()])

    assert code == EXIT_SERVICE_UNAVAILABLE
    printed = capsys.readouterr().out
    assert "not running" in printed
    # The errno and the path are what the person did not ask about.
    assert "Errno" not in printed
    assert "pipe" not in printed


def test_a_missing_service_does_not_surface_as_a_traceback() -> None:
    """The failure mode this replaces: an OSError escaping `main` and being
    printed by the interpreter, exit code 1, no sentence anyone can act on."""
    assert main(["status", "--pipe-name", absent_pipe_name()]) == EXIT_SERVICE_UNAVAILABLE


@pytest.mark.parametrize("command", ["status", "run-once", "stop"])
def test_the_parser_exposes_each_control_command(command: str) -> None:
    arguments = build_parser().parse_args([command])
    assert arguments.command == command
    # The platform default is chosen at execution time; nobody should have to
    # know which local transport the installed node uses.
    assert arguments.pipe_name is None
    assert arguments.socket_path is None


def test_retry_quarantined_sends_the_exact_fact_id_to_the_running_node(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[object] = []
    fact_id = "fact_" + "a" * 32

    def send(command: object, _socket_path: Path | None) -> CliResponse:
        sent.append(command)
        return CliResponse(OK, ("projection retry requested",))

    monkeypatch.setattr("jarvis_local.cli.os", SimpleNamespace(name="posix"))
    monkeypatch.setattr("jarvis_local.cli.send_unix_control_request", send)

    assert main(["retry-quarantined", fact_id]) == 0
    assert sent == [CliCommand("retry-quarantined", {"fact_id": fact_id})]


def test_an_explicit_pipe_name_keeps_the_windows_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def send(command: object, pipe_name: str) -> CliResponse:
        calls.append(pipe_name)
        return CliResponse(OK)

    monkeypatch.setattr("jarvis_local.cli.send_control_request", send)
    monkeypatch.setattr("jarvis_local.cli.send_unix_control_request", lambda *_: pytest.fail("used Unix socket"))

    assert _control("status", r"\\.\pipe\explicit", None) == 0
    assert calls == [r"\\.\pipe\explicit"]


def test_a_queued_retry_is_reported_as_accepted_but_not_applied(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("jarvis_local.cli.os", SimpleNamespace(name="posix"))
    monkeypatch.setattr(
        "jarvis_local.cli.send_unix_control_request",
        lambda *_: CliResponse("queued", ("projection retry queued; not yet applied",)),
    )

    assert main(["retry-quarantined", "fact_" + "a" * 32]) == 0
    output = capsys.readouterr().out
    assert "queued; not yet applied" in output
    assert "not running" not in output


def test_posix_defaults_to_the_unix_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Path | None] = []

    def send(command: object, socket_path: Path | None) -> CliResponse:
        calls.append(socket_path)
        return CliResponse(OK)

    monkeypatch.setattr("jarvis_local.cli.os", SimpleNamespace(name="posix"))
    monkeypatch.setattr("jarvis_local.cli.send_unix_control_request", send)
    monkeypatch.setattr("jarvis_local.cli.send_control_request", lambda *_: pytest.fail("used named pipe"))

    assert _control("status", None, None) == 0
    assert calls == [None]


def test_windows_defaults_to_the_named_pipe(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def send(command: object, pipe_name: str) -> CliResponse:
        calls.append(pipe_name)
        return CliResponse(OK)

    monkeypatch.setattr("jarvis_local.cli.os", SimpleNamespace(name="nt"))
    monkeypatch.setattr("jarvis_local.cli.send_control_request", send)
    monkeypatch.setattr("jarvis_local.cli.send_unix_control_request", lambda *_: pytest.fail("used Unix socket"))

    assert _control("status", None, None) == 0
    assert calls == [r"\\.\pipe\jarvis-local-agent"]


def test_a_malformed_service_response_is_sanitized(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def malformed(*_: object) -> CliResponse:
        raise TruncatedFrameError("secret response details")

    monkeypatch.setattr("jarvis_local.cli.send_control_request", malformed)
    code = _control("status", "pipe", None)

    assert code != 0
    printed = capsys.readouterr().out
    assert "invalid control response" in printed
    assert "secret response details" not in printed


def test_the_existing_commands_still_parse() -> None:
    """The control commands were added beside `doctor` and `enroll`, not over
    them."""
    assert build_parser().parse_args(["doctor"]).command == "doctor"
    assert build_parser().parse_args(["enroll"]).device_label == "jarvis-local-agent"
    assert build_parser().parse_args(["node"]).command == "node"


def test_node_accepts_an_explicit_control_socket() -> None:
    arguments = build_parser().parse_args(["node", "--socket-path", "/run/jarvis/control.sock"])
    assert arguments.socket_path == Path("/run/jarvis/control.sock")
