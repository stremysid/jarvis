"""Turn archived events into fact proposals.

The agent coordinates distillation but never holds the model key. It selects
canonical post-redaction excerpts, submits them to the cloud gateway over a
signed request, and stores what comes back. The gateway is what talks to the
model.

Everything returned by a model is treated as a claim, not a result:

* the origin is always MODEL, whatever the response says. A model that returns
  `origin: authenticated_first_person` would otherwise promote itself past the
  boundary that exists specifically to stop that;
* every cited source must be one of the excerpts we sent. A fact citing an
  event we did not supply is either a hallucination or an attempt to attach a
  claim to unrelated evidence, and provenance is the whole basis on which a
  fact is later trusted;
* anything shaped like a tool call or an instruction is refused outright.

A proposal that fails any of these is dropped, not repaired. Repairing it
would mean guessing what the model meant, and a fact is a thing Jarvis will
later state as true.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.clock import utc_now_iso
from jarvis_local.memory.facts import (
    Fact,
    FactOrigin,
    FactProposal,
    FactRepository,
    Sensitivity,
)
from jarvis_local.memory.projection_policy import MAX_SOURCES_PER_FACT, representable_fact_text
from jarvis_local.sync.cursor_store import CursorStore

DISTILLER = "distiller"

#: Bounded so one run cannot submit an unbounded prompt or an unbounded bill.
MAX_EXCERPTS_PER_RUN = 32
MAX_EXCERPT_CHARACTERS = 4_000

#: Event types worth distilling. An allowlist: a new event type is ignored
#: until someone decides what a fact drawn from it would even mean.
DISTILLABLE_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "conversation.user_committed",
        "conversation.assistant_delivered",
    }
)

#: Keys that indicate the model tried to do something rather than observe
#: something. Their presence fails the proposal outright.
FORBIDDEN_PROPOSAL_KEYS: frozenset[str] = frozenset(
    {"tool", "tool_call", "function", "function_call", "action", "command", "state"}
)


@dataclass(frozen=True, slots=True)
class Excerpt:
    source_event_id: str
    text: str


@dataclass(frozen=True, slots=True)
class DistillationProgress:
    excerpts_submitted: int
    proposals_recorded: int
    proposals_rejected: int
    through_sequence: int


class DistillationClient(Protocol):
    """The cloud side of distillation, as this module needs it."""

    def distill(self, excerpts: Sequence[Excerpt]) -> Sequence[dict[str, Any]]: ...


class DistillationCoordinator:
    """Selects excerpts, submits them, and records what survives validation."""

    def __init__(
        self,
        archive: ArchiveRepository,
        facts: FactRepository,
        client: DistillationClient,
        *,
        principal_id: str,
        consumer: str = DISTILLER,
    ) -> None:
        self.archive = archive
        self.facts = facts
        self.client = client
        self.principal_id = principal_id
        self.consumer = consumer
        # Progress lives beside the replication cursor, in the archive
        # database, so "distilled up to here" cannot disagree with "replicated
        # up to here" across a crash.
        self.cursors = CursorStore(archive.connection)

    def run_once(self, *, now: str | None = None) -> DistillationProgress:
        cursor = self.cursors.cursor(self.consumer)
        excerpts = self._select(cursor)
        if not excerpts:
            return DistillationProgress(0, 0, 0, cursor)

        supplied = {excerpt.source_event_id for excerpt in excerpts}
        proposals = self.client.distill(excerpts)

        recorded = 0
        rejected = 0
        for raw in proposals:
            proposal = self._validate(raw, supplied)
            if proposal is None:
                rejected += 1
                continue
            self.facts.record_proposal(proposal, now=now or utc_now_iso())
            recorded += 1

        # Advanced only after the proposals are durable. A crash before this
        # re-distills the same events, which costs a model call; advancing
        # first would skip them permanently.
        through = self._highest(excerpts)
        self.cursors.advance_and_stage_ack(through, consumer=self.consumer, now=now)
        self.cursors.clear_pending_ack(self.consumer)
        return DistillationProgress(len(excerpts), recorded, rejected, through)

    # -- internals --------------------------------------------------------

    def _select(self, after_sequence: int) -> list[Excerpt]:
        selected: list[Excerpt] = []
        for event in self.archive.events_after(after_sequence):
            if len(selected) >= MAX_EXCERPTS_PER_RUN:
                break
            if event.event_type not in DISTILLABLE_EVENT_TYPES:
                continue
            text = event.canonical_text[:MAX_EXCERPT_CHARACTERS]
            if not text.strip():
                continue
            selected.append(Excerpt(source_event_id=event.event_id, text=text))
        return selected

    def _highest(self, excerpts: Sequence[Excerpt]) -> int:
        """The sequence through which this run has now considered events.

        Uses the archive's own ordering rather than the excerpt list, because
        events skipped as undistillable have still been considered and must not
        be re-examined on every future run.
        """
        cursor = self.cursors.cursor(self.consumer)
        highest = cursor
        seen = 0
        for event in self.archive.events_after(cursor):
            if seen >= MAX_EXCERPTS_PER_RUN and event.event_type in DISTILLABLE_EVENT_TYPES:
                break
            if event.event_type in DISTILLABLE_EVENT_TYPES and event.canonical_text.strip():
                seen += 1
            highest = event.event_sequence
        return highest

    # `raw` is whatever the model returned: untrusted, unvalidated, and Any
    # by definition. Narrowing it is this function's entire job.
    def _validate(
        self,
        raw: Any,  # noqa: ANN401 - untrusted model output; narrowing it is the job
        supplied: frozenset[str] | set[str],
    ) -> FactProposal | None:
        if not isinstance(raw, dict):
            return None
        if FORBIDDEN_PROPOSAL_KEYS & set(raw):
            # The model tried to act rather than observe.
            return None

        text = raw.get("text")
        if not isinstance(text, str) or not text.strip():
            return None
        if not representable_fact_text(text):
            return None

        sources = raw.get("sourceEventIds")
        if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_SOURCES_PER_FACT:
            # A fact with no provenance is an assertion with no evidence.
            return None
        if any(not isinstance(source, str) for source in sources):
            return None
        if not set(sources) <= set(supplied):
            # Cites something we did not submit.
            return None

        confidence = raw.get("confidence", 1.0)
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            return None
        if not 0.0 <= float(confidence) <= 1.0:
            return None

        sensitivity = (
            Sensitivity.SENSITIVE if raw.get("sensitivity") == "sensitive" else Sensitivity.NORMAL
        )

        return FactProposal(
            principal_id=self.principal_id,
            text=text.strip(),
            # Always MODEL. The response does not get a say: this is precisely
            # the boundary that keeps an inference from promoting itself.
            origin=FactOrigin.MODEL,
            source_event_ids=tuple(sources),
            sensitivity=sensitivity,
            confidence=float(confidence),
        )


def promote_new_facts(facts: FactRepository, principal_id: str) -> list[Fact]:
    """Apply promotion rules to everything currently proposed.

    Separate from distillation so the rules run identically whatever produced
    the proposal -- a model, a deterministic observation, or a correction.
    """
    from jarvis_local.memory.promotion import PromotionEngine

    engine = PromotionEngine(facts)
    promoted: list[Fact] = []
    rows = facts.connection.execute(
        "SELECT fact_id FROM fact WHERE principal_id = ? AND state = 'proposed'",
        (principal_id,),
    ).fetchall()
    for row in rows:
        fact = engine.promote(facts.get(row[0]))
        if fact.state.value == "active":
            promoted.append(fact)
    return promoted
