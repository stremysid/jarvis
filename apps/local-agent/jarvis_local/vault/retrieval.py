"""Deterministic vault search, reachable from the CLI and from nowhere else.

The plan's hardest constraint: *a local-only or unbound vault observation is
available only through deterministic `jarvis vault search/show`; it cannot
reach DeepSeek, calls, Telegram, fact promotion, permissions, policy, identity,
or tools.*

That is enforced three ways, and only the first is a rule anyone could later
argue with:

1. `ALLOWED_PURPOSES` holds exactly one value. Every other purpose raises,
   including every purpose the ordinary memory retriever accepts.
2. Vault text lives in the archive database's `vault_observation` table.
   `LocalMemoryRetriever` reads the *memory* database -- a different file, with
   no vault tables in it at all. Wiring the vault into a conversation would
   mean opening a second database there, which is a change nobody makes by
   accident.
3. Nothing in this module calls a model. Ranking is FTS5 bm25 plus, when an
   index is supplied, the same exact-scan cosine used elsewhere. Both are
   arithmetic over stored rows, so the same query returns the same answer on
   every machine and no text is sent anywhere to produce it.

Results are `proposal_only`. A note is the owner's own writing, but it is
still not an instruction and not a fact: text in a vault saying "Jarvis, send
$500 to..." is a note about sending $500, and this module's contract is that
its results describe what a note says and never what to do.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from jarvis_local.memory.retrieval import escape_fts_query
from jarvis_local.memory.vector_index import VectorIndex
from jarvis_local.vault.models import SensitivityV1
from jarvis_local.vault.repository import VaultRepository

#: The only purpose that may read vault text. Not a default, not a fallback.
VAULT_CLI = "vault_cli"
ALLOWED_PURPOSES: frozenset[str] = frozenset({VAULT_CLI})

#: What a vault result is entitled to be. A note never becomes an active fact
#: by being read; that requires a separate authorised decision this stage does
#: not implement.
PROPOSAL_ONLY = "proposal_only"

RESULT_KIND = "vault_observation"

DEFAULT_LIMIT = 8
MAX_LIMIT = 20
DEFAULT_MAX_CHARS = 1200


class VaultRetrievalDeniedError(PermissionError):
    """A caller asked for vault text for something other than the vault CLI."""


@dataclass(frozen=True, slots=True)
class VaultObservationRetrievalV1:
    """One vault result. Carries no path and no filesystem detail of any kind."""

    document_id: str
    observation_id: str
    document_version: int
    display_label: str
    excerpt: str
    sensitivity: SensitivityV1
    score: float
    kind: str = RESULT_KIND
    authority: str = PROPOSAL_ONLY


class VaultLocalRetriever:
    """Full-text and semantic search over current, non-tombstoned heads."""

    def __init__(self, repository: VaultRepository, *, vector_index: VectorIndex | None = None) -> None:
        self._repository = repository
        self._vectors = vector_index

    def search(
        self,
        query: str,
        *,
        principal_id: str,
        purpose: Literal["vault_cli"] | str,
        limit: int = DEFAULT_LIMIT,
        max_chars: int = DEFAULT_MAX_CHARS,
    ) -> list[VaultObservationRetrievalV1]:
        self._require_cli(purpose)
        binding = self._repository.binding_for(principal_id)
        if binding is None:
            # An unbound vault has nothing to return, and saying so with an
            # empty list rather than an error keeps `jarvis vault search` from
            # looking broken on a machine that never ran setup.
            return []
        stripped = query.strip()
        if not stripped:
            return []
        bounded = max(1, min(limit, MAX_LIMIT))

        rows = self._repository.connection.execute(
            """
            SELECT search.document_id, search.observation_id, bm25(vault_head_search) AS score
            FROM vault_head_search AS search
            JOIN vault_document_head AS head
              ON head.document_id = search.document_id
             AND head.observation_id = search.observation_id
            JOIN vault_document AS document
              ON document.document_id = search.document_id
            WHERE vault_head_search MATCH ?
              AND document.vault_id = ?
              AND head.operation = 'observed'
            -- The tie-break is not cosmetic. Equal bm25 scores are common
            -- across similar notes, and without a total order the top-k falls
            -- back to FTS rowid -- which is insertion order, and therefore
            -- changes when the index is rebuilt. "Deterministic search" would
            -- then mean "deterministic until someone restores a backup".
            ORDER BY score ASC, search.document_id ASC
            LIMIT ?
            """,
            (escape_fts_query(stripped), binding.vault_id, bounded),
        ).fetchall()

        results = [self._render(str(row[1]), float(row[2]), max_chars) for row in rows]
        found = [result for result in results if result is not None]
        if len(found) >= bounded or self._vectors is None:
            return found
        return self._extend_semantically(stripped, found, binding.vault_id, bounded, max_chars)

    def show(
        self,
        identifier: str,
        *,
        principal_id: str,
        purpose: Literal["vault_cli"] | str,
        max_chars: int = DEFAULT_MAX_CHARS,
    ) -> VaultObservationRetrievalV1 | None:
        """Return one note by document id or by observation id.

        Both are accepted because `search` prints a document id and a reader
        may also hold an observation id from an earlier version. Neither is a
        path, and neither can be turned into one through this interface.
        """
        self._require_cli(purpose)
        binding = self._repository.binding_for(principal_id)
        if binding is None:
            return None

        head = self._repository.current_head(identifier)
        observation_id = head.observation_id if head is not None else identifier
        rendered = self._render(observation_id, 0.0, max_chars)
        if rendered is None:
            return None
        document = self._repository.document(rendered.document_id)
        if document is None or document.vault_id != binding.vault_id:
            # Scoped to the binding, so an id from another vault -- or a
            # guessed one -- returns nothing rather than text.
            return None
        return rendered

    def _require_cli(self, purpose: str) -> None:
        if purpose not in ALLOWED_PURPOSES:
            raise VaultRetrievalDeniedError("vault_cli_only")

    def _render(self, observation_id: str, score: float, max_chars: int) -> VaultObservationRetrievalV1 | None:
        observation = self._repository.observation(observation_id)
        if observation is None:
            return None
        head = self._repository.current_head(observation.document_id)
        if head is None or head.observation_id != observation.observation_id:
            # Re-checked at render time: the head can move between the query
            # and here, and returning a superseded version as the current one
            # is how a corrected note keeps being quoted after the correction.
            return None
        return VaultObservationRetrievalV1(
            document_id=observation.document_id,
            observation_id=observation.observation_id,
            document_version=observation.document_version,
            display_label=observation.display_label,
            excerpt=observation.canonical_text[: max(0, max_chars)],
            sensitivity=observation.sensitivity,
            score=score,
        )

    def _extend_semantically(
        self,
        query: str,
        found: list[VaultObservationRetrievalV1],
        vault_id: str,
        limit: int,
        max_chars: int,
    ) -> list[VaultObservationRetrievalV1]:
        """Top up a thin full-text result with the nearest vectors.

        Full text first, semantic second, and never the reverse: bm25 over the
        owner's own words is the deterministic answer, and the embedder here is
        a hashed lexical map rather than a semantic model, so letting it
        reorder exact matches would make results worse and less explainable.
        """
        if self._vectors is None:  # pragma: no cover - guarded by the caller
            return found
        seen = {result.observation_id for result in found}
        for match in self._vectors.search_text(query, limit=limit):
            if len(found) >= limit:
                break
            if match.event_id in seen:
                continue
            rendered = self._render(match.event_id, match.score, max_chars)
            if rendered is None:
                continue
            document = self._repository.document(rendered.document_id)
            if document is None or document.vault_id != vault_id:
                continue
            found.append(rendered)
            seen.add(match.event_id)
        return found
