"""SQLite connection and migration handling for the archive.

Migrations are numbered files applied in order and recorded, so reopening an
existing archive is a no-op. They are additive only: this database is the
permanent record, so a migration that dropped or rewrote a column would be
the same defect the append-only triggers exist to prevent.
"""

from __future__ import annotations

import os
import re
import sqlite3
import stat
from pathlib import Path

from jarvis_local.archive.append_only import assert_append_only

MIGRATIONS_DIRECTORY = Path(__file__).resolve().parent / "migrations"
_MIGRATION_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")

_SCHEMA_MIGRATION = """
CREATE TABLE IF NOT EXISTS schema_migration (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
) STRICT;
"""


def _is_posix() -> bool:
    # Behind a function so a win32 mypy run still checks the guarded body.
    return os.name == "posix"


def _restrict_sqlite_file(path: Path, *, create: bool) -> None:
    if not _is_posix():
        return
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    if create:
        flags |= os.O_CREAT
    try:
        descriptor = os.open(path, flags, stat.S_IRUSR | stat.S_IWUSR)
    except FileNotFoundError:
        if create:
            raise
        return
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise PermissionError("the SQLite store is not a regular file")
        if metadata.st_uid != os.geteuid():  # type: ignore[attr-defined,unused-ignore]
            raise PermissionError("the SQLite store is not owned by this user")
        if metadata.st_mode & 0o077:
            os.fchmod(  # type: ignore[attr-defined,unused-ignore]
                descriptor,
                stat.S_IRUSR | stat.S_IWUSR,
            )
    finally:
        os.close(descriptor)


def _restrict_sqlite_directory(path: Path) -> None:
    if not _is_posix():
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode):
            raise PermissionError("the SQLite store parent is not a directory")
        if metadata.st_uid != os.geteuid():  # type: ignore[attr-defined,unused-ignore]
            raise PermissionError("the SQLite store parent is not owned by this user")
        if metadata.st_mode & 0o077:
            os.fchmod(descriptor, stat.S_IRWXU)  # type: ignore[attr-defined,unused-ignore]
    finally:
        os.close(descriptor)


def connect(path: Path) -> sqlite3.Connection:
    """Open the archive with the pragmas it depends on.

    WAL keeps readers from blocking the replicator. `foreign_keys` is off by
    default in SQLite and must be enabled per connection, or content_seen's
    reference to content_blob would be decorative.
    """
    path.parent.mkdir(mode=stat.S_IRWXU, parents=True, exist_ok=True)
    _restrict_sqlite_directory(path.parent)
    _restrict_sqlite_file(path, create=True)
    for suffix in ("-wal", "-shm"):
        _restrict_sqlite_file(Path(f"{path}{suffix}"), create=False)
    connection = sqlite3.connect(path, isolation_level=None)
    connection.execute("PRAGMA journal_mode = WAL")
    for suffix in ("-wal", "-shm"):
        _restrict_sqlite_file(Path(f"{path}{suffix}"), create=False)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA synchronous = FULL")
    return connection


def discover_migrations(directory: Path = MIGRATIONS_DIRECTORY) -> list[tuple[int, str, Path]]:
    found: list[tuple[int, str, Path]] = []
    for candidate in sorted(directory.glob("*.sql")):
        match = _MIGRATION_NAME.match(candidate.name)
        if match is None:
            raise ValueError(f"migration filename is not NNNN_name.sql: {candidate.name}")
        found.append((int(match.group(1)), candidate.name, candidate))
    versions = [version for version, _, _ in found]
    if len(set(versions)) != len(versions):
        raise ValueError(f"duplicate migration versions: {versions}")
    return found


def apply_migrations(connection: sqlite3.Connection, now: str, directory: Path = MIGRATIONS_DIRECTORY) -> int:
    """Apply every unapplied migration in order. Returns how many ran."""
    connection.executescript(_SCHEMA_MIGRATION)
    applied = {row[0] for row in connection.execute("SELECT version FROM schema_migration")}

    # Guarded because both values are interpolated into SQL below. `name` is
    # already constrained by _MIGRATION_NAME; `now` is produced by our own
    # clock. Neither can contain a quote, and this asserts that rather than
    # assuming it.
    if "'" in now:
        raise ValueError(f"refusing to apply migrations with a quoted timestamp: {now!r}")

    ran = 0
    for version, name, path in discover_migrations(directory):
        if version in applied:
            continue
        # BEGIN/COMMIT must live *inside* the script. executescript issues an
        # implicit COMMIT before it runs, so an explicit BEGIN around the call
        # is closed before the DDL executes and the matching COMMIT then fails
        # with "no transaction is active". Wrapping it this way keeps the DDL
        # and its migration record in one transaction, so a failure leaves the
        # archive at the last complete version rather than half-migrated.
        connection.executescript(
            "BEGIN;\n"
            + path.read_text(encoding="utf-8")
            + f"\nINSERT INTO schema_migration (version, name, applied_at)"
            f" VALUES ({version}, '{name}', '{now}');\n"
            "COMMIT;\n"
        )
        ran += 1
    return ran


class ArchiveDatabase:
    """An opened, migrated archive database."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    @classmethod
    def open(cls, path: Path, *, now: str) -> ArchiveDatabase:
        connection = connect(Path(path))
        apply_migrations(connection, now)
        # Verify after migrating, so an archive whose immutability guards are
        # absent refuses to open rather than accepting writes it cannot protect.
        assert_append_only(connection)
        return cls(connection)

    def close(self) -> None:
        self.connection.close()
