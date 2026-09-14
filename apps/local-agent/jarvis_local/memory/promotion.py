"""Which proposed facts may become active without Sid confirming them.

Version 0.1.0 auto-promotes exactly two kinds:

* explicit first-person statements from Sid's own authenticated turns
* deterministic observations defined in code

Everything else stays `proposed`. That boundary is the whole defence against
a model's guess, or something a third party said, quietly becoming a fact that
steers Jarvis's behaviour. A proposed fact cannot affect policy or proactive
behaviour and is not projected to the cloud until confirmed.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from jarvis_local.memory.facts import (
    Fact,
    FactOrigin,
    FactRepository,
    FactState,
    with_state,
)
from jarvis_local.memory.projection_policy import has_fact_text_controls

# Deliberately an allowlist. An origin added later defaults to staying
# proposed rather than silently inheriting promotion.
AUTO_PROMOTABLE_ORIGINS: frozenset[FactOrigin] = frozenset(
    {
        FactOrigin.AUTHENTICATED_FIRST_PERSON,
        FactOrigin.DETERMINISTIC_OBSERVATION,
    }
)

_FIRST_PERSON_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(?:i(?:['\N{RIGHT SINGLE QUOTATION MARK}](?:m|ve|d|ll))?|me|my|mine|myself)(?![A-Za-z0-9_])",
    re.IGNORECASE | re.ASCII,
)


def is_authenticated_first_person_quote(
    *,
    quote: str,
    source_text: str,
    authenticated_owner: bool,
) -> bool:
    """Accept only an exact first-person quote from the authenticated owner."""
    if not authenticated_owner:
        return False
    normalized_quote = unicodedata.normalize("NFC", quote).strip(" ")
    normalized_source = unicodedata.normalize("NFC", source_text)
    if not normalized_quote or has_fact_text_controls(normalized_quote):
        return False
    return normalized_quote in normalized_source and _FIRST_PERSON_TOKEN.search(normalized_quote) is not None


def is_uncertain_origin(origin: FactOrigin) -> bool:
    """Model inference is explicitly uncertain until Sid confirms it."""
    return origin is FactOrigin.MODEL


@dataclass(frozen=True, slots=True)
class PromotionEngine:
    """Deterministic promotion. No model is consulted here, by design.

    The repository is optional so promotion rules can be exercised as pure
    logic; when present, the decision is persisted.
    """

    repository: FactRepository | None = None

    def is_auto_promotable_origin(self, origin: FactOrigin) -> bool:
        return origin in AUTO_PROMOTABLE_ORIGINS

    def is_auto_promotable(self, fact: Fact) -> bool:
        return self.is_auto_promotable_origin(fact.origin)

    def promote(self, fact: Fact) -> Fact:
        """Return the fact in the state it is entitled to.

        A superseded fact is never revived: a correction already replaced it,
        and re-promoting it would resurrect the claim Sid corrected.
        """
        if fact.state is FactState.SUPERSEDED:
            return fact
        target = FactState.ACTIVE if self.is_auto_promotable(fact) else FactState.PROPOSED
        return self._apply(fact, target)

    def confirm(self, fact: Fact) -> Fact:
        """Activate a fact on Sid's explicit confirmation.

        This is the only route by which a model-inferred or third-party fact
        becomes active, so that confirmation is an action rather than an
        inference.
        """
        if fact.state is FactState.SUPERSEDED:
            raise ValueError("a superseded fact cannot be confirmed")
        return self._apply(fact, FactState.ACTIVE)

    def _apply(self, fact: Fact, state: FactState) -> Fact:
        if self.repository is None:
            return with_state(fact, state)
        return self.repository.set_state(fact.fact_id, state)
