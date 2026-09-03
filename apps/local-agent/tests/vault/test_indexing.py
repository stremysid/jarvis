"""The indexes are derived data, and the proof of that is that rebuilding works.

If a rebuild from the observations produced different results from the
trigger-maintained rows, the index would be a second source of truth rather
than a cache -- and a restored backup would silently change what search
returns.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from jarvis_local.memory.embeddings import DeterministicHashEmbedder
from jarvis_local.memory.vector_index import VectorIndex
from jarvis_local.vault.indexing import VaultIndexer
from jarvis_local.vault.reconciliation import VaultReconciler
from jarvis_local.vault.repository import VaultBinding, VaultRepository
from jarvis_local.vault.retrieval import VAULT_CLI, VaultLocalRetriever
from tests.vault.conftest import PRINCIPAL, write_note


@pytest.fixture
def vectors(tmp_path: Path) -> Iterator[VectorIndex]:
    index = VectorIndex.open(tmp_path / "vault-vectors.sqlite3", DeterministicHashEmbedder())
    yield index
    index.close()


def test_a_head_becomes_searchable_in_the_same_statement_that_moves_it(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """No write path can leave a head that search cannot see.

    The reconciler never touches the full-text table; the trigger does. So a
    note being findable straight after a crawl is evidence the trigger, not
    the caller, is maintaining it.
    """
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso every morning")
    VaultReconciler(repository, binding).run()

    rows = repository.connection.execute("SELECT COUNT(*) FROM vault_head_search").fetchone()[0]
    assert rows == 1
    assert VaultLocalRetriever(repository).search("espresso", principal_id=PRINCIPAL, purpose=VAULT_CLI)


def test_an_edit_replaces_the_search_row_rather_than_adding_one(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso every morning")
    VaultReconciler(repository, binding).run()
    write_note(vault_root, "coffee.md", "# Coffee\n\ncortado every morning")
    VaultReconciler(repository, binding).run()

    retriever = VaultLocalRetriever(repository)
    assert repository.connection.execute("SELECT COUNT(*) FROM vault_head_search").fetchone()[0] == 1
    assert retriever.search("espresso", principal_id=PRINCIPAL, purpose=VAULT_CLI) == []
    assert retriever.search("cortado", principal_id=PRINCIPAL, purpose=VAULT_CLI)


def test_a_tombstone_removes_the_search_row(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso every morning")
    VaultReconciler(repository, binding).run()
    (vault_root / "coffee.md").unlink()
    VaultReconciler(repository, binding).run()

    assert repository.connection.execute("SELECT COUNT(*) FROM vault_head_search").fetchone()[0] == 0


def test_rebuilding_full_text_reproduces_what_the_triggers_built(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    for index in range(4):
        write_note(vault_root, f"note-{index}.md", f"# Note {index}\n\nsubject matter {index}")
    VaultReconciler(repository, binding).run()
    retriever = VaultLocalRetriever(repository)
    before = [r.observation_id for r in retriever.search("subject", principal_id=PRINCIPAL, purpose=VAULT_CLI)]

    repository.connection.execute("DELETE FROM vault_head_search")
    assert retriever.search("subject", principal_id=PRINCIPAL, purpose=VAULT_CLI) == []

    rebuilt = VaultIndexer(repository).rebuild_full_text(binding.vault_id)

    after = [r.observation_id for r in retriever.search("subject", principal_id=PRINCIPAL, purpose=VAULT_CLI)]
    assert rebuilt == 4
    assert after == before


def test_results_with_equal_scores_keep_a_stable_order_across_a_rebuild(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """Ties are broken explicitly, not by whatever order rows were inserted.

    These four notes are structurally identical for bm25, so their scores are
    equal. Without a tie-break the order falls back to FTS rowid, and a
    rebuild -- which reassigns rowids -- silently reorders the answer.
    """
    for index in range(4):
        write_note(vault_root, f"note-{index}.md", f"# Note {index}\n\nsubject matter {index}")
    VaultReconciler(repository, binding).run()
    retriever = VaultLocalRetriever(repository)
    before = [r.document_id for r in retriever.search("subject", principal_id=PRINCIPAL, purpose=VAULT_CLI)]

    repository.connection.execute("DELETE FROM vault_head_search")
    VaultIndexer(repository).rebuild_full_text(binding.vault_id)

    after = [r.document_id for r in retriever.search("subject", principal_id=PRINCIPAL, purpose=VAULT_CLI)]
    assert len(before) == 4
    assert after == before


def test_a_rebuild_drops_a_stale_row_left_by_an_older_index(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """The failure a rebuild exists to fix: a deleted note still searchable."""
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso")
    VaultReconciler(repository, binding).run()
    (vault_root / "coffee.md").unlink()
    VaultReconciler(repository, binding).run()

    head = repository.current_heads(binding.vault_id)[0]
    repository.connection.execute(
        "INSERT INTO vault_head_search (document_id, observation_id, text) VALUES (?, ?, ?)",
        (head.document_id, head.observation_id, "espresso"),
    )
    assert repository.connection.execute("SELECT COUNT(*) FROM vault_head_search").fetchone()[0] == 1

    VaultIndexer(repository).rebuild_full_text(binding.vault_id)

    assert repository.connection.execute("SELECT COUNT(*) FROM vault_head_search").fetchone()[0] == 0


def test_vectors_are_built_from_current_heads_and_keyed_by_observation(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path, vectors: VectorIndex
) -> None:
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso every morning")
    write_note(vault_root, "tea.md", "# Tea\n\ngenmaicha in the afternoon")
    VaultReconciler(repository, binding).run()

    indexed = VaultIndexer(repository, vector_index=vectors).rebuild_vectors(binding.vault_id)

    heads = {head.observation_id for head in repository.current_heads(binding.vault_id)}
    stored = {
        str(row[0]) for row in vectors.connection.execute("SELECT event_id FROM event_embedding")
    }
    assert indexed == 2
    assert stored == heads


def test_a_tombstoned_note_contributes_no_vector(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path, vectors: VectorIndex
) -> None:
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso")
    VaultReconciler(repository, binding).run()
    (vault_root / "coffee.md").unlink()
    VaultReconciler(repository, binding).run()

    assert VaultIndexer(repository, vector_index=vectors).rebuild_vectors(binding.vault_id) == 0


def test_the_semantic_index_extends_a_thin_full_text_result(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path, vectors: VectorIndex
) -> None:
    """Reuse, not reimplementation: the ranking is the memory vector index.

    Full-text finds the exact word; the vector index supplies neighbours the
    literal query missed, and both come from `memory/vector_index.py`.
    """
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso every morning")
    write_note(vault_root, "beans.md", "# Beans\n\nespresso beans from the roaster")
    VaultReconciler(repository, binding).run()
    VaultIndexer(repository, vector_index=vectors).rebuild_vectors(binding.vault_id)

    text_only = VaultLocalRetriever(repository).search(
        "roaster", principal_id=PRINCIPAL, purpose=VAULT_CLI, limit=5
    )
    with_vectors = VaultLocalRetriever(repository, vector_index=vectors).search(
        "roaster", principal_id=PRINCIPAL, purpose=VAULT_CLI, limit=5
    )

    assert len(text_only) == 1
    assert len(with_vectors) >= len(text_only)
    # Whatever it adds, the exact match still leads.
    assert with_vectors[0].observation_id == text_only[0].observation_id


def test_indexing_is_deterministic_across_rebuilds(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path, vectors: VectorIndex
) -> None:
    write_note(vault_root, "coffee.md", "# Coffee\n\nespresso every morning")
    VaultReconciler(repository, binding).run()
    indexer = VaultIndexer(repository, vector_index=vectors)

    indexer.rebuild_vectors(binding.vault_id)
    first = vectors.connection.execute("SELECT event_id, embedding FROM event_embedding").fetchall()
    indexer.rebuild_vectors(binding.vault_id)
    second = vectors.connection.execute("SELECT event_id, embedding FROM event_embedding").fetchall()

    assert first == second
