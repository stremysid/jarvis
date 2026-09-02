"""The gate must prove a strategy works offline, not take its word for it.

Two properties are load-bearing here and both are tested against adversarial
candidates rather than cooperative ones: a candidate that reaches for the
network fails the whole gate, and a rebuilt index ranks identically to the
index it replaced.
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import struct
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

import jarvis_local
from jarvis_local.memory.compatibility_gate import (
    DEFAULT_FIXTURE,
    STRATEGY_SQLITE_BLOB_COSINE,
    CompatibilityFailure,
    CompatibilityReport,
    GateFixture,
    NetworkGuard,
    SqliteBlobCosineCandidate,
    run_compatibility_gate,
)
from jarvis_local.memory.embeddings import DeterministicHashEmbedder
from jarvis_local.memory.vector_index import (
    IndexedDocument,
    VectorEncodingError,
    VectorIndex,
    VectorIndexError,
    VectorMatch,
    cosine_search,
    decode_f32,
    encode_f32,
)

# Nothing listens on the discard port, so a candidate that escapes the guard
# fails fast with a refused connection instead of hanging the suite.
UNUSED_LOCAL_PORT = 9


class FixedEmbedder:
    """Vectors chosen by hand, so ranking assertions test ranking alone."""

    model_id = "fixed-test-embedder"
    dimensions = 3

    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self._vectors = vectors

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [list(self._vectors[text]) for text in texts]


@dataclass(frozen=True, slots=True)
class FailingSqliteVectorCandidate:
    """Stands in for a native vector extension that will not load here."""

    @property
    def strategy(self) -> str:
        return "sqlite_vec_extension"

    def verify_install_index_query_rebuild_offline(self, workdir: Path) -> CompatibilityReport:
        raise ImportError("no vector extension for this SQLite build")


@dataclass(frozen=True, slots=True)
class NetworkAttemptCandidate:
    """A candidate that opens a socket, the way a model downloader would.

    `suppress` models the worse case: a candidate whose own error handling
    hides the attempt and then reports success anyway.
    """

    entry_point: str
    suppress: bool = False

    @property
    def strategy(self) -> str:
        return f"network_{self.entry_point}"

    def verify_install_index_query_rebuild_offline(self, workdir: Path) -> CompatibilityReport:
        if self.suppress:
            with contextlib.suppress(BaseException):
                self._touch_network()
        else:
            self._touch_network()
        return CompatibilityReport(
            selected_strategy=self.strategy,
            passed=True,
            offline=True,
            query_result_ids=("event-1", "event-2"),
            rebuild_result_ids=("event-1", "event-2"),
            model_id="downloaded-model",
            dimensions=384,
        )

    def _touch_network(self) -> None:
        if self.entry_point == "create_connection":
            socket.create_connection(("127.0.0.1", UNUSED_LOCAL_PORT), timeout=0.1).close()
            return
        connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        connection.close()


def blob_cosine_candidate() -> SqliteBlobCosineCandidate:
    return SqliteBlobCosineCandidate(DeterministicHashEmbedder())


def test_gate_selects_blob_cosine_when_vector_extension_fails(tmp_path: Path) -> None:
    report = run_compatibility_gate(
        tmp_path,
        candidates=[FailingSqliteVectorCandidate(), blob_cosine_candidate()],
    )

    assert report.selected_strategy == STRATEGY_SQLITE_BLOB_COSINE
    assert report.passed is True
    assert report.offline is True
    assert report.rejected_strategies == ("sqlite_vec_extension",)
    assert report.query_result_ids == ("event-1", "event-2")
    assert report.rebuild_result_ids == ("event-1", "event-2")


def test_gate_falls_back_to_blob_cosine_with_no_candidates(tmp_path: Path) -> None:
    """The fallback is appended by the gate, so it cannot be configured away."""
    report = run_compatibility_gate(tmp_path)

    assert report.selected_strategy == STRATEGY_SQLITE_BLOB_COSINE
    assert report.model_id == DeterministicHashEmbedder().model_id
    assert report.passed is True


@pytest.mark.parametrize("entry_point", ["socket", "create_connection"])
def test_gate_rejects_any_candidate_that_attempts_network(tmp_path: Path, entry_point: str) -> None:
    with pytest.raises(CompatibilityFailure, match="offline"):
        run_compatibility_gate(tmp_path, candidates=[NetworkAttemptCandidate(entry_point)])


def test_gate_rejects_a_candidate_that_suppresses_the_network_error(tmp_path: Path) -> None:
    """Swallowing the trap must not buy a pass: the attempt itself is counted."""
    with pytest.raises(CompatibilityFailure, match="offline"):
        run_compatibility_gate(
            tmp_path,
            candidates=[NetworkAttemptCandidate("create_connection", suppress=True)],
        )


def test_gate_does_not_fall_back_after_a_network_attempt(tmp_path: Path) -> None:
    """A strategy that phoned home is a finding, not a reason to try the next one."""
    with pytest.raises(CompatibilityFailure):
        run_compatibility_gate(
            tmp_path,
            candidates=[NetworkAttemptCandidate("socket"), blob_cosine_candidate()],
        )


def test_socket_functions_are_restored_after_the_gate_runs(tmp_path: Path) -> None:
    """The traps are process-global; leaking them would break every later caller."""
    original_socket = socket.socket
    original_create_connection = socket.create_connection

    run_compatibility_gate(tmp_path / "pass")
    with pytest.raises(CompatibilityFailure):
        run_compatibility_gate(tmp_path / "fail", candidates=[NetworkAttemptCandidate("socket")])

    assert socket.socket is original_socket
    assert socket.create_connection is original_create_connection


def test_network_guard_counts_and_blocks_attempts() -> None:
    guard = NetworkGuard()
    with guard.enforced(), contextlib.suppress(BaseException):
        socket.create_connection(("127.0.0.1", UNUSED_LOCAL_PORT), timeout=0.1)
    assert guard.attempted is True
    assert guard.attempts == 1


def test_cosine_ranking_orders_by_similarity(tmp_path: Path) -> None:
    embedder = FixedEmbedder(
        {
            "aligned": [1.0, 0.0, 0.0],
            "oblique": [0.6, 0.8, 0.0],
            "orthogonal": [0.0, 1.0, 0.0],
            "query": [1.0, 0.0, 0.0],
        }
    )
    index = VectorIndex.open(tmp_path / "fixed.sqlite3", embedder)
    index.index(
        [
            IndexedDocument("event-orthogonal", "orthogonal"),
            IndexedDocument("event-aligned", "aligned"),
            IndexedDocument("event-oblique", "oblique"),
        ]
    )

    matches = index.search_text("query", limit=3)
    assert [match.event_id for match in matches] == ["event-aligned", "event-oblique", "event-orthogonal"]
    assert matches[0].score == pytest.approx(1.0)
    assert matches[1].score == pytest.approx(0.6)
    assert matches[2].score == pytest.approx(0.0)
    index.close()


def test_ties_break_by_event_id_not_by_row_order(tmp_path: Path) -> None:
    embedder = FixedEmbedder({"same": [0.0, 1.0, 0.0], "query": [0.0, 1.0, 0.0]})
    index = VectorIndex.open(tmp_path / "ties.sqlite3", embedder)
    # Inserted in descending id order: if row order decided, this would come
    # back reversed.
    index.index([IndexedDocument(event_id, "same") for event_id in ("event-c", "event-b", "event-a")])

    matches = index.search_text("query", limit=3)
    assert [match.event_id for match in matches] == ["event-a", "event-b", "event-c"]
    assert len({match.score for match in matches}) == 1
    index.close()


def test_cosine_search_is_independent_of_row_order() -> None:
    rows = [
        ("event-b", encode_f32([0.0, 1.0, 0.0])),
        ("event-a", encode_f32([0.0, 1.0, 0.0])),
        ("event-c", encode_f32([1.0, 0.0, 0.0])),
    ]
    forwards = cosine_search([0.0, 1.0, 0.0], rows, limit=3)
    backwards = cosine_search([0.0, 1.0, 0.0], list(reversed(rows)), limit=3)

    assert forwards == backwards
    assert forwards[:2] == [VectorMatch("event-a", 1.0), VectorMatch("event-b", 1.0)]


def test_rebuilding_reproduces_identical_results(tmp_path: Path) -> None:
    embedder = DeterministicHashEmbedder()
    documents = list(DEFAULT_FIXTURE.documents)

    first = VectorIndex.open(tmp_path / "first.sqlite3", embedder)
    first.rebuild(documents)
    before = first.search_text(DEFAULT_FIXTURE.query, limit=3)
    stored = first.connection.execute("SELECT event_id, embedding FROM event_embedding ORDER BY event_id").fetchall()
    first.close()

    # A rebuild in a fresh file, from the same inputs in a different order:
    # nothing about the result may depend on either.
    second = VectorIndex.open(tmp_path / "second.sqlite3", embedder)
    second.rebuild(list(reversed(documents)))
    after = second.search_text(DEFAULT_FIXTURE.query, limit=3)
    restored = second.connection.execute("SELECT event_id, embedding FROM event_embedding ORDER BY event_id").fetchall()
    second.close()

    assert before == after
    assert [(row[0], bytes(row[1])) for row in stored] == [(row[0], bytes(row[1])) for row in restored]


def test_rebuild_drops_events_that_left_the_corpus(tmp_path: Path) -> None:
    embedder = DeterministicHashEmbedder()
    index = VectorIndex.open(tmp_path / "shrink.sqlite3", embedder)
    index.index(list(DEFAULT_FIXTURE.documents))

    index.rebuild([DEFAULT_FIXTURE.documents[0]])
    assert index.count() == 1
    assert [match.event_id for match in index.search_text("coffee", limit=5)] == ["event-1"]
    index.close()


def test_same_text_embeds_identically_across_instances() -> None:
    text = "Sid takes his coffee black, no sugar -- café included"
    first = DeterministicHashEmbedder().embed([text])
    second = DeterministicHashEmbedder().embed([text])

    assert first == second
    assert encode_f32(first[0]) == encode_f32(second[0])


def test_embeddings_are_identical_across_processes() -> None:
    """The guard against `hash()`: its seed changes per process, blake2b's does not."""
    first = _embed_in_subprocess(hash_seed="0")
    second = _embed_in_subprocess(hash_seed="12345")

    assert first == second
    assert first == DeterministicHashEmbedder().embed(["Sid drinks coffee", "quarterly tax filing"])


