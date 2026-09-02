"""`jarvis` command surface.

Only locally-answerable commands live here. Anything with an external effect
(`jarvis call-me`, enrollment approval) must go through the background service
over the SID-restricted named pipe and be revalidated by the cloud policy
service, so the CLI is never a privileged bypass. Those arrive with Task 9.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import DeviceKeyStore, WindowsCng
from jarvis_local.crypto.dpapi import WindowsDpapi
from jarvis_local.doctor import run_doctor
from jarvis_local.enrollment import bootstrap_metadata_hash, enrollment_material


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="jarvis", description="Jarvis local agent")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("doctor", help="report readiness without disclosing configuration values")

    enroll = subcommands.add_parser(
        "enroll",
        help="print this device's public enrollment material (no secrets)",
    )
    enroll.add_argument("--device-label", default="jarvis-local-agent")
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

    store = DeviceKeyStore(Path(key_path), WindowsCng(), WindowsDpapi())
    key = store.load_or_create()
    material = enrollment_material(key)  # type: ignore[arg-type]

    print(f"device_id            {device_id}")
    print(f"algorithm            {material.algorithm}")
    print(f"key_generation       {material.key_generation}")
    print(f"public_key_base64    {material.public_key_base64}")
    print(f"key_fingerprint      {material.key_fingerprint}")
    print(f"bootstrap_metadata   {bootstrap_metadata_hash(device_label, device_id)}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "doctor":
        return _doctor()
    if arguments.command == "enroll":
        return _enroll(JarvisLocalConfig.from_environment(), arguments.device_label)
    # argparse enforces `required=True`, so this is unreachable in practice.
    _unreachable(arguments.command)
    return 1


if __name__ == "__main__":
    sys.exit(main())
