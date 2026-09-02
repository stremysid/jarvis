"""Content addressing: store a document once, record every sighting.

Repeated documents are common -- the same note re-observed, the same file
re-read. Storing the bytes once and appending a small `content_seen` row per
sighting keeps the archive proportional to distinct content rather than to
observation count, without losing when each sighting happened.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

import pytest

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.archive.content_store import ContentObservation, canonical_content_hash, normalize_nfc

SEEN_AT = "2026-09-01T12:00:00.000Z"


def observation(identifier: str, *, source_event_id: str = "event_1", seen_at: str = SEEN_AT) -> ContentObservation:
    return ContentObservation(id=identifier, source_event_id=source_event_id, seen_at=seen_at)


def test_repeated_document_uses_one_blob_and_two_observations(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.store_document("same", observation("01a"))
    repo.store_document("same", observation("01b"))

    assert repo.count_content_blobs() == 1
    assert repo.count_content_seen() == 2


def test_distinct_documents_produce_distinct_blobs(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    first = repo.store_document("alpha", observation("01a"))
    second = repo.store_document("beta", observation("01b"))

    assert first != second
    assert repo.count_content_blobs() == 2


def test_the_same_content_always_hashes_the_same(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    assert repo.store_document("stable", observation("01a")) == repo.store_document("stable", observation("01b"))


def test_unicode_is_normalized_before_hashing(tmp_path: Path) -> None:
    """NFC vs NFD are the same text; they must not become two blobs.

    "é" composed (U+00E9) and decomposed (U+0065 U+0301) render identically.
    Without normalization the archive would hold both and every retrieval
    would have to guess which one a fact cited.
    """
    composed = unicodedata.normalize("NFC", "café")
    decomposed = unicodedata.normalize("NFD", "café")
    assert composed != decomposed  # genuinely different byte sequences

    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    assert repo.store_document(composed, observation("01a")) == repo.store_document(decomposed, observation("01b"))
    assert repo.count_content_blobs() == 1
    assert repo.count_content_seen() == 2


def test_stored_text_is_normalized_not_merely_hashed_that_way(tmp_path: Path) -> None:
    """Hashing NFC while storing NFD would make the blob disagree with its own hash."""
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    decomposed = unicodedata.normalize("NFD", "café")
    content_hash = repo.store_document(decomposed, observation("01a"))

    (stored,) = repo.connection.execute(
        "SELECT canonical_text FROM content_blob WHERE content_hash = ?", (content_hash,)
    ).fetchone()
    assert stored == unicodedata.normalize("NFC", decomposed)
    assert canonical_content_hash(stored) == content_hash


def test_whitespace_and_case_are_significant(tmp_path: Path) -> None:
    """Only Unicode normalization is applied. Trimming or folding would lose content."""
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.store_document("Text", observation("01a"))
    repo.store_document("text", observation("01b"))
    repo.store_document(" text ", observation("01c"))
    assert repo.count_content_blobs() == 3


def test_empty_document_is_representable(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    content_hash = repo.store_document("", observation("01a"))
    assert content_hash == canonical_content_hash("")
    assert repo.count_content_blobs() == 1


def test_duplicate_observation_id_is_refused(tmp_path: Path) -> None:
    """Observation ids are the idempotency key for sightings."""
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.store_document("same", observation("01a"))
    with pytest.raises(ValueError, match="observation"):
        repo.store_document("same", observation("01a"))
    assert repo.count_content_seen() == 1


def test_observations_record_their_source_event_and_time(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.store_document("traceable", observation("01a", source_event_id="event_42", seen_at=SEEN_AT))

    row = repo.connection.execute("SELECT source_event_id, seen_at FROM content_seen").fetchone()
    assert row == ("event_42", SEEN_AT)


def test_hash_is_sha256_hex(tmp_path: Path) -> None:
    digest = canonical_content_hash("anything")
    assert len(digest) == 64
    assert set(digest) <= set("0123456789abcdef")


def test_normalize_nfc_is_idempotent() -> None:
    once = normalize_nfc(unicodedata.normalize("NFD", "café"))
    assert normalize_nfc(once) == once