def test_embedder_normalises_and_tolerates_featureless_text() -> None:
    embedder = DeterministicHashEmbedder()
    [vector, empty] = embedder.embed(["Sid drinks coffee", "   ...   "])

    assert len(vector) == embedder.dimensions
    assert sum(value * value for value in vector) == pytest.approx(1.0)
    # No features means no direction, which cosine reads as "unrelated".
    assert empty == [0.0] * embedder.dimensions


def test_unicode_forms_of_the_same_word_embed_identically() -> None:
    # Written as escapes: an editor that normalised the source would
    # otherwise turn this into two identical strings and the test would pass
    # without testing anything.
    composed = "café"
    decomposed = "café"
    assert composed != decomposed
    [first, second] = DeterministicHashEmbedder().embed([composed, decomposed])
    assert first == second


def test_model_id_changes_with_every_parameter() -> None:
    baseline = DeterministicHashEmbedder().model_id
    assert DeterministicHashEmbedder(dimensions=128).model_id != baseline
    assert DeterministicHashEmbedder(char_ngram=4).model_id != baseline
    assert DeterministicHashEmbedder(seed="other").model_id != baseline


def test_encode_decode_round_trip() -> None:
    vector = [0.5, -0.25, 0.125, 0.0]
    blob = encode_f32(vector)

    assert len(blob) == len(vector) * 4
    assert decode_f32(blob, dimensions=4) == vector


