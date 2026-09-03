"""Diagnostics say what is wrong without saying where anything is.

A diagnostic is the output most likely to be pasted into an issue or a release
evidence bundle, so the strongest test here is the one asserting that no line
carries a path.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jarvis_local.doctor import EXIT_DEPENDENCY_FAILURE, EXIT_READY
from jarvis_local.vault.diagnostics import (
    VaultCheckCode,
    obsidian_check,
    run_vault_diagnostics,
    vault_report,
)
from jarvis_local.vault.reconciliation import VaultReconciler
from jarvis_local.vault.repository import VaultBinding, VaultRepository
from jarvis_local.vault.setup import LocalRootProbe, VolumeFacts
from tests.vault.conftest import PRINCIPAL, write_note


class StubProbe(LocalRootProbe):
    """The real probe with one answer overridden, so only one rule moves."""

    def __init__(self, *, identity: str | None = "vol:1", present: bool = True) -> None:
        self._identity = identity
        self._present = present

    def exists(self, path: Path) -> bool:
        return self._present and path.exists()

    def file_identity(self, path: Path) -> str | None:
        return self._identity

    def volume_facts(self, path: Path) -> VolumeFacts:
        return VolumeFacts(drive_type=3, file_system="NTFS", volume_serial=7)


def codes(checks: object) -> dict[str, str]:
    return {check.name: str(check.code) for check in checks}  # type: ignore[attr-defined]


def test_an_unbound_vault_is_reported_as_unbound(repository: VaultRepository) -> None:
    checks = run_vault_diagnostics(repository, PRINCIPAL, environment={})
    assert codes(checks)["binding"] == str(VaultCheckCode.UNBOUND)
    assert vault_report(checks).exit_code == EXIT_DEPENDENCY_FAILURE


def test_a_bound_vault_with_a_matching_root_and_consistent_heads_is_ready(
    repository: VaultRepository, vault_root: Path, tmp_path: Path
) -> None:
    obsidian = tmp_path / "programs" / "Obsidian" / "Obsidian.exe"
    obsidian.parent.mkdir(parents=True)
    obsidian.write_bytes(b"MZ")
    identity = LocalRootProbe().file_identity(vault_root)
    binding = repository.record_binding(
        VaultBinding(
            vault_id="01k5d8s0m00000000000000001",
            principal_id=PRINCIPAL,
            root_path=str(vault_root),
            root_file_id=identity,
        )
    )
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso")
    VaultReconciler(repository, binding).run()

    checks = run_vault_diagnostics(
        repository, PRINCIPAL, environment={"ProgramFiles": str(tmp_path / "programs")}
    )

    assert codes(checks) == {
        "binding": str(VaultCheckCode.BOUND),
        "root": str(VaultCheckCode.ROOT_IDENTITY_MATCHES),
        "obsidian": str(VaultCheckCode.OBSIDIAN_INSTALLED),
        "heads": str(VaultCheckCode.HEADS_CONSISTENT),
    }
    assert vault_report(checks).exit_code == EXIT_READY


def test_a_root_that_no_longer_resolves_to_the_same_object_is_reported_as_moved(
    repository: VaultRepository, vault_root: Path
) -> None:
    """Stage one cannot prevent this, so it must at least see it.

    The recorded identity is from binding time; the probe reports a different
    one now, which is what a replaced or re-created root looks like.
    """
    repository.record_binding(
        VaultBinding(
            vault_id="01k5d8s0m00000000000000001",
            principal_id=PRINCIPAL,
            root_path=str(vault_root),
            root_file_id="the-identity-recorded-at-binding-time",
        )
    )

    checks = run_vault_diagnostics(repository, PRINCIPAL, environment={}, probe=StubProbe())

    assert codes(checks)["root"] == str(VaultCheckCode.ROOT_MOVED)


def test_a_missing_root_is_reported(repository: VaultRepository, tmp_path: Path) -> None:
    repository.record_binding(
        VaultBinding(
            vault_id="01k5d8s0m00000000000000001",
            principal_id=PRINCIPAL,
            root_path=str(tmp_path / "never-created"),
            root_file_id="vol:1",
        )
    )
    checks = run_vault_diagnostics(repository, PRINCIPAL, environment={})
    assert codes(checks)["root"] == str(VaultCheckCode.ROOT_MISSING)


def test_a_root_with_no_recorded_identity_is_reported_as_unavailable_not_as_matching(
    repository: VaultRepository, vault_root: Path
) -> None:
    """An unanswerable question is not a passing answer.

    Reporting "matches" when nothing was recorded would turn a check that
    never ran into one that looks like it passed.
    """
    repository.record_binding(
        VaultBinding(
            vault_id="01k5d8s0m00000000000000001",
            principal_id=PRINCIPAL,
            root_path=str(vault_root),
            root_file_id=None,
        )
    )
    checks = run_vault_diagnostics(repository, PRINCIPAL, environment={})
    assert codes(checks)["root"] == str(VaultCheckCode.ROOT_IDENTITY_UNAVAILABLE)


def test_an_edited_note_makes_the_heads_stale(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """The same signal covers a crawl that has silently stopped running."""
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso")
    VaultReconciler(repository, binding).run()
    write_note(vault_root, "coffee.md", "# Coffee\n\ncortado")

    checks = run_vault_diagnostics(repository, PRINCIPAL, environment={})

    stale = next(check for check in checks if check.name == "heads")
    assert stale.code is VaultCheckCode.HEADS_STALE
    assert stale.count == 1


def test_a_deleted_note_makes_the_heads_stale(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso")
    VaultReconciler(repository, binding).run()
    (vault_root / "coffee.md").unlink()

    checks = run_vault_diagnostics(repository, PRINCIPAL, environment={})
    stale = next(check for check in checks if check.name == "heads")
    assert stale.code is VaultCheckCode.HEADS_STALE


def test_obsidian_is_reported_as_missing_when_it_is_not_installed(tmp_path: Path) -> None:
    check = obsidian_check({"ProgramFiles": str(tmp_path / "nothing-here")})
    assert check.code is VaultCheckCode.OBSIDIAN_NOT_FOUND
    assert not check.ok


def test_obsidian_is_found_in_a_per_user_install(tmp_path: Path) -> None:
    executable = tmp_path / "local" / "Programs" / "Obsidian" / "Obsidian.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"MZ")
    assert obsidian_check({"LOCALAPPDATA": str(tmp_path / "local")}).code is VaultCheckCode.OBSIDIAN_INSTALLED


def test_no_diagnostic_line_carries_a_path(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """The rule this module exists to keep, asserted against every line.

    The vault root is a deep tmp_path with several distinctive components, and
    the note has a distinctive name; none of it may appear.
    """
    write_note(vault_root, "a very distinctive filename.md", "# Heading\n\nbody")
    VaultReconciler(repository, binding).run()
    (vault_root / "a very distinctive filename.md").unlink()

    report = vault_report(run_vault_diagnostics(repository, PRINCIPAL, environment={}))
    joined = "\n".join(report.lines)

    assert str(vault_root) not in joined
    assert "distinctive" not in joined
    assert "\\" not in joined
    assert "/" not in joined
    assert ".md" not in joined


def test_a_check_reports_a_count_rather_than_naming_anything(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    for index in range(3):
        write_note(vault_root, f"secret-{index}.md", f"# Secret {index}\n\nbody")
    VaultReconciler(repository, binding).run()
    for index in range(3):
        (vault_root / f"secret-{index}.md").unlink()

    lines = vault_report(run_vault_diagnostics(repository, PRINCIPAL, environment={})).lines

    assert "heads: vault_heads_stale (3)" in lines
    assert not any("secret" in line for line in lines)


@pytest.mark.parametrize("code", list(VaultCheckCode))
def test_every_check_code_is_a_closed_lowercase_token(code: VaultCheckCode) -> None:
    assert str(code) == str(code).lower()
    assert " " not in str(code)
    assert str(code).startswith("vault_")
