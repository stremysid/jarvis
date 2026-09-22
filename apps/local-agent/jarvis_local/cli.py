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
from jarvis_local.node import NodeConfigurationError, NodeSettings, run_node, run_serve
from jarvis_local.owner_passphrase import run_owner_passphrase
from jarvis_local.phone_enrollment import run_phone_enrollment
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

    enroll_phone = subcommands.add_parser(
        "enroll-phone",
        help="verify the enrolled device and bootstrap the owner's phone",
    )
    phone_mode = enroll_phone.add_mutually_exclusive_group()
    phone_mode.add_argument("--preflight", dest="phone_operation", action="store_const", const="preflight")
    phone_mode.add_argument("--status", dest="phone_operation", action="store_const", const="status")
    enroll_phone.set_defaults(phone_operation="begin")

    owner_passphrase = subcommands.add_parser(
        "owner-passphrase",
        help="create, rotate, or inspect the owner's spoken passphrase verifier",
    )
    passphrase_commands = owner_passphrase.add_subparsers(dest="owner_passphrase_operation", required=True)
    passphrase_commands.add_parser("status", help="report the active verifier version without revealing words")
    passphrase_commands.add_parser("generate", help="generate and display a new Worker-created phrase once")

    node = subcommands.add_parser("node", help="run the Linux home node in the foreground")
    node.add_argument("--socket-path", type=Path)

    # The Windows half of the same service. `ops/jarvis-boot.ps1` starts this
    # at logon: `node` refuses a non-Linux host and this one refuses anything
    # but Windows, so neither can quietly be the other.
    subcommands.add_parser("serve", help="run the background service in the foreground, on Windows")

    # What `serve` would refuse to start on, answered without starting it. The
    # boot script runs this before spawning the agent so that "the configuration
    # is wrong" is a different exit code from "it came up and then fell over".
    subcommands.add_parser("config", help="report whether the agent's configuration is usable")

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


def _config(config: JarvisLocalConfig) -> int:
    """Ask `NodeSettings` what it would refuse before anything is started.

    Deliberately not `doctor`: doctor also demands a well-formed cloud origin,
    which is a different repair from a missing path, and this has to have one
    meaning -- the caller's "the configuration is wrong" exit code. The single
    place both entry points agree is `NodeSettings.from_config`, so the answer
    comes from it rather than from a second copy of the rules.
    """
    missing = config.missing_names()
    if missing:
        for name in missing:
            print(f"missing: {name}")
        return EXIT_SERVICE_UNAVAILABLE
    try:
        # No `platform`, so this asks about the host it is running on, exactly
        # as the start it guards will.
        NodeSettings.from_config(config)
    except NodeConfigurationError as error:
        print(str(error))
        return EXIT_REFUSED
    print("configuration ready")
    return 0


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
    if arguments.command == "enroll-phone":
        return run_phone_enrollment(JarvisLocalConfig.from_environment(), arguments.phone_operation)
    if arguments.command == "owner-passphrase":
        return run_owner_passphrase(JarvisLocalConfig.from_environment(), arguments.owner_passphrase_operation)
    if arguments.command == "node":
        return run_node(JarvisLocalConfig.from_environment(), socket_path=arguments.socket_path)
    if arguments.command == "serve":
        return run_serve(JarvisLocalConfig.from_environment())
    if arguments.command == "config":
        return _config(JarvisLocalConfig.from_environment())
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
