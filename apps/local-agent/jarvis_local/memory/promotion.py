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
_FIRST_PERSON_UNTRUSTED_FRAMING = (
    re.compile(r"(?<![A-Za-z0-9_])(?:if|unless|whether|when)(?![A-Za-z0-9_])", re.I | re.ASCII),
    re.compile(r"(?<![A-Za-z0-9_])(?:maybe|might)(?![A-Za-z0-9_])", re.I | re.ASCII),
    re.compile(r"(?<![A-Za-z0-9_])i\s+think(?![A-Za-z0-9_])", re.I | re.ASCII),
    re.compile(
        r"(?<![A-Za-z0-9_])i\s+(?:do\s+not|don['\N{RIGHT SINGLE QUOTATION MARK}]t)\s+know"
        r"(?![A-Za-z0-9_])",
        re.I | re.ASCII,
    ),
    re.compile(r"(?<![A-Za-z0-9_])not\s+sure(?![A-Za-z0-9_])", re.I | re.ASCII),
    re.compile(r"(?<![A-Za-z0-9_])(?:says|said|told)(?![A-Za-z0-9_])", re.I | re.ASCII),
)
_SENTENCE_PUNCTUATION = frozenset(".!?")
_ASCII_WHITESPACE = frozenset(" \t\r\n\f\v")


def _previous_non_whitespace(text: str, offset: int) -> int:
    index = offset - 1
    while index >= 0 and text[index] in _ASCII_WHITESPACE:
        index -= 1
    return index


def _is_whole_trusted_sentence(source_text: str, quote: str, offset: int) -> bool:
    end = offset + len(quote)
    before = _previous_non_whitespace(source_text, offset)
    if before >= 0 and source_text[before] not in _SENTENCE_PUNCTUATION:
        return False

    immediate_before = source_text[offset - 1] if offset > 0 else None
    immediate_after = source_text[end] if end < len(source_text) else None
    if immediate_before is not None and re.fullmatch(r"[A-Za-z0-9_]", immediate_before):
        return False
    if immediate_after is not None and re.fullmatch(r"[A-Za-z0-9_]", immediate_after):
        return False

    quote_terminator = quote[-1]
    terminator: str | None
    if quote_terminator in _SENTENCE_PUNCTUATION:
        terminator = quote_terminator
        if immediate_after is not None and immediate_after not in _ASCII_WHITESPACE:
            return False
    elif immediate_after is None:
        terminator = None
    elif immediate_after in _SENTENCE_PUNCTUATION:
        terminator = immediate_after
    else:
        return False

    if terminator == "?" or "?" in quote:
        return False
    return not any(pattern.search(quote) for pattern in _FIRST_PERSON_UNTRUSTED_FRAMING)


def is_authenticated_first_person_quote(
    *,
    quote: str,
    source_text: str,
    authenticated_owner: bool,
) -> bool:
    """Accept only one complete, unframed first-person owner sentence."""
    if not authenticated_owner:
        return False
    normalized_quote = unicodedata.normalize("NFC", quote).strip(" ")
    normalized_source = unicodedata.normalize("NFC", source_text)
    if not normalized_quote or has_fact_text_controls(normalized_quote):
        return False
    if _FIRST_PERSON_TOKEN.search(normalized_quote) is None:
        return False

    offset = normalized_source.find(normalized_quote)
    while offset != -1:
        if _is_whole_trusted_sentence(normalized_source, normalized_quote, offset):
            return True
        offset = normalized_source.find(normalized_quote, offset + 1)
    return False


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

        Only a proposed fact is eligible for automatic promotion. Active facts
        stay active, and superseded facts are never revived.
        """
        if fact.state is not FactState.PROPOSED:
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
