"""`jarvis config` answers "would `serve` start?" -- including about permissions.

The boot script runs this before it spawns the agent, so a wrong answer here is
the difference between a service that starts and a service that fails with its
output going nowhere a person is reading. It had no test at all before this file.

Exit codes are the contract:

* 0 -- the configuration is usable.
* 4 -- a required name is missing (`EXIT_SERVICE_UNAVAILABLE`, the code
  `jarvis doctor` already uses for a failed dependency).
* 1 -- `NodeSettings` refused the configuration (`EXIT_REFUSED`).
* 6 -- the store's location or permissions are wrong. Its own code because the
  repair is different from every other failure: an elevated run, or a change to
  where the store lives.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from jarvis_local.archive import store_permissions
from jarvis_local.archive.store_permissions import StoreDaclRefusedError, UnsafeStorePathError
from jarvis_local.cli import main
from jarvis_local.config import JarvisLocalConfig


def _usable_environment(tmp_path: Path) -> dict[str, str]:
    """A complete configuration whose store is inside the permitted location.

    The permitted location is patched per test rather than assumed, so these run
    the real allowlist on whatever machine they are executed on.
    """
    return {
        "JARVIS_CLOUD_BASE_URL": "https://gateway.example",
        "JARVIS_DEVICE_ID": "device-1",
        "JARVIS_PRINCIPAL_ID": "principal-1",
        "JARVIS_DEVICE_KEY_PATH": os.fspath(tmp_path / "keys" / "device.key"),
        "JARVIS_ARCHIVE_PATH": os.fspath(tmp_path / "archive.sqlite3"),
        "JARVIS_MEMORY_PATH": os.fspath(tmp_path / "memory.sqlite3"),
    }


def _apply(monkeypatch: pytest.MonkeyPatch, values: dict[str, str]) -> None:
    for name in (
        "JARVIS_CLOUD_BASE_URL",
        "JARVIS_DEVICE_ID",
        "JARVIS_PRINCIPAL_ID",
        "JARVIS_DEVICE_KEY_PATH",
        "JARVIS_ARCHIVE_PATH",
        "JARVIS_MEMORY_PATH",
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in values.items():
        monkeypatch.setenv(name, value)


def test_a_usable_configuration_reports_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path)
    _apply(monkeypatch, _usable_environment(tmp_path))

    assert main(["config"]) == 0
    # The store-roots line above it is asserted in its own test; here the point
    # is only that a usable configuration reports ready at all and that ready is
    # the line the boot script's grep sees last.
    assert capsys.readouterr().out.splitlines()[-1] == "configuration ready"


def test_a_usable_configuration_prints_the_store_roots_before_the_ready_line(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The roots have to reach `boot.log`, and only the success path writes it.

    `jarvis-boot.ps1` copies this command's output into `boot.log` line by line,
    so the summary has to be printed *by the command that succeeds* -- the run
    that fails is the one whose output goes nowhere, and a warning about an
    Administrators-owned root is exactly the thing a reader needs to have on the
    run that worked. Printed before `configuration ready` so the last line stays
    the sentinel the boot script greps for.
    """
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path)
    _apply(monkeypatch, _usable_environment(tmp_path))

    assert main(["config"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[-1] == "configuration ready", lines
    assert lines[0].startswith("store roots: "), lines
    assert os.fspath(tmp_path) in lines[0], lines


def test_a_missing_name_reports_its_name_and_the_dependency_exit_code(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    values = _usable_environment(tmp_path)
    del values["JARVIS_ARCHIVE_PATH"]
    _apply(monkeypatch, values)

    assert main(["config"]) == 4
    assert "missing: JARVIS_ARCHIVE_PATH" in capsys.readouterr().out


def test_a_store_outside_the_permitted_location_gets_its_own_exit_code(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """One location is permitted, and a store anywhere else is refused here.

    Refused with 6 rather than 1 so a caller can tell "your paths are wrong"
    from "your store is somewhere it must not be" without reading English.
    """
    permitted = tmp_path / "Jarvis"
    permitted.mkdir()
    elsewhere = tmp_path / "Documents"
    elsewhere.mkdir()
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: permitted)
    _apply(
        monkeypatch,
        _usable_environment(tmp_path)
        | {
            "JARVIS_ARCHIVE_PATH": os.fspath(elsewhere / "archive.sqlite3"),
            "JARVIS_MEMORY_PATH": os.fspath(elsewhere / "memory.sqlite3"),
        },
    )

    assert main(["config"]) == 6
    assert "outside the only permitted store location" in capsys.readouterr().out


def test_a_store_whose_permissions_cannot_be_written_gets_the_same_exit_code(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The Administrators-owned store, which is the failure the code exists for.

    Raised through the same call `_config` makes, so this pins the mapping from
    the exception to exit 6 rather than a mock of the mapping.
    """
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path)
    _apply(monkeypatch, _usable_environment(tmp_path))

    from jarvis_local import cli

    monkeypatch.setattr(cli, "NodeSettings", _RefusingSettings)

    assert main(["config"]) == 6
    assert "cannot set the permissions of the store" in capsys.readouterr().out


class _RefusingSettings:
    """`NodeSettings.from_config` that raises the store-permission failure.

    Written as a class so it substitutes for the real one at the name `_config`
    uses, which is the seam that decides which exit code the caller receives.
    """

    @classmethod
    def from_config(cls, _config: JarvisLocalConfig) -> None:
        raise StoreDaclRefusedError("cannot set the permissions of the store")


def test_a_path_the_guard_refuses_gets_the_same_exit_code_and_sentence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`UnsafeStorePathError` is mapped here, not folded into the generic refusal.

    It is a `RuntimeError`, so without its own arm it leaves the `NodeSettings`
    branch and reaches the caller as an unhandled traceback -- and its sentence,
    which names the path the guard refused, is the only part of it a reader can
    act on. Reported with 6 for the same reason a refused DACL is: the repair is
    "move the store", not "fix your configuration".
    """
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path)
    _apply(monkeypatch, _usable_environment(tmp_path))

    from jarvis_local import cli

    monkeypatch.setattr(cli, "NodeSettings", _RefusingPathSettings)

    assert main(["config"]) == 6
    assert "refusing a system or account root" in capsys.readouterr().out


class _RefusingPathSettings:
    """`NodeSettings.from_config` that raises the guard's own refusal."""

    @classmethod
    def from_config(cls, _config: JarvisLocalConfig) -> None:
        raise UnsafeStorePathError("refusing a system or account root: /profile")
