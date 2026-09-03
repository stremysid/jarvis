"""Vault readiness, reported without disclosing anything.

Follows `doctor.py`'s contract exactly: the same four exit codes, and output
built only from names that are already public. The vault adds one hazard
`doctor.py` does not have -- its subject is a filesystem location -- so the
rule here is stricter than "no secrets": **no check may put a path in a line.**
A diagnostic is the output most likely to be pasted into an issue, a log, or a
release evidence bundle, which is exactly the boundary the plan says raw paths
never cross.

The checks are chosen to answer the questions that actually go wrong:

* is a vault bound at all, or did setup refuse the root;
* does the recorded root still resolve to the same object -- which is the only
  way stage one can notice a root that was moved, replaced, or junctioned
  after binding, since there is no retained handle to prevent it;
* is Obsidian installed, because a vault the owner cannot open is not a
  memory system;
* does each head still match what is on disk, which is how a crawl that has
  not run, or has been failing silently, becomes visible.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from jarvis_local.archive.content_store import canonical_content_hash, normalize_nfc
from jarvis_local.doctor import (
    EXIT_DEPENDENCY_FAILURE,
    EXIT_READY,
    DoctorReport,
)
from jarvis_local.vault import paths
from jarvis_local.vault.models import VaultNoteOperationV1
from jarvis_local.vault.reconciliation import MAX_FILE_BYTES, LocalFileReader
from jarvis_local.vault.repository import VaultRepository
from jarvis_local.vault.setup import LocalRootProbe, RootProbe

#: Where a signed Obsidian install is expected. Both are checked because a
#: per-user install lands in LOCALAPPDATA and a machine-wide one in Program
#: Files, and reporting "not installed" for the wrong one is a false alarm.
OBSIDIAN_RELATIVE_LOCATIONS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("ProgramFiles", ("Obsidian", "Obsidian.exe")),
    ("LOCALAPPDATA", ("Obsidian", "Obsidian.exe")),
    ("LOCALAPPDATA", ("Programs", "Obsidian", "Obsidian.exe")),
)


class VaultCheckCode(StrEnum):
    """Closed codes. A line prints one of these and a check name, nothing else."""

    BOUND = "vault_bound"
    UNBOUND = "vault_unbound"
    ROOT_IDENTITY_MATCHES = "vault_root_identity_matches"
    ROOT_MOVED = "vault_root_moved"
    ROOT_MISSING = "vault_root_missing"
    ROOT_IDENTITY_UNAVAILABLE = "vault_root_identity_unavailable"
    OBSIDIAN_INSTALLED = "vault_obsidian_installed"
    OBSIDIAN_NOT_FOUND = "vault_obsidian_not_found"
    HEADS_CONSISTENT = "vault_heads_consistent"
    HEADS_STALE = "vault_heads_stale"
    HEADS_UNREADABLE = "vault_heads_unreadable"


@dataclass(frozen=True, slots=True)
class VaultCheck:
    name: str
    code: VaultCheckCode
    ok: bool
    #: A count, never a name. "3 heads differ" is actionable; naming which
    #: three would put note titles in a diagnostic.
    count: int = 0

    def line(self) -> str:
        suffix = f" ({self.count})" if self.count else ""
        return f"{self.name}: {self.code}{suffix}"


def obsidian_locations(environment: dict[str, str]) -> tuple[Path, ...]:
    found: list[Path] = []
    for variable, relative in OBSIDIAN_RELATIVE_LOCATIONS:
        base = environment.get(variable, "").strip()
        if base:
            found.append(Path(base).joinpath(*relative))
    return tuple(found)


def obsidian_check(environment: dict[str, str] | None = None) -> VaultCheck:
    """Whether a signed Obsidian executable is present.

    Presence only. The plan's publisher and signature verification needs the
    Authenticode tooling that ships with the native work, and asserting
    "signed" from a file's existence would be a claim this code cannot make.
    """
    env = dict(os.environ if environment is None else environment)
    if sys.platform != "win32" and not obsidian_locations(env):
        return VaultCheck("obsidian", VaultCheckCode.OBSIDIAN_NOT_FOUND, ok=False)
    for candidate in obsidian_locations(env):
        if candidate.is_file():
            return VaultCheck("obsidian", VaultCheckCode.OBSIDIAN_INSTALLED, ok=True)
    return VaultCheck("obsidian", VaultCheckCode.OBSIDIAN_NOT_FOUND, ok=False)


def run_vault_diagnostics(
    repository: VaultRepository,
    principal_id: str,
    *,
    environment: dict[str, str] | None = None,
    probe: RootProbe | None = None,
    reader: LocalFileReader | None = None,
) -> tuple[VaultCheck, ...]:
    """Every vault check, in a fixed order so output is comparable run to run."""
    env = dict(os.environ if environment is None else environment)
    root_probe: RootProbe = probe or LocalRootProbe()
    file_reader = reader or LocalFileReader()

    binding = repository.binding_for(principal_id)
    if binding is None:
        return (
            VaultCheck("binding", VaultCheckCode.UNBOUND, ok=False),
            obsidian_check(env),
        )

    checks: list[VaultCheck] = [VaultCheck("binding", VaultCheckCode.BOUND, ok=True)]
    checks.append(_root_identity_check(binding.root, binding.root_file_id, root_probe))
    checks.append(obsidian_check(env))
    checks.append(_head_consistency_check(repository, binding.vault_id, binding.root, file_reader))
    return tuple(checks)


def _root_identity_check(root: Path, recorded_identity: str | None, probe: RootProbe) -> VaultCheck:
    if not probe.exists(root):
        return VaultCheck("root", VaultCheckCode.ROOT_MISSING, ok=False)
    if paths.any_reparse_point(root):
        # A reparse point where there was none at binding time means the root
        # now resolves somewhere else, which is precisely the substitution a
        # retained handle would have made impossible.
        return VaultCheck("root", VaultCheckCode.ROOT_MOVED, ok=False)
    current = probe.file_identity(root)
    if recorded_identity is None or current is None:
        return VaultCheck("root", VaultCheckCode.ROOT_IDENTITY_UNAVAILABLE, ok=False)
    if current != recorded_identity:
        return VaultCheck("root", VaultCheckCode.ROOT_MOVED, ok=False)
    return VaultCheck("root", VaultCheckCode.ROOT_IDENTITY_MATCHES, ok=True)


def _head_consistency_check(
    repository: VaultRepository,
    vault_id: str,
    root: Path,
    reader: LocalFileReader,
) -> VaultCheck:
    """How many recorded heads disagree with the bytes on disk.

    A head that differs is not corruption -- it is usually just an edit since
    the last crawl. It is reported because the same signal covers the case
    that is a problem: a crawl that has stopped running, which otherwise looks
    identical to a vault nobody has touched.
    """
    stale = 0
    unreadable = 0
    for head in repository.current_heads(vault_id):
        relative = repository.document_location(head.document_id)
        if relative is None:  # pragma: no cover - a head always has a document
            continue
        absolute = root / relative
        exists = absolute.is_file()
        if head.operation is VaultNoteOperationV1.TOMBSTONED:
            # A tombstoned note whose file is back is a difference too: the
            # crawl has not yet recorded the resurrection.
            stale += 1 if exists else 0
            continue
        if not exists:
            stale += 1
            continue
        stable = reader.read_stable(absolute, max_bytes=MAX_FILE_BYTES)
        if stable is None:
            unreadable += 1
            continue
        try:
            text = stable.data.decode("utf-8")
        except UnicodeDecodeError:
            unreadable += 1
            continue
        if canonical_content_hash(normalize_nfc(text)) != head.content_hash:
            stale += 1

    if unreadable:
        return VaultCheck("heads", VaultCheckCode.HEADS_UNREADABLE, ok=False, count=unreadable)
    if stale:
        return VaultCheck("heads", VaultCheckCode.HEADS_STALE, ok=False, count=stale)
    return VaultCheck("heads", VaultCheckCode.HEADS_CONSISTENT, ok=True)


def vault_report(checks: Sequence[VaultCheck]) -> DoctorReport:
    """`doctor.py`'s report shape, so the two can be printed side by side.

    A failed vault check is a dependency failure rather than a configuration
    error: the configuration may be perfectly valid and the vault still
    unbound, missing, or behind.
    """
    lines = tuple(check.line() for check in checks)
    if all(check.ok for check in checks):
        return DoctorReport(EXIT_READY, lines or ("ready",))
    return DoctorReport(EXIT_DEPENDENCY_FAILURE, lines)
