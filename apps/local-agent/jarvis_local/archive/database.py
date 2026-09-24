"""SQLite connection and migration handling for the archive.

Migrations are numbered files applied in order and recorded, so reopening an
existing archive is a no-op. They are additive only: this database is the
permanent record, so a migration that dropped or rewrote a column would be
the same defect the append-only triggers exist to prevent.
"""

from __future__ import annotations

import logging
import os
import re
import shlex
import sqlite3
import stat
from pathlib import Path

from jarvis_local.archive.append_only import assert_append_only

logger = logging.getLogger(__name__)

MIGRATIONS_DIRECTORY = Path(__file__).resolve().parent / "migrations"
_MIGRATION_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")

#: Extensions `_ensure_sqlite_directory` refuses. It takes the directory that
#: holds the store, never the store file itself.
_SQLITE_FILE_SUFFIXES = frozenset({".sqlite", ".sqlite3", ".db"})

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


class SQLiteDirectoryError(PermissionError):
    """An owner-selected store directory requires an explicit permissions fix."""


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
            raise SQLiteDirectoryError(f"SQLite store parent {path} is not a directory")
        if metadata.st_uid != os.geteuid():  # type: ignore[attr-defined,unused-ignore]
            raise SQLiteDirectoryError(f"SQLite store parent {path} is not owned by this user")
        if metadata.st_mode & 0o077:
            raise SQLiteDirectoryError(
                f"SQLite store parent {path} requires owner-only permissions (0700). "
                "After checking that this directory should be private, run: "
                f"chmod 0700 -- {shlex.quote(os.fspath(path))}"
            )
    finally:
        os.close(descriptor)


def _make_directory_private(directory: Path, *, store_root: Path) -> None:
    """Create `directory` so only its own user, SYSTEM and Administrators can read it.

    POSIX takes a mode and asks again. Windows cannot: `mkdir(mode=0o700)` is
    actively wrong there since CPython 3.12.4, so the DACL is written explicitly
    instead. `store_permissions` carries the measurement and the reasoning; the
    short version is that an elevated creator becomes the Administrators-owned
    object, `OW` stops naming the user, and his own session is then shut out --
    which is the folder this store was found in.

    `store_root` is the boundary `store_permissions` checks every write against.
    """
    if _is_posix():
        directory.mkdir(mode=stat.S_IRWXU, exist_ok=True)
        _restrict_sqlite_directory(directory)
        return
    from jarvis_local.archive.store_permissions import ensure_private_directory
    from jarvis_local.transport.pipe_server import current_user_sid

    ensure_private_directory(directory, current_user_sid(), store_root=store_root)


def repair_store_permissions(
    path: Path, *, store_root: Path | None = None, repair_permissions: bool = False
) -> tuple[Path, ...]:
    """Re-apply the private DACL to the store directory and everything under it.

    Called when a store is opened so a running agent repairs a folder that was
    created the old way, which is the only way the live `%LOCALAPPDATA%\\Jarvis`
    tree gets fixed without an elevated shell and an `icacls` incantation.
    A no-op away from Windows, and it does not create anything.

    **This descends only, and that is not a detail.** The first version walked
    `path.parents` to the drive root and applied the same restrictive DACL to
    every directory on the way up. `C:\\Users\\Sid` was rewritten, Windows
    recomputed every item beneath it from a folder that no longer passed
    anything down, and the account lost its entire profile -- twice, and `C:\\`
    on the second run. Nothing above `path` is touched here, and
    `_refuse_unsafe_path` in `store_permissions` refuses it if a future caller
    tries.

    Returns the paths it could not fix; `store_permissions` logs each one as it
    happens, so a failure stays visible even when this return value is dropped.

    `repair_permissions=False` answers for permission changes what "read-only"
    answers for data: nothing is written. `jarvis vault` opens the archive as a
    reader and must not be able to rewrite an ACL as a side effect, so it passes
    False -- and so does every other opener unless it says otherwise. The default
    is False because a permission write propagates to everything below the object
    it names, so the one caller that may perform it has to be the one that asks:
    `agent.open_stores`, which is the path `jarvis serve` runs.
    """
    if not repair_permissions:
        return ()
    if _is_posix() or not path.exists() or not path.is_dir():
        return ()
    from jarvis_local.archive.store_permissions import repair_store_tree
    from jarvis_local.transport.pipe_server import current_user_sid

    return repair_store_tree(path, current_user_sid(), store_root=store_root)


