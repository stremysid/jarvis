"""The owner's archived conversation and memory remain owner-readable only."""

from __future__ import annotations

import os
import sqlite3
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import pytest

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.archive.database import connect
from jarvis_local.memory.facts import FactRepository


class ClosableStore(Protocol):
    connection: sqlite3.Connection

    def close(self) -> None: ...


POSIX_ONLY = pytest.mark.skipif(os.name != "posix", reason="POSIX permission semantics")


@POSIX_ONLY
@pytest.mark.parametrize("open_store", [ArchiveRepository.open, FactRepository.open])
def test_store_and_live_wal_files_ignore_a_permissive_umask(
    tmp_path: Path,
    open_store: Callable[[Path], ClosableStore],
) -> None:
    database_path = tmp_path / "state" / "store.sqlite3"
    previous = os.umask(0o022)
    try:
        store = open_store(database_path)
        store.connection.execute("CREATE TABLE permission_probe (value TEXT)")
        store.connection.execute("INSERT INTO permission_probe VALUES ('private')")
        files = [database_path, Path(f"{database_path}-wal"), Path(f"{database_path}-shm")]
        assert all(path.exists() for path in files)
        assert {stat.S_IMODE(path.stat().st_mode) for path in files} == {0o600}
    finally:
        os.umask(previous)
        if "store" in locals():
            store.close()


@POSIX_ONLY
def test_opening_an_existing_store_repairs_group_and_world_access(tmp_path: Path) -> None:
    database_path = tmp_path / "store.sqlite3"
    sqlite3.connect(database_path).close()
    database_path.chmod(0o644)

    connection = connect(database_path)
    try:
        assert stat.S_IMODE(database_path.stat().st_mode) == 0o600
    finally:
        connection.close()


@POSIX_ONLY
def test_store_open_refuses_a_symbolic_link(tmp_path: Path) -> None:
    target = tmp_path / "target.sqlite3"
    sqlite3.connect(target).close()
    alias = tmp_path / "archive.sqlite3"
    alias.symlink_to(target)

    with pytest.raises(OSError):
        connect(alias)

