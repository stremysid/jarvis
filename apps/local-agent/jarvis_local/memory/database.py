"""SQLite connection and migrations for the distilled-memory database.

Separate file from the archive by design: the two databases have different
immutability rules. The archive forbids every UPDATE; memory must permit
state transitions while protecting content and provenance, so they cannot
share a migration runner that asserts one policy.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from jarvis_local.archive.database import apply_migrations, connect

MIGRATIONS_DIRECTORY = Path(__file__).resolve().parent / "migrations"

REQUIRED_TRIGGERS: frozenset[str] = frozenset(
    {
        "fact_content_is_immutable",
        "fact_no_delete",
        "fact_source_no_update",
        "fact_source_no_delete",
        "fact_supersession_no_update",
        "fact_supersession_no_delete",
    }
)


class MemoryGuardError(RuntimeError):
    """The memory database is missing protection it is supposed to have."""


def assert_fact_guards(connection: sqlite3.Connection) -> None:
    installed = {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")}
    missing = REQUIRED_TRIGGERS - installed
    if missing:
        raise MemoryGuardError("memory database is missing triggers: " + ", ".join(sorted(missing)))


class MemoryDatabase:
    """An opened, migrated distilled-memory database."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    @classmethod
    def open(cls, path: Path, *, now: str, store_root: Path | None = None) -> MemoryDatabase:
        connection = connect(Path(path), store_root=store_root)
        apply_migrations(connection, now, MIGRATIONS_DIRECTORY)
        assert_fact_guards(connection)
        return cls(connection)

    def close(self) -> None:
        self.connection.close()
