"""Making current heads findable, using the search stack that already exists.

There is no second search engine here. Full text comes from SQLite FTS5, the
same feature `memory/migrations/0002_fact_search.sql` uses, and semantic
ranking comes from `memory.vector_index.VectorIndex` -- the same exact-scan
cosine store, with the same float32 encoding and the same tie-break. A second
implementation would rank the same query differently from the first, and the
difference would show up as "Jarvis found it in memory but not in the vault".

The full-text rows are maintained by trigger, not from here. That is what
makes them impossible to get wrong: a head cannot move to text that search
cannot see, because the move and the index row are the same statement. What
this module owns is the *recovery* path -- rebuilding both indexes from the
observations, which must reproduce exactly what the triggers built, or the
indexes were never derived data in the first place.

Vectors are keyed by the head's observation id rather than by document id.
An observation is immutable, so a vector built from one can never describe
text that has since changed; a document-keyed vector would silently go stale
the moment a head moved.
"""

from __future__ import annotations

from dataclasses import dataclass

from jarvis_local.memory.vector_index import IndexedDocument, VectorIndex
from jarvis_local.vault.models import VaultNoteOperationV1
from jarvis_local.vault.repository import VaultRepository


@dataclass(frozen=True, slots=True)
class IndexProgress:
    full_text_rows: int = 0
    vector_rows: int = 0


class VaultIndexer:
    """Rebuilds the derived indexes over the vault's current heads."""

    def __init__(self, repository: VaultRepository, *, vector_index: VectorIndex | None = None) -> None:
        self._repository = repository
        #: Must be opened on a vault-only file. `VectorIndex.rebuild` clears
        #: every row for its model, so pointing this at the index the archive
        #: uses would delete the archive's vectors on the first vault rebuild.
        #: Separate files also keep the isolation rule below structural: the
        #: ordinary retrieval path cannot reach a store it does not open.
        self._vectors = vector_index

    def current_head_documents(self, vault_id: str) -> tuple[IndexedDocument, ...]:
        """Every non-tombstoned head, as text ready to index.

        Tombstoned heads are excluded rather than indexed as empty strings: an
        empty document still matches a semantic query weakly, so a deleted
        note would keep surfacing with a low score and no text to show.
        """
        documents: list[IndexedDocument] = []
        for head in self._repository.current_heads(vault_id):
            if head.operation is VaultNoteOperationV1.TOMBSTONED:
                continue
            observation = self._repository.observation(head.observation_id)
            if observation is None:  # pragma: no cover - a head references a row that exists
                continue
            documents.append(IndexedDocument(event_id=observation.observation_id, text=observation.canonical_text))
        return tuple(documents)

    def rebuild(self, vault_id: str, *, now: str | None = None) -> IndexProgress:
        return IndexProgress(
            full_text_rows=self.rebuild_full_text(vault_id),
            vector_rows=self.rebuild_vectors(vault_id, now=now),
        )

    def rebuild_full_text(self, vault_id: str) -> int:
        """Discard and rebuild the FTS rows for this vault's heads.

        Clears before inserting because the failure this recovers from is a
        *stale* row -- an index restored from a backup taken before a
        tombstone. Upserting would leave the deleted note searchable.
        """
        connection = self._repository.connection
        connection.execute("BEGIN")
        try:
            for head in self._repository.current_heads(vault_id):
                connection.execute("DELETE FROM vault_head_search WHERE document_id = ?", (head.document_id,))
            rows = 0
            for head in self._repository.current_heads(vault_id):
                if head.operation is VaultNoteOperationV1.TOMBSTONED:
                    continue
                observation = self._repository.observation(head.observation_id)
                if observation is None:  # pragma: no cover
                    continue
                connection.execute(
                    "INSERT INTO vault_head_search (document_id, observation_id, text) VALUES (?, ?, ?)",
                    (head.document_id, observation.observation_id, observation.canonical_text),
                )
                rows += 1
        except Exception:
            connection.execute("ROLLBACK")
            raise
        connection.execute("COMMIT")
        return rows

    def rebuild_vectors(self, vault_id: str, *, now: str | None = None) -> int:
        """Re-embed every current head. A no-op when no index was supplied."""
        if self._vectors is None:
            return 0
        return self._vectors.rebuild(self.current_head_documents(vault_id), now=now)
