"""What `jarvis status` says when there is nothing to say it to.

A background service that is not running is indistinguishable, at the
transport, from a missing file -- because that is literally what it is. The
CLI's one job beyond forwarding is to not pass that distinction on to whoever
typed the command. "No such file or directory" is true and useless.
"""

from __future__ import annotations

import os
import uuid

import pytest

from jarvis_local.cli import EXIT_SERVICE_UNAVAILABLE, build_parser, main


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
    # Defaulted rather than required: the name is a detail of the install, and
    # nobody should have to know it to ask how their agent is doing.
    assert arguments.pipe_name.startswith(r"\\.\pipe")


def test_the_existing_commands_still_parse() -> None:
    """The control commands were added beside `doctor` and `enroll`, not over
    them."""
    assert build_parser().parse_args(["doctor"]).command == "doctor"
    assert build_parser().parse_args(["enroll"]).device_label == "jarvis-local-agent"
