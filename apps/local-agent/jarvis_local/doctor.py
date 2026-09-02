"""`jarvis doctor` -- report readiness without disclosing anything.

Exit codes are fixed by the foundation design and are part of the contract:

    0  ready
    2  missing credentials
    3  invalid configuration
    4  failed dependency check

Output names variables only. A value, a prefix of one, or any hash derived
from one would all be disclosures, so the report is built exclusively from
identifiers that are already public in `.env.example`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from jarvis_local.config import JarvisLocalConfig

EXIT_READY = 0
EXIT_MISSING_CREDENTIALS = 2
EXIT_INVALID_CONFIGURATION = 3
EXIT_DEPENDENCY_FAILURE = 4


@dataclass(frozen=True, slots=True)
class DoctorReport:
    exit_code: int
    lines: tuple[str, ...]


def dependencies_ready() -> bool:
    """Whether the runtime pieces the agent needs are importable.

    Kept deliberately narrow: this answers "can the agent start", not "is the
    machine healthy". Task 7 extends it once the ONNX stack is pinned.
    """
    try:
        import sqlite3  # noqa: F401

        from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: F401
            Ed25519PrivateKey,
        )
    except ImportError:
        return False
    return True


def run_doctor(
    config: JarvisLocalConfig,
    dependencies_ready: Callable[[], bool] = dependencies_ready,
) -> DoctorReport:
    # Ordered deliberately: a missing name is reported even when another value
    # is also malformed, so one typo cannot mask an absent variable.
    missing = config.missing_names()
    if missing:
        return DoctorReport(EXIT_MISSING_CREDENTIALS, tuple(f"missing: {name}" for name in missing))
    if not config.is_valid():
        return DoctorReport(EXIT_INVALID_CONFIGURATION, ("invalid configuration",))
    if not dependencies_ready():
        return DoctorReport(EXIT_DEPENDENCY_FAILURE, ("dependency check failed",))
    return DoctorReport(EXIT_READY, ("ready",))
