"""`jarvis` command surface.

Only locally-answerable commands live here. Anything with an external effect
(`jarvis call-me`, enrollment) must go through the background service over the
SID-restricted named pipe and be revalidated by the cloud policy service, so
the CLI is never a privileged bypass. Those arrive with Task 9.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from jarvis_local.config import JarvisLocalConfig
from jarvis_local.doctor import run_doctor


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="jarvis", description="Jarvis local agent")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("doctor", help="report readiness without disclosing configuration values")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "doctor":
        report = run_doctor(JarvisLocalConfig.from_environment())
        for line in report.lines:
            print(line)
        return report.exit_code
    # argparse enforces `required=True`, so this is unreachable in practice.
    raise AssertionError(f"unhandled command: {arguments.command}")


if __name__ == "__main__":
    sys.exit(main())
