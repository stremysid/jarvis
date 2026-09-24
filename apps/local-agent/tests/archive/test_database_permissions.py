"""The owner's archived conversation and memory remain owner-readable only."""

from __future__ import annotations

import os
import sqlite3
import stat
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Protocol

import pytest

import jarvis_local.archive.database as database
from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.archive.database import connect
from jarvis_local.memory.facts import FactRepository


class ClosableStore(Protocol):
    connection: sqlite3.Connection

    def close(self) -> None: ...


POSIX_ONLY = pytest.mark.skipif(os.name != "posix", reason="POSIX permission semantics")


def test_every_missing_store_ancestor_is_created_private_and_validated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    outer = tmp_path / "outer"
    inner = outer / "inner"
    requested: dict[Path, int] = {}
    validated: list[Path] = []
    original_mkdir = Path.mkdir
    original_guard = database._restrict_sqlite_directory

    def mkdir(path: Path, mode: int = 0o777, parents: bool = False, exist_ok: bool = False) -> None:
        missing = not path.exists()
        original_mkdir(path, mode=mode, parents=parents, exist_ok=exist_ok)
        if missing:
            requested[path] = mode

    def guard(path: Path) -> None:
        validated.append(path)
        original_guard(path)

    monkeypatch.setattr(Path, "mkdir", mkdir)
    monkeypatch.setattr(database, "_restrict_sqlite_directory", guard)
    previous = os.umask(0o022)
    connection = None
    try:
        connection = connect(inner / "archive.sqlite3")
        assert requested == {outer: 0o700, inner: 0o700}
        assert validated == [outer, inner]
        if os.name == "posix":
            assert {stat.S_IMODE(path.stat().st_mode) for path in (outer, inner)} == {0o700}
    finally:
        os.umask(previous)
        if connection is not None:
            connection.close()


