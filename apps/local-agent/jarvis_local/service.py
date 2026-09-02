"""The background agent: replication, diagnostics, and the local command surface.

Effectful commands are gated here before they reach the cloud, not instead of
it. The cloud revalidates device signature, session evidence and policy
independently -- this check exists so an obviously illegitimate command never
leaves the machine.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from jarvis_local.transport.cli_protocol import (
    CONFIRMATION_REQUIRED,
    EFFECTFUL_COMMANDS,
    INTERACTIVE_LOCAL_SESSION_REQUIRED,
    LOCAL_ONLY_COMMANDS,
    OK,
    UNKNOWN_COMMAND,
    CliCommand,
    CliResponse,
    is_interactive_local_session,
)


class CommandHandler(Protocol):
    def __call__(self, command: CliCommand) -> CliResponse: ...


@dataclass
class LocalAgentService:
    """Routes CLI commands, refusing effectful ones from untrusted sessions."""

    handlers: dict[str, CommandHandler]

    def handle(self, command: CliCommand) -> CliResponse:
        if command.name not in EFFECTFUL_COMMANDS | LOCAL_ONLY_COMMANDS:
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

