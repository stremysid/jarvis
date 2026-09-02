"""The archive is permanent. Nothing may edit or remove what it holds.

The foundation design requires append-only enforcement "in both application
code and database triggers" -- belt and braces, because the archive is the
record every distilled fact cites. If a row can be rewritten, every citation
pointing at it becomes a lie, silently.

These tests attack the database directly, bypassing the repository API, since
a guard that only exists in Python is not a guard.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.archive.content_store import ContentObservation

SEEN_AT = "2026-09-01T12:00:00.000Z"


def event(sequence: int, text: str, *, event_id: str | None = None) -> dict[str, object]:
    return {
        "event_id": event_id or f"event_{sequence:026d}",
        "event_sequence": sequence,
        "event_type": "conversation.turn.v1",
        "principal_id": "principal_01j0000000000000000000000",
        "session_id": "session_01j0000000000000000000000",
        "canonical_text": text,
        "occurred_at": SEEN_AT,
        "producer_version": "cloud-gateway@0.1.0",
    }


def observation(identifier: str, *, source_event_id: str = "event_1") -> ContentObservation:
    return ContentObservation(id=identifier, source_event_id=source_event_id, seen_at=SEEN_AT)


def test_sqlite_triggers_reject_update_and_delete(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.insert_event_if_absent(event(sequence=1, text="redacted text"))
    repo.store_document("a document", observation("01a"))

    with pytest.raises(sqlite3.IntegrityError, match="append_only_violation"):
        repo.connection.execute("DELETE FROM archive_event WHERE event_sequence = 1")
    with pytest.raises(sqlite3.IntegrityError, match="append_only_violation"):
        repo.connection.execute("UPDATE archive_event SET canonical_text = 'changed'")
    with pytest.raises(sqlite3.IntegrityError, match="append_only_violation"):
        repo.connection.execute("UPDATE content_blob SET canonical_text = 'changed'")
    with pytest.raises(sqlite3.IntegrityError, match="append_only_violation"):
        repo.connection.execute("DELETE FROM content_blob")
    with pytest.raises(sqlite3.IntegrityError, match="append_only_violation"):
        repo.connection.execute("UPDATE content_seen SET content_hash = 'changed'")
    with pytest.raises(sqlite3.IntegrityError, match="append_only_violation"):
        repo.connection.execute("DELETE FROM content_seen")


def test_rejected_mutation_leaves_the_row_intact(tmp_path: Path) -> None:
    """An aborted trigger must not partially apply."""
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.insert_event_if_absent(event(sequence=1, text="original"))

    with pytest.raises(sqlite3.IntegrityError):
        repo.connection.execute("UPDATE archive_event SET canonical_text = 'changed'")

    (stored,) = repo.connection.execute("SELECT canonical_text FROM archive_event").fetchone()
    assert stored == "original"


def test_the_repository_exposes_no_mutation_api(tmp_path: Path) -> None:
    """Update and delete are absent from the archive API by design."""
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    for forbidden in ("update_event", "delete_event", "update_document", "delete_document", "purge"):
        assert not hasattr(repo, forbidden), f"ArchiveRepository must not expose {forbidden}"


def test_insert_is_idempotent_by_event_id(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    first = repo.insert_event_if_absent(event(sequence=1, text="once"))
    second = repo.insert_event_if_absent(event(sequence=1, text="once"))

    assert (first, second) == (True, False)
    assert repo.count_events() == 1


def test_replay_with_altered_text_under_the_same_id_is_refused(tmp_path: Path) -> None:
    """Re-sending an event id with different content is corruption, not a retry.

    Accepting it silently would let a replay rewrite history through the one
    door the append-only triggers leave open.
    """
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.insert_event_if_absent(event(sequence=1, text="original"))

    with pytest.raises(ValueError, match="conflicting"):
        repo.insert_event_if_absent(event(sequence=1, text="tampered"))


def test_distinct_turns_with_identical_text_remain_separate_events(tmp_path: Path) -> None:
    """The design is explicit: conversation turns stay distinct even when equal."""
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.insert_event_if_absent(event(sequence=1, text="ok", event_id="event_a"))
    repo.insert_event_if_absent(event(sequence=2, text="ok", event_id="event_b"))
    assert repo.count_events() == 2


def test_events_after_returns_contiguous_ascending_order(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    for sequence in (3, 1, 2):  # inserted out of order on purpose
        repo.insert_event_if_absent(event(sequence=sequence, text=f"turn {sequence}"))

    assert [item.event_sequence for item in repo.events_after(0)] == [1, 2, 3]
    assert [item.event_sequence for item in repo.events_after(1)] == [2, 3]
    assert list(repo.events_after(3)) == []


def test_reopening_preserves_everything(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite3"
    first = ArchiveRepository.open(path)
    first.insert_event_if_absent(event(sequence=1, text="durable"))
    first.close()

    second = ArchiveRepository.open(path)
    assert second.count_events() == 1
    # Migrations are idempotent: reopening must not re-run or duplicate them.
    assert [item.canonical_text for item in second.events_after(0)] == ["durable"]