def test_truncated_blob_raises_rather_than_scoring(tmp_path: Path) -> None:
    embedder = DeterministicHashEmbedder()
    index = VectorIndex.open(tmp_path / "corrupt.sqlite3", embedder)
    index.index([IndexedDocument("event-1", "Sid drinks coffee")])
    intact = index.connection.execute("SELECT embedding FROM event_embedding").fetchone()[0]
    index.connection.execute("UPDATE event_embedding SET embedding = ?", (bytes(intact)[:-8],))

    with pytest.raises(VectorEncodingError, match="expected"):
        index.search_text("coffee")
    index.close()


def test_blob_of_unaligned_length_raises() -> None:
    with pytest.raises(VectorEncodingError, match="multiple of 4"):
        decode_f32(b"\x00\x00\x00")


def test_blob_of_wrong_width_raises() -> None:
    with pytest.raises(VectorEncodingError, match="expected 4"):
        decode_f32(encode_f32([1.0, 2.0]), dimensions=4)


def test_non_finite_blob_raises_instead_of_producing_a_nan_score(tmp_path: Path) -> None:
    """A NaN score compares false against everything and would silently reorder results."""
    embedder = FixedEmbedder({"doc": [1.0, 0.0, 0.0], "query": [1.0, 0.0, 0.0]})
    index = VectorIndex.open(tmp_path / "nan.sqlite3", embedder)
    index.index([IndexedDocument("event-1", "doc")])
    index.connection.execute(
        "UPDATE event_embedding SET embedding = ?",
        (struct.pack("<3f", float("nan"), 0.0, 0.0),),
    )

    with pytest.raises(VectorEncodingError, match="finite"):
        index.search_text("query")
    index.close()