def test_an_ancestor_above_the_store_root_is_created_without_the_store_dacl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Above the root is not the store, so it must not receive the store's DACL.

    The store is `<tmp>/outer/mid/Jarvis/data` and the boundary the caller named is
    `<tmp>/outer/mid/Jarvis`, with only `outer` present. So `mid` is a missing
    ancestor *above* the boundary: it has to be created or a first run could not
    start, but writing the store's owner-only SDDL onto it is the `path.parents`
    walk that emptied this account's profile -- one directory above where it
    stopped being the store. `boundary` itself is the outermost store directory,
    so making it private is correct; `mid` must be created with a plain `mkdir`.

    Both of the obvious ways to write this test are wrong, and each was caught by
    mutating the branch rather than by reading it. Making only the store directory
    missing left nothing above `boundary` in the walk, so the branch never ran.
    Making `outer` the missing ancestor did not help either: it is missing, but
    `_ensure_sqlite_directory` stops ascending at the first directory that exists,
    and `boundary.mkdir(parents=True)` had already created the whole chain.

    `_make_directory_private` is replaced with a recorder because this is about
    *which* directories are handed to it, not about what an ACL contains; the
    Win32 seam is stubbed package-wide and no real DACL is written here.
    """
    outer = tmp_path / "outer"
    outer.mkdir()
    mid = outer / "mid"
    boundary = mid / "Jarvis"
    store = boundary / "data"
    assert not boundary.exists(), "the branch under test only runs when the boundary is missing"

    private: list[Path] = []
    original_mkdir = Path.mkdir

    def record(directory: Path, *, store_root: Path) -> None:
        private.append(directory)
        original_mkdir(directory, mode=stat.S_IRWXU, exist_ok=True)

    monkeypatch.setattr(database, "_make_directory_private", record)

    database._ensure_sqlite_directory(store, store_root=boundary)

    assert store in private, "the store directory must be made private"
    assert boundary in private, "the boundary is the outermost store directory and is made private"
    assert mid not in private, "a missing ancestor above the store root was given the store DACL"
    assert outer not in private, "a missing ancestor above the store root was given the store DACL"
    assert store.is_dir(), "the store directory was not created"


@POSIX_ONLY
@pytest.mark.parametrize("open_store", [ArchiveRepository.open, FactRepository.open])
def test_store_and_live_wal_files_ignore_a_permissive_umask(    tmp_path: Path,
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
        assert stat.S_IMODE(database_path.parent.stat().st_mode) == 0o700
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


def test_store_file_guard_refuses_non_regular_descriptor_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(database, "_is_posix", lambda: True)
    monkeypatch.setattr(database.os, "open", lambda *_args: 7)
    monkeypatch.setattr(
        database.os,
        "fstat",
        lambda _descriptor: SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=1000),
    )
    monkeypatch.setattr(database.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(database.os, "close", lambda _descriptor: None)

    with pytest.raises(PermissionError, match="regular file"):
        database._restrict_sqlite_file(Path("archive.sqlite3"), create=True)


def test_store_file_guard_refuses_foreign_descriptor_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(database, "_is_posix", lambda: True)
    monkeypatch.setattr(database.os, "open", lambda *_args: 7)
    monkeypatch.setattr(
        database.os,
        "fstat",
        lambda _descriptor: SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1001),
    )
    monkeypatch.setattr(database.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(database.os, "close", lambda _descriptor: None)

    with pytest.raises(PermissionError, match="owned by this user"):
        database._restrict_sqlite_file(Path("archive.sqlite3"), create=True)


def test_store_creation_requests_owner_only_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_modes: list[int] = []

    def capture_mode(_path: Path, _flags: int, mode: int = 0o777) -> int:
        requested_modes.append(mode)
        return 7

    monkeypatch.setattr(database, "_is_posix", lambda: True)
    monkeypatch.setattr(database.os, "open", capture_mode)
    monkeypatch.setattr(
        database.os,
        "fstat",
        lambda _descriptor: SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1000),
    )
    monkeypatch.setattr(database.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(database.os, "close", lambda _descriptor: None)
    database._restrict_sqlite_file(Path("archive.sqlite3"), create=True)

    assert requested_modes == [0o600]


def test_store_directory_guard_refuses_permissions_without_changing_them(monkeypatch: pytest.MonkeyPatch) -> None:
    requested_modes: list[int] = []
    monkeypatch.setattr(database, "_is_posix", lambda: True)
    monkeypatch.setattr(database.os, "open", lambda *_args: 7)
    monkeypatch.setattr(
        database.os,
        "fstat",
        lambda _descriptor: SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=1000),
    )
    monkeypatch.setattr(database.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(
        database.os,
        "fchmod",
        lambda _descriptor, mode: requested_modes.append(mode),
        raising=False,
    )
    monkeypatch.setattr(database.os, "close", lambda _descriptor: None)

    with pytest.raises(PermissionError, match=r"state.*0700") as refusal:
        database._restrict_sqlite_directory(Path("state directory"))

    assert requested_modes == []
    assert "chmod 0700 -- 'state directory'" in str(refusal.value)


@pytest.mark.parametrize("mode,owner,reason", [
    (stat.S_IFREG | 0o700, 1000, "not a directory"),
    (stat.S_IFDIR | 0o700, 1001, "not owned by this user"),
])
def test_store_directory_refuses_wrong_type_or_owner(
    monkeypatch: pytest.MonkeyPatch, mode: int, owner: int, reason: str,
) -> None:
    closed: list[int] = []
    monkeypatch.setattr(database, "_is_posix", lambda: True)
    monkeypatch.setattr(database.os, "open", lambda *_args: 7)
    monkeypatch.setattr(database.os, "fstat", lambda _: SimpleNamespace(st_mode=mode, st_uid=owner))
    monkeypatch.setattr(database.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(database.os, "close", closed.append)
    with pytest.raises(PermissionError, match=reason):
        database._restrict_sqlite_directory(Path("state"))
    assert closed == [7]


@POSIX_ONLY
@pytest.mark.parametrize("mode", [0o755, 0o750])
def test_connect_refuses_an_existing_shared_parent_without_chmod(tmp_path: Path, mode: int) -> None:
    parent = tmp_path / "owner-chosen"
    parent.mkdir()
    parent.chmod(mode)
    with pytest.raises(PermissionError, match=r"owner-chosen.*0700"):
        connect(parent / "archive.sqlite3")
    assert stat.S_IMODE(parent.stat().st_mode) == mode
    assert not (parent / "archive.sqlite3").exists()


def test_connect_applies_the_directory_guard_to_the_store_parent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "state" / "archive.sqlite3"
    guarded: list[Path] = []
    monkeypatch.setattr(database, "_restrict_sqlite_directory", guarded.append)
    monkeypatch.setattr(database, "_restrict_sqlite_file", lambda *_args, **_kwargs: None)

    class FakeConnection:
        def execute(self, _statement: str) -> FakeConnection:
            return self

    monkeypatch.setattr(database.sqlite3, "connect", lambda *_args, **_kwargs: FakeConnection())
    connect(database_path)

    assert guarded == [database_path.parent]


def test_connect_guards_sidecars_both_before_open_and_after_wal_enable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "archive.sqlite3"
    wal_path = Path(f"{database_path}-wal")
    shm_path = Path(f"{database_path}-shm")
    restricted: list[tuple[Path, bool]] = []
    monkeypatch.setattr(database, "_restrict_sqlite_directory", lambda _path: None)
    monkeypatch.setattr(
        database,
        "_restrict_sqlite_file",
        lambda path, *, create: restricted.append((path, create)),
    )

    class FakeConnection:
        def execute(self, _statement: str) -> FakeConnection:
            return self

    def inspect_before_open(*_args: object, **_kwargs: object) -> FakeConnection:
        assert restricted == [(database_path, True), (wal_path, False), (shm_path, False)]
        return FakeConnection()

    monkeypatch.setattr(database.sqlite3, "connect", inspect_before_open)
    connect(database_path)

    assert restricted == [
        (database_path, True),
        (wal_path, False),
        (shm_path, False),
        (wal_path, False),
        (shm_path, False),
    ]


@POSIX_ONLY
def test_existing_sidecars_are_restricted_before_sqlite_opens(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "archive.sqlite3"
    sqlite3.connect(database_path).close()
    sidecars = [Path(f"{database_path}-wal"), Path(f"{database_path}-shm")]
    for sidecar in sidecars:
        sidecar.write_bytes(b"")
        sidecar.chmod(0o644)

    class InspectedError(Exception):
        pass

    def inspect_before_open(*_args: object, **_kwargs: object) -> None:
        assert {stat.S_IMODE(path.stat().st_mode) for path in sidecars} == {0o600}
        raise InspectedError

    monkeypatch.setattr(database.sqlite3, "connect", inspect_before_open)
    with pytest.raises(InspectedError):
        connect(database_path)


@POSIX_ONLY
def test_new_sidecars_are_restricted_after_wal_enables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "archive.sqlite3"
    sidecars = [Path(f"{database_path}-wal"), Path(f"{database_path}-shm")]

    class FakeConnection:
        def execute(self, statement: str) -> FakeConnection:
            if statement == "PRAGMA journal_mode = WAL":
                for sidecar in sidecars:
                    sidecar.write_bytes(b"")
                    sidecar.chmod(0o644)
            if statement == "PRAGMA foreign_keys = ON":
                assert {stat.S_IMODE(path.stat().st_mode) for path in sidecars} == {0o600}
            return self

    monkeypatch.setattr(database.sqlite3, "connect", lambda *_args, **_kwargs: FakeConnection())
    connect(database_path)

