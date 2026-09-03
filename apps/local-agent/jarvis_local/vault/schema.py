"""Applying the vault schema to the archive database.

The vault tables share the archive's connection so an observation and a head
move commit together. They cannot share the archive's *migration ledger*: the
archive is already at version 3, and a vault migration numbered 3 recorded in
the same `schema_migration` table would be seen as already applied and skipped
in silence -- an empty vault schema that reports success. So the vault keeps
its own ledger in `vault_schema_migration`, and the two numbering sequences
are independent because they always were; only the shared table made them look
otherwise.

Like the archive, the guards are verified at open time rather than assumed.
Triggers are ordinary schema objects: a database restored from a backup taken
before this migration, or built by an older version, accepts UPDATE on an
append-only table and looks entirely normal doing it.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from jarvis_local.archive.database import ArchiveDatabase, discover_migrations

VAULT_MIGRATIONS_DIRECTORY = Path(__file__).resolve().parent / "migrations"

_VAULT_SCHEMA_MIGRATION = """
CREATE TABLE IF NOT EXISTS vault_schema_migration (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
) STRICT;
"""

REQUIRED_VAULT_TRIGGERS: frozenset[str] = frozenset(
    {
        "vault_binding_no_update",
        "vault_binding_no_delete",
        "vault_document_location_is_immutable",
        "vault_document_no_delete",
        "vault_observation_no_update",
        "vault_observation_no_delete",
        "vault_document_head_no_delete",
        "vault_document_head_no_rewind",
        "vault_projection_operation_no_update",
        "vault_projection_operation_no_delete",
        "vault_projection_receipt_no_update",
        "vault_projection_receipt_no_delete",
        "vault_projection_abandonment_no_update",
        "vault_projection_abandonment_no_delete",
        "vault_head_search_insert",
        "vault_head_search_update",
    }
)

VAULT_IMMUTABLE_VIOLATION = "vault_immutable_violation"
VAULT_HEAD_REWIND = "vault_head_rewind"


class VaultGuardError(RuntimeError):
    """The vault schema is missing protection it is supposed to have."""


def apply_vault_migrations(
    connection: sqlite3.Connection,
    now: str,
    directory: Path = VAULT_MIGRATIONS_DIRECTORY,
) -> int:
    """Apply every unapplied vault migration in order. Returns how many ran."""
    connection.executescript(_VAULT_SCHEMA_MIGRATION)
    applied = {row[0] for row in connection.execute("SELECT version FROM vault_schema_migration")}

    # Both values are interpolated into SQL below because executescript takes
    # no parameters and splitting the ledger insert out of the script would put
    # the DDL and its record in separate transactions. `name` is already
    # constrained by the migration filename pattern; this asserts the same of
    # the timestamp rather than trusting the clock that produced it.
    if "'" in now:
        raise ValueError(f"refusing to apply vault migrations with a quoted timestamp: {now!r}")

    ran = 0
    for version, name, path in discover_migrations(directory):
        if version in applied:
            continue
        connection.executescript(
            "BEGIN;\n"
            + path.read_text(encoding="utf-8")
            + "\nINSERT INTO vault_schema_migration (version, name, applied_at)"
            + f" VALUES ({version}, '{name}', '{now}');\n"
            "COMMIT;\n"
        )
        ran += 1
    return ran


def installed_triggers(connection: sqlite3.Connection) -> frozenset[str]:
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'").fetchall()
    return frozenset(str(row[0]) for row in rows)


def assert_vault_guards(connection: sqlite3.Connection) -> None:
    """Refuse to use a vault schema whose immutability guards are incomplete."""
    missing = REQUIRED_VAULT_TRIGGERS - installed_triggers(connection)
    if missing:
        raise VaultGuardError("vault schema is missing triggers: " + ", ".join(sorted(missing)))


def open_vault_schema(database: ArchiveDatabase, *, now: str) -> ArchiveDatabase:
    """Bring an opened archive database up to the current vault schema."""
    apply_vault_migrations(database.connection, now)
    assert_vault_guards(database.connection)
    return database
