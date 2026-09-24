"""Distilled facts and their provenance.

Every fact cites the raw events it came from and records how it was derived.
`origin` is the load-bearing field: it decides whether a fact may become
active automatically, and it can never be edited afterwards.
"""

from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from enum import StrEnum
from pathlib import Path

import rfc8785

from jarvis_local.archive.content_store import normalize_nfc
from jarvis_local.clock import utc_now_iso
from jarvis_local.memory.database import MemoryDatabase


class FactOrigin(StrEnum):
    """How a fact came to exist. Determines promotion eligibility."""

    # Sid said it about himself, in a turn authenticated as him.
    AUTHENTICATED_FIRST_PERSON = "authenticated_first_person"
    # Derived by code from structured data, with no model judgement involved.
    DETERMINISTIC_OBSERVATION = "deterministic_observation"
    # A model inferred it. Never auto-promoted.
    MODEL = "model"
    # Someone who is not Sid said it. Never auto-promoted, whatever it claims.
    THIRD_PARTY = "third_party"


class FactState(StrEnum):
    PROPOSED = "proposed"
    ACTIVE = "active"
    SUPERSEDED = "superseded"


class Sensitivity(StrEnum):
    NORMAL = "normal"
    SENSITIVE = "sensitive"


@dataclass(frozen=True, slots=True)
class FactProposal:
    principal_id: str
    text: str
    origin: FactOrigin
    source_event_ids: tuple[str, ...]
    sensitivity: Sensitivity = Sensitivity.NORMAL
    confidence: float = 1.0
    distiller_version: str = "local-agent@0.1.0"


@dataclass(frozen=True, slots=True)
class Fact:
    fact_id: str
    principal_id: str
    text: str
    origin: FactOrigin
    state: FactState
    sensitivity: Sensitivity
    confidence: float
    distiller_version: str
    created_at: str
    content_hash: str
    source_event_ids: tuple[str, ...] = field(default_factory=tuple)


def fact_content_hash(principal_id: str, text: str, source_event_ids: Sequence[str]) -> str:
    """Stable identity for a fact: who it is about, what it says, and its sources."""
    return hashlib.sha256(
        rfc8785.dumps(
            {
                "principal_id": principal_id,
                "sources": sorted(source_event_ids),
                "text": normalize_nfc(text),
            }
        )
    ).hexdigest()


class FactRepository:
    """Insert-and-read access to distilled memory."""

    def __init__(self, database: MemoryDatabase) -> None:
        self._database = database

    @classmethod
    def open(
        cls,
        path: Path,
        *,
        now: str | None = None,
        store_root: Path | None = None,
        repair_permissions: bool = False,
    ) -> FactRepository:
        return cls(
            MemoryDatabase.open(
                Path(path),
                now=now or utc_now_iso(),
                store_root=store_root,
                repair_permissions=repair_permissions,
            )
        )

    @property
    def connection(self) -> sqlite3.Connection:
        return self._database.connection

    def close(self) -> None:
        self._database.close()

    def record_proposal(self, proposal: FactProposal, *, now: str | None = None) -> Fact:
        """Store a fact in `proposed` state.

        Everything starts proposed, including statements that will immediately
        qualify for promotion. Writing the proposal first means the record of
        what was proposed survives independently of the decision to promote it.
        """
        if not proposal.source_event_ids:
            raise ValueError("a fact must cite at least one source event")
        if not 0.0 <= proposal.confidence <= 1.0:
            raise ValueError(f"confidence out of range: {proposal.confidence}")

        text = normalize_nfc(proposal.text)
        content_hash = fact_content_hash(proposal.principal_id, text, proposal.source_event_ids)
        created_at = now or utc_now_iso()
        fact_id = f"fact_{content_hash[:32]}"

        existing = self.connection.execute("SELECT state FROM fact WHERE fact_id = ?", (fact_id,)).fetchone()
        if existing is not None:
            # Same principal, text and sources: this is a re-proposal, not new
            # information. Returning the stored fact keeps distillation
            # idempotent across retries.
            return self.get(fact_id)

        self.connection.execute("BEGIN")
        try:
            self.connection.execute(
                """
                INSERT INTO fact (fact_id, principal_id, text, origin, state, sensitivity,
                                  confidence, distiller_version, created_at, content_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fact_id,
                    proposal.principal_id,
                    text,
                    str(proposal.origin),
                    str(FactState.PROPOSED),
                    str(proposal.sensitivity),
                    float(proposal.confidence),
                    proposal.distiller_version,
                    created_at,
                    content_hash,
                ),
            )
            for position, source_event_id in enumerate(proposal.source_event_ids):
                self.connection.execute(
                    "INSERT INTO fact_source (fact_id, source_event_id, position) VALUES (?, ?, ?)",
                    (fact_id, source_event_id, position),
                )
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        self.connection.execute("COMMIT")
        return self.get(fact_id)

    def set_state(self, fact_id: str, state: FactState) -> Fact:
        """Move a fact's state. Content and provenance are protected by triggers."""
        self.connection.execute("UPDATE fact SET state = ? WHERE fact_id = ?", (str(state), fact_id))
        return self.get(fact_id)

    def supersede(self, *, superseding_fact_id: str, superseded_fact_id: str, now: str | None = None) -> None:
        """Record a correction as an edge, leaving both facts readable."""
        if superseding_fact_id == superseded_fact_id:
            raise ValueError("a fact cannot supersede itself")
        self.connection.execute("BEGIN")
        try:
            self.connection.execute(
                "INSERT INTO fact_supersession (superseding_fact_id, superseded_fact_id, created_at) VALUES (?, ?, ?)",
                (superseding_fact_id, superseded_fact_id, now or utc_now_iso()),
            )
            self.connection.execute(
                "UPDATE fact SET state = ? WHERE fact_id = ?", (str(FactState.SUPERSEDED), superseded_fact_id)
            )
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        self.connection.execute("COMMIT")

    def get(self, fact_id: str) -> Fact:
        row = self.connection.execute(
            """
            SELECT fact_id, principal_id, text, origin, state, sensitivity,
                   confidence, distiller_version, created_at, content_hash
            FROM fact WHERE fact_id = ?
            """,
            (fact_id,),
        ).fetchone()
        if row is None:
            raise KeyError(fact_id)
        sources = self.connection.execute(
            "SELECT source_event_id FROM fact_source WHERE fact_id = ? ORDER BY position ASC", (fact_id,)
        ).fetchall()
        return Fact(
            fact_id=row[0],
            principal_id=row[1],
            text=row[2],
            origin=FactOrigin(row[3]),
            state=FactState(row[4]),
            sensitivity=Sensitivity(row[5]),
            confidence=row[6],
            distiller_version=row[7],
            created_at=row[8],
            content_hash=row[9],
            source_event_ids=tuple(source[0] for source in sources),
        )

    def active_facts(self, principal_id: str) -> list[Fact]:
        rows = self.connection.execute(
            "SELECT fact_id FROM fact WHERE principal_id = ? AND state = ? ORDER BY created_at ASC",
            (principal_id, str(FactState.ACTIVE)),
        ).fetchall()
        return [self.get(row[0]) for row in rows]

    def count(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM fact").fetchone()[0])


def with_state(fact: Fact, state: FactState) -> Fact:
    return replace(fact, state=state)