def _ensure_sqlite_directory(path: Path, *, store_root: Path | None = None, repair_permissions: bool = False) -> None:
    """Make `path` a private directory, creating each missing component.

    `path` is a **directory**. Passing the `.sqlite3` file is a mistake this
    refuses loudly: the first version was handed a file path by a test, so it
    created a directory literally named `archive.sqlite3` and worked out the
    store root from there -- on the way to rewriting a profile.

    `store_root` is the outermost directory this may touch. It is **not**
    derived from `path`: taking `path.parent` made the guard in
    `store_permissions` vacuously true, because whatever path was passed chose
    its own boundary. When it is omitted here the configured data directory is
    used, which is the same boundary production uses and is not set by the code
    choosing a target.

    `repair_permissions=False` is the default, and it is the read-only opener: it
    creates no directory, writes no ACL, and refuses a store that is not already
    there. Every opener is one of these unless it says otherwise; only
    `agent.open_stores` -- the path `jarvis serve` runs -- asks for True.
    """
    if path.suffix in _SQLITE_FILE_SUFFIXES:
        raise SQLiteDirectoryError(f"{path} is a file, not the store directory that contains it")
    boundary = _store_boundary(path, store_root)
    if not repair_permissions:
        # Nothing is created and no ACL is written. A reader that cannot reach an
        # existing store should say so, not manufacture one and change the
        # permissions of the directories on the way in -- and `jarvis vault` is
        # exactly that reader. `boundary` is still computed above, so the
        # containment check that protects the *creating* path cannot be skipped
        # by asking for the read-only one.
        if not path.exists():
            raise SQLiteDirectoryError(
                f"{path} does not exist, and this opener does not create stores "
                f"(no directory or permission was written)"
            )
        return
    # pathlib's parents=True applies mode only to the final directory. Create
    # and inspect each missing component so the node never makes a public
    # ancestor while creating a private store beneath it.
    #
    # `missing` is built nearest-first, so `reversed(missing)` walks it back down
    # and creates the topmost missing component *first* -- the ancestors, then
    # the store. The components above the boundary are a different case from the
    # store itself: an ancestor of the store root is a directory the store merely
    # happens to live inside (`...\AppData\Local`, say), and writing the store's
    # owner-only SDDL onto one is precisely the walk that emptied this account's
    # profile. The process has to be able to create them or a first run could not
    # start at all, so they are made with the permissions they would have had
    # anyway.
    missing: list[Path] = []
    for directory in (path, *path.parents):
        if directory.exists():
            break
        missing.append(directory)
    for directory in reversed(missing):
        if directory == boundary or boundary in directory.parents:
            _make_directory_private(directory, store_root=boundary)
        elif _is_posix():
            # A mode is the only thing that makes a directory private here, so it
            # is passed -- and `parents=False` is safe because `reversed(missing)`
            # has just created this directory's parent.
            directory.mkdir(mode=stat.S_IRWXU, parents=True, exist_ok=True)
        else:
            # **No mode on Windows.** `mkdir(mode=0o700)` is not a mode there: it
            # applies the CVE-2024-4030 DACL, `OW`/`SY`/`BA` and nothing naming
            # the user, so an ancestor made that way hands everything in it to an
            # owner Windows chose. A plain `mkdir` inherits the parent's DACL,
            # which is what this directory would have had if the store had never
            # been created -- and above the boundary that is all it is entitled
            # to.
            directory.mkdir(parents=True, exist_ok=True)
    if not missing:
        if _is_posix():
            _restrict_sqlite_directory(path)
        else:
            # A store directory that already exists may still have been created
            # by an elevated process the old way, and its DACL has to be
            # re-applied for the user's own session to reach it.
            for failed in repair_store_permissions(path, store_root=boundary, repair_permissions=repair_permissions):
                logger.warning("store permissions could not be repaired at %s", failed)


def _store_boundary(path: Path, store_root: Path | None) -> Path:
    """The directory a write to `path` must stay inside.

    An explicit `store_root` wins when the caller has one -- the service knows
    its configured data directory and tests know their temp directory. Otherwise
    the configured root is used, and a path outside every configured root is
    refused here rather than silently given its own.

    The fallback exists because the vault and memory stores are opened from
    paths that are not the configured archive, and refusing to start them would
    turn a permissions guard into an outage. It never widens the boundary to the
    path: `path.parent` is deliberately not a candidate. `configured_store_roots`
    is never empty -- unset falls back to the default store root -- so there is no
    "no boundary configured" case to answer here, and the one that used to exist
    returned `path` itself and quietly removed the boundary.
    """
    from jarvis_local.archive.store_permissions import configured_store_roots

    if store_root is not None:
        return store_root
    configured = configured_store_roots()
    resolved = path.resolve(strict=False)
    for allowed in configured:
        if resolved == allowed or allowed in resolved.parents:
            return allowed
    raise SQLiteDirectoryError(
        f"{resolved} is outside every configured store root "
        f"({', '.join(os.fspath(allowed) for allowed in configured)}); "
        "pass store_root explicitly if this is a test"
    )


def connect(path: Path, *, store_root: Path | None = None, repair_permissions: bool = False) -> sqlite3.Connection:
    """Open the archive with the pragmas it depends on.

    WAL keeps readers from blocking the replicator. `foreign_keys` is off by
    default in SQLite and must be enabled per connection, or content_seen's
    reference to content_blob would be decorative.

    `repair_permissions=False` is the default: opening a store writes no ACL and
    creates no directory. `agent.open_stores` passes True, and that is the only
    production caller that does; see `_ensure_sqlite_directory`.
    """
    _ensure_sqlite_directory(path.parent, store_root=store_root, repair_permissions=repair_permissions)
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
    def open(
        cls, path: Path, *, now: str, store_root: Path | None = None, repair_permissions: bool = False
    ) -> ArchiveDatabase:
        connection = connect(Path(path), store_root=store_root, repair_permissions=repair_permissions)
        apply_migrations(connection, now)
        # Verify after migrating, so an archive whose immutability guards are
        # absent refuses to open rather than accepting writes it cannot protect.
        assert_append_only(connection)
        return cls(connection)

    def close(self) -> None:
        self.connection.close()