def test_encoding_a_non_finite_vector_raises() -> None:
    with pytest.raises(VectorEncodingError, match="finite"):
        encode_f32([1.0, float("inf")])


def test_query_of_the_wrong_width_raises(tmp_path: Path) -> None:
    index = VectorIndex.open(tmp_path / "width.sqlite3", DeterministicHashEmbedder())
    with pytest.raises(VectorEncodingError, match="width 2"):
        index.search([1.0, 0.0])
    index.close()


def test_index_refuses_vectors_from_another_model(tmp_path: Path) -> None:
    """Mixing models silently returns nothing, which reads like "no matches"."""
    path = tmp_path / "mixed.sqlite3"
    built = VectorIndex.open(path, DeterministicHashEmbedder())
    built.index([IndexedDocument("event-1", "Sid drinks coffee")])
    built.close()

    with pytest.raises(VectorIndexError, match="rebuild"):
        VectorIndex.open(path, DeterministicHashEmbedder(dimensions=128))


def test_candidate_reports_failure_when_the_corpus_is_empty(tmp_path: Path) -> None:
    candidate = SqliteBlobCosineCandidate(
        DeterministicHashEmbedder(),
        fixture=GateFixture(documents=(), query="coffee"),
    )
    report = candidate.verify_install_index_query_rebuild_offline(tmp_path)

    assert report.passed is False
    assert report.failure_reason == "query returned no matches for the fixture corpus"


_CROSS_PROCESS_SCRIPT = """
import json
import sys

from jarvis_local.memory.embeddings import DeterministicHashEmbedder

sys.stdout.write(json.dumps(DeterministicHashEmbedder().embed(["Sid drinks coffee", "quarterly tax filing"])))
"""


def _embed_in_subprocess(*, hash_seed: str) -> list[list[float]]:
    package_root = Path(jarvis_local.__file__).resolve().parent.parent
    environment = dict(os.environ)
    environment["PYTHONHASHSEED"] = hash_seed
    environment["PYTHONPATH"] = str(package_root)
    # S603: the command is this interpreter and a literal script constant in
    # this file. A second process is the only way to observe the property
    # under test, since PYTHONHASHSEED is fixed before the process starts.
    completed = subprocess.run(  # noqa: S603
        [sys.executable, "-c", _CROSS_PROCESS_SCRIPT],
        capture_output=True,
        check=True,
        cwd=package_root,
        env=environment,
        text=True,
    )
    parsed: list[list[float]] = json.loads(completed.stdout)
    return parsed
