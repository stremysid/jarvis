"""`jarvis` command surface.

The foreground `node` command owns the Linux memory service. Control commands
reach that process through an owner-only Unix socket on Linux and the existing
SID-restricted named pipe on Windows. Anything with an external effect
(`jarvis call-me`, enrollment approval) must still be revalidated by the cloud
policy service, so the CLI is never a privileged bypass. Those arrive later.

The service-control commands below are the thin half of that channel. They carry
no logic: they put a command on the channel, print what comes back, and turn
the answer into an exit code. The one thing they do add is a sentence for the
case the transport cannot distinguish -- a service that is not running looks
like a missing file, and printing that errno at someone who typed
`jarvis status` tells them nothing about what to do next.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.doctor import run_doctor
from jarvis_local.enrollment import bootstrap_metadata_hash, enrollment_material
from jarvis_local.node import run_node
from jarvis_local.transport.cli_protocol import OK, QUEUED, CliCommand
from jarvis_local.transport.pipe_server import (
    DEFAULT_PIPE_NAME,
    ControlProtocolError,
    ServiceNotRunningError,
    send_control_request,
)
from jarvis_local.transport.unix_socket import send_unix_control_request
from jarvis_local.vault.cli_commands import VAULT_COMMAND, add_vault_subcommands, run_vault_command

#: The service is a dependency like any other, so a missing one reports the
#: code `jarvis doctor` already uses for a failed dependency check.
EXIT_SERVICE_UNAVAILABLE = 4
EXIT_REFUSED = 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="jarvis", description="Jarvis local agent")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("doctor", help="report readiness without disclosing configuration values")

    enroll = subcommands.add_parser(
        "enroll",
        help="print this device's public enrollment material (no secrets)",
    )
    enroll.add_argument("--device-label", default="jarvis-local-agent")

    node = subcommands.add_parser("node", help="run the Linux home node in the foreground")
    node.add_argument("--socket-path", type=Path)

    for name, description in (
        ("status", "report what the background service has been doing"),
        ("run-once", "ask the background service to run a cycle now"),
        ("stop", "ask the background service to finish its cycle and stop"),
    ):
        control = subcommands.add_parser(name, help=description)
        endpoint = control.add_mutually_exclusive_group()
        endpoint.add_argument("--pipe-name")
        endpoint.add_argument("--socket-path", type=Path)

    retry = subcommands.add_parser(
        "retry-quarantined",
        help="clear one fact's projection quarantine and request a new cycle",
    )
    retry.add_argument("fact_id")
    endpoint = retry.add_mutually_exclusive_group()
    endpoint.add_argument("--pipe-name")
    endpoint.add_argument("--socket-path", type=Path)

    add_vault_subcommands(subcommands)
    return parser


def _unreachable(command: str) -> None:
    raise AssertionError(f"unhandled command: {command}")


def _doctor() -> int:
    report = run_doctor(JarvisLocalConfig.from_environment())
    for line in report.lines:
        print(line)
    return report.exit_code


def _enroll(config: JarvisLocalConfig, device_label: str) -> int:
    """Print what the cloud needs to trust this device.

    Creates the key on first run. Nothing private is printed: the private half
    is sealed on disk and only the public key and its fingerprint are shown.
    """
    key_path = config.environment.get("JARVIS_DEVICE_KEY_PATH", "").strip()
    device_id = config.environment.get("JARVIS_DEVICE_ID", "").strip()
    if not key_path or not device_id:
        print("missing: JARVIS_DEVICE_KEY_PATH")
        print("missing: JARVIS_DEVICE_ID")
        return 2

    store = platform_device_key_store(Path(key_path))
    key = store.load_or_create()
    material = enrollment_material(key)  # type: ignore[arg-type]

    print(f"device_id            {device_id}")
    print(f"algorithm            {material.algorithm}")
    print(f"key_generation       {material.key_generation}")
    print(f"public_key_base64    {material.public_key_base64}")
    print(f"key_fingerprint      {material.key_fingerprint}")
    print(f"bootstrap_metadata   {bootstrap_metadata_hash(device_label, device_id)}")
    return 0


CONTROL_SUBCOMMANDS: frozenset[str] = frozenset({"status", "run-once", "stop", "retry-quarantined"})


def _control(
    name: str,
    pipe_name: str | None,
    socket_path: Path | None,
    arguments: dict[str, object] | None = None,
) -> int:
    command = CliCommand(name, arguments or {})
    try:
        if pipe_name is not None:
            response = send_control_request(command, pipe_name)
        elif socket_path is not None or os.name != "nt":
            response = send_unix_control_request(command, socket_path)
        else:
            response = send_control_request(command, DEFAULT_PIPE_NAME)
    except ServiceNotRunningError:
        # Deliberately not the OS error. "No such file" is true and useless.
        print("the Jarvis background service is not running on this machine")
        return EXIT_SERVICE_UNAVAILABLE
    except ControlProtocolError:
        print("the Jarvis background service returned an invalid control response")
        return EXIT_REFUSED
    for line in response.lines:
        print(line)
    if response.code not in {OK, QUEUED}:
        print(response.code)
        return EXIT_REFUSED
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "doctor":
        return _doctor()
    if arguments.command == "enroll":
        return _enroll(JarvisLocalConfig.from_environment(), arguments.device_label)
    if arguments.command == "node":
        return run_node(JarvisLocalConfig.from_environment(), socket_path=arguments.socket_path)
    if arguments.command in CONTROL_SUBCOMMANDS:
        control_arguments = {"fact_id": arguments.fact_id} if arguments.command == "retry-quarantined" else None
        return _control(arguments.command, arguments.pipe_name, arguments.socket_path, control_arguments)
    if arguments.command == VAULT_COMMAND:
        return run_vault_command(arguments)
    # argparse enforces `required=True`, so this is unreachable in practice.
    _unreachable(arguments.command)
    return 1


if __name__ == "__main__":
    sys.exit(main())
