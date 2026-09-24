"""`jarvis vault ...` is wired up and stays out of the other commands' way.

Two things are worth testing about a thin wrapper: that the commands exist and
route, and that adding them did not disturb the commands that were already
there -- `cli.py` is shared with another change landing at the same time.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from jarvis_local.cli import build_parser, main
from jarvis_local.vault.repository import VaultRepository
from tests.vault.conftest import PRINCIPAL, write_note


@pytest.fixture
def vault_cli_root(tmp_path: Path) -> Path:
    return tmp_path / "profile" / "Jarvis Vault"


@pytest.fixture
def environment(tmp_path: Path, vault_cli_root: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A complete, isolated environment: no real profile, no real archive.

    `JARVIS_VAULT_ROOT` is what makes this isolation real. Setting
    `USERPROFILE` alone does not: the known-folder resolver asks Windows,
    which answers with the live profile no matter what the environment says --
    and the first version of this fixture created a directory there.
    """
    archive = tmp_path / "archive.sqlite3"
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", str(archive))
    monkeypatch.setenv("JARVIS_PRINCIPAL_ID", PRINCIPAL)
    monkeypatch.setenv("JARVIS_VAULT_ROOT", str(vault_cli_root))
    (tmp_path / "profile").mkdir()
    return archive


@pytest.mark.skipif(sys.platform != "win32", reason="the guarded profile locations are Windows known folders")
def test_the_guard_against_touching_the_real_profile_is_actually_watching_something() -> None:
    """The guard must have a subject, or it passes for the wrong reason.

    `the_real_profile_is_left_alone` compares a set of real locations before
    and after every test. If that set were empty -- no `USERPROFILE`, no
    `LOCALAPPDATA` -- it would compare nothing to nothing and report success
    for the rest of its life. This asserts it has something to watch.
    """
    from tests.vault.conftest import _real_vault_locations

    watched = _real_vault_locations()
    assert len(watched) == 2
    assert watched[0].name == "Jarvis Vault"


def test_the_vault_subcommands_are_registered() -> None:
    parser = build_parser()
    for argv in (
        ["vault", "setup"],
        ["vault", "sync"],
        ["vault", "doctor"],
        ["vault", "search", "coffee"],
        ["vault", "show", "01k5d8s0m00000000000000001"],
    ):
        assert parser.parse_args(argv).command == "vault"


def test_adding_the_vault_group_left_the_existing_commands_alone() -> None:
    """The shared file's other commands still parse exactly as before."""
    parser = build_parser()
    assert parser.parse_args(["doctor"]).command == "doctor"
    assert parser.parse_args(["enroll"]).device_label == "jarvis-local-agent"
    for name in ("status", "run-once", "stop"):
        assert parser.parse_args([name]).command == name


def test_vault_with_no_action_is_refused() -> None:
    with pytest.raises(SystemExit):
        build_parser().parse_args(["vault"])


def test_missing_configuration_reports_names_and_never_values(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("JARVIS_ARCHIVE_PATH", raising=False)
    monkeypatch.delenv("JARVIS_PRINCIPAL_ID", raising=False)

    assert main(["vault", "sync"]) == 2
    assert capsys.readouterr().out.splitlines() == [
        "missing: JARVIS_ARCHIVE_PATH",
        "missing: JARVIS_PRINCIPAL_ID",
    ]


def test_sync_before_setup_says_what_to_do_next(
    environment: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["vault", "sync"]) == 4
    assert "jarvis vault setup" in capsys.readouterr().out


def test_the_vault_command_creates_no_directory_and_writes_no_permission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`jarvis vault` is a reader, so it must not be able to write an ACL.

    The `repair_permissions=False` argument is what guarantees that, so this
    works through `main` rather than asserting the argument was passed: a
    non-existent store is left non-existent, instead of the command manufacturing
    a directory tree and changing the permissions of everything on the way in --
    which is what it did while the `JARVIS_ALLOW_REAL_DACL` gate was briefly
    removed, and is why D12 must stay removed without that gate coming back as
    the mechanism.
    """
    archive = tmp_path / "profile" / "missing" / "archive.sqlite3"
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", str(archive))
    monkeypatch.setenv("JARVIS_PRINCIPAL_ID", PRINCIPAL)
    monkeypatch.setenv("JARVIS_VAULT_ROOT", str(tmp_path / "profile" / "Jarvis Vault"))

    exit_code = main(["vault", "sync"])

    assert exit_code != 0, "a store this command did not create cannot be read"
    assert not archive.parent.exists(), "the read-only opener created the store directory"
    assert not archive.exists(), "the read-only opener created the store file"
    assert "does not exist" in capsys.readouterr().out


def test_a_relative_archive_path_is_refused_rather_than_resolved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Two working directories would otherwise mean two different stores."""
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", "relative/archive.sqlite3")
    monkeypatch.setenv("JARVIS_PRINCIPAL_ID", PRINCIPAL)
    monkeypatch.setenv("JARVIS_VAULT_ROOT", str(tmp_path / "Jarvis Vault"))

    assert main(["vault", "sync"]) == 2
    assert "must be an absolute path" in capsys.readouterr().out


def test_setup_then_sync_then_search_round_trips(
    environment: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["vault", "setup"]) == 0
    capsys.readouterr()

    root = tmp_path / "profile" / "Jarvis Vault"
    write_note(root, "coffee.md", "# Coffee\n\nI like zarquonberry in my coffee.")

    assert main(["vault", "sync"]) == 0
    sync_output = capsys.readouterr().out
    assert "appended: 1" in sync_output

    assert main(["vault", "search", "zarquonberry"]) == 0
    search_output = capsys.readouterr().out
    assert "Coffee" in search_output
    assert "no matching notes" not in search_output


def test_search_output_carries_no_path(
    environment: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    main(["vault", "setup"])
    root = tmp_path / "profile" / "Jarvis Vault"
    write_note(root, "private/inner/plan.md", "# Plan\n\nzarquonberry")
    main(["vault", "sync"])
    capsys.readouterr()

    main(["vault", "search", "zarquonberry"])
    output = capsys.readouterr().out

    assert "private" not in output
    assert "plan.md" not in output
    assert str(root) not in output


def test_show_prints_the_note_for_an_id_from_search(
    environment: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    main(["vault", "setup"])
    write_note(tmp_path / "profile" / "Jarvis Vault", "coffee.md", "# Coffee\n\nzarquonberry")
    main(["vault", "sync"])
    capsys.readouterr()

    main(["vault", "search", "zarquonberry"])
    document_id = capsys.readouterr().out.split()[0]

    assert main(["vault", "show", document_id]) == 0
    assert "zarquonberry" in capsys.readouterr().out


def test_show_for_an_unknown_id_refuses(environment: Path, capsys: pytest.CaptureFixture[str]) -> None:
    main(["vault", "setup"])
    capsys.readouterr()
    assert main(["vault", "show", "01k5d8s0m0000000000000zzzz"]) == 1
    assert "no such note" in capsys.readouterr().out


def test_doctor_reports_readiness_without_a_path(
    environment: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    main(["vault", "setup"])
    capsys.readouterr()

    main(["vault", "doctor"])
    output = capsys.readouterr().out

    assert "binding: vault_bound" in output
    assert "\\" not in output


def test_setup_is_recorded_in_the_archive_database(environment: Path, tmp_path: Path) -> None:
    assert main(["vault", "setup"]) == 0

    repository = VaultRepository.open(environment)
    try:
        binding = repository.binding_for(PRINCIPAL)
        assert binding is not None
        assert Path(binding.root_path) == tmp_path / "profile" / "Jarvis Vault"
    finally:
        repository.close()
