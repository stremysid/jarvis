"""Retry metadata obeys its transaction, file and migration boundaries."""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jarvis_local.memory.facts import FactRepository
from jarvis_local.service import QUEUED
from jarvis_local.sync.quarantine_retry import QuarantineRetryJournal

FACT_ID = "fact_" + "a" * 32
TERMINAL_OUTCOMES = ("applied", "not_quarantined", "failed", "cancelled")


@pytest.fixture
def journal(tmp_path: Path) -> Iterator[QuarantineRetryJournal]:
    path = tmp_path / "memory.sqlite3"
    facts = FactRepository.open(path)
    try:
        yield QuarantineRetryJournal(facts.connection, path, ("https://gateway.example", "principal-1", "device-1"))
    finally:
        facts.close()


@pytest.mark.parametrize("operation", ["apply", "finish"])
def test_retry_work_refuses_an_outer_transaction_without_touching_it(
    journal: QuarantineRetryJournal, operation: str,
) -> None:
    retry_id = journal.enqueue(FACT_ID)
    connection = journal.connection
    connection.execute("CREATE TABLE outer_transaction_probe (value TEXT)")
    connection.execute("BEGIN IMMEDIATE")
    connection.execute("INSERT INTO outer_transaction_probe VALUES ('uncommitted')")
    attempted: list[str] = []
    with pytest.raises(RuntimeError, match="retry work requires a cycle transaction boundary"):
        if operation == "apply":
            journal.apply(retry_id, FACT_ID, lambda fact_id: attempted.append(fact_id) is None)
        else:
            journal.finish(retry_id, "cancelled")
    assert attempted == []
    assert connection.in_transaction
    assert journal.records() == [(retry_id, FACT_ID, "queued")]
    assert connection.execute("SELECT value FROM outer_transaction_probe").fetchall() == [("uncommitted",)]
    connection.execute("COMMIT")
    assert not connection.in_transaction
    with sqlite3.connect(journal.path) as reader:
        assert reader.execute("SELECT value FROM outer_transaction_probe").fetchall() == [("uncommitted",)]


def test_enqueue_does_not_create_a_replacement_when_the_configured_database_is_missing(
    journal: QuarantineRetryJournal, tmp_path: Path,
) -> None:
    missing = tmp_path / "missing.sqlite3"
    detached = QuarantineRetryJournal(journal.connection, missing, journal.owner)
    before = set(tmp_path.iterdir())
    with pytest.raises(sqlite3.OperationalError):
        detached.enqueue(FACT_ID)
    assert not missing.exists()
    assert set(tmp_path.iterdir()) == before
    assert journal.records() == []


def insert_metadata(journal: QuarantineRetryJournal, outcome: str, order: int | None, origin: str | bytes) -> None:
    journal.connection.execute(
        """INSERT INTO memory_projection_retry
           (gateway_origin, principal_id, device_id, fact_id, outcome, completed_order)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (origin, journal.owner[1], journal.owner[2], FACT_ID, outcome, order),
    )


def test_retry_migration_rejects_an_unknown_outcome_independently_of_completion_shape(
    journal: QuarantineRetryJournal,
) -> None:
    with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
        insert_metadata(journal, "invented", 1, journal.owner[0])


@pytest.mark.parametrize("outcome,order", [
    ("queued", 1),
    *[(outcome, order) for outcome in TERMINAL_OUTCOMES for order in (None, 0, -1)],
])
def test_retry_migration_requires_completion_order_exactly_for_terminal_results(
    journal: QuarantineRetryJournal, outcome: str, order: int | None,
) -> None:
    with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
        insert_metadata(journal, outcome, order, journal.owner[0])


def test_retry_migration_refuses_a_blob_in_a_text_column(journal: QuarantineRetryJournal) -> None:
    with pytest.raises(sqlite3.IntegrityError, match="cannot store BLOB"):
        insert_metadata(journal, "queued", None, b"https://gateway.example")


@pytest.mark.parametrize("outcome,order", [(QUEUED, None), *[(value, 1) for value in TERMINAL_OUTCOMES]])
def test_retry_migration_accepts_each_runtime_outcome_and_matches_the_status_vocabulary(
    journal: QuarantineRetryJournal, outcome: str, order: int | None,
) -> None:
    insert_metadata(journal, outcome, order, journal.owner[0])
    assert journal.connection.execute("SELECT outcome, completed_order FROM memory_projection_retry").fetchone() == (
        outcome, order,
    )
    schema = journal.connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_projection_retry'",
    ).fetchone()[0]
    allowed = re.search(r"\boutcome\s+IN\s*\(([^)]*)\)", schema)
    assert allowed is not None
    assert set(re.findall(r"'([^']+)'", allowed.group(1))) == {QUEUED, *TERMINAL_OUTCOMES}
