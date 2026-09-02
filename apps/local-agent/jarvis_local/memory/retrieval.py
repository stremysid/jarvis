"""Local retrieval over distilled memory.

Two rules govern every result and neither is negotiable:

* results are scoped to the authenticated principal, so one principal's
  memory can never surface in another's conversation;
* only `active` facts are returned -- a proposed fact must not influence
  behaviour, which is the entire point of the promotion boundary.

Every result carries its source event ids, so any statement Jarvis makes from
memory can be traced back to the archived events it came from.
"""

from __future__ import annotations

from dataclasses import dataclass

from jarvis_local.memory.facts import FactRepository, FactState, Sensitivity

# Retrieval purposes. Kept as an allowlist so a caller cannot invent one and
# bypass the checks attached to it.
CONVERSATION = "conversation"
DISTILLATION = "distillation"
ALLOWED_PURPOSES: frozenset[str] = frozenset({CONVERSATION, DISTILLATION})

DEFAULT_LIMIT = 8
MAX_LIMIT = 50


@dataclass(frozen=True, slots=True)
class MemorySearchResult:
    fact_id: str
    text: str
    source_event_ids: tuple[str, ...]
    sensitivity: Sensitivity
    score: float


def escape_fts_query(query: str) -> str:
    """Render arbitrary text as a single FTS5 phrase.

    FTS5 MATCH takes an expression language: bare input containing `"`, `*`,
    `NEAR`, `OR` or a column filter would be interpreted as syntax rather than
    searched for, which is both a correctness bug and a way to probe the index.
    Wrapping in quotes (doubling any inside) makes the whole thing a literal
    phrase.
    """
    return '"' + query.replace('"', '""') + '"'


class LocalMemoryRetriever:
    """Full-text retrieval over active facts, scoped to one principal."""

    def __init__(self, repository: FactRepository) -> None:
        self._repository = repository

    def search(
        self,
        query: str,
        *,
        principal_id: str,
        purpose: str,
        limit: int = DEFAULT_LIMIT,
    ) -> list[MemorySearchResult]:
        if purpose not in ALLOWED_PURPOSES:
            raise ValueError(f"unknown retrieval purpose: {purpose}")
        if not principal_id:
            raise ValueError("retrieval requires a principal")
        if limit < 1:
            raise ValueError("limit must be at least 1")
        # Bounded regardless of what the caller asks for: retrieval feeds a
        # model prompt with a fixed context budget.
        limit = min(limit, MAX_LIMIT)

        stripped = query.strip()
        if not stripped:
            return []

        rows = self._repository.connection.execute(
            """
            SELECT fact.fact_id, fact.text, fact.sensitivity, bm25(fact_search) AS score
            FROM fact_search
            JOIN fact ON fact.fact_id = fact_search.fact_id
            WHERE fact_search MATCH ?
              AND fact.principal_id = ?
              AND fact.state = ?
            ORDER BY score ASC
            LIMIT ?
            """,
            (escape_fts_query(stripped), principal_id, str(FactState.ACTIVE), limit),
        ).fetchall()

        return [
            MemorySearchResult(
                fact_id=row[0],
                text=row[1],
                source_event_ids=self._repository.get(row[0]).source_event_ids,
                sensitivity=Sensitivity(row[2]),
                score=float(row[3]),
            )
            for row in rows
        ]
