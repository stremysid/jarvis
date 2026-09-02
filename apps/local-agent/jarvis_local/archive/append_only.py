"""Application-level append-only enforcement.

The SQLite triggers are the real barrier, but the foundation design requires
enforcement "in both application code and database triggers". This module is
the second half: it verifies at open time that every expected trigger is
actually present.

That matters because triggers are ordinary schema objects. A tampered
migration, a restored-from-backup file, or a database built by an older
version could all produce an archive that looks normal and accepts UPDATE
silently. Checking on open turns that from an invisible weakness into a
refusal to start.
"""

from __future__ import annotations

import sqlite3

REQUIRED_TRIGGERS: frozenset[str] = frozenset(
    {
        "archive_event_no_update",
        "archive_event_no_delete",
        "content_blob_no_update",
        "content_blob_no_delete",
        "content_seen_no_update",
        "content_seen_no_delete",
    }
)

APPEND_ONLY_VIOLATION = "append_only_violation"


class AppendOnlyGuardError(RuntimeError):
    """The archive is missing protection it is supposed to have."""


def installed_triggers(connection: sqlite3.Connection) -> frozenset[str]:
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'").fetchall()
    return frozenset(str(row[0]) for row in rows)


def assert_append_only(connection: sqlite3.Connection) -> None:
    """Refuse to use an archive whose immutability guards are incomplete."""
    missing = REQUIRED_TRIGGERS - installed_triggers(connection)
    if missing:
        raise AppendOnlyGuardError(
            "archive is missing append-only triggers: " + ", ".join(sorted(missing))
        )
