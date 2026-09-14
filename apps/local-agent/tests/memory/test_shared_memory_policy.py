from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from jarvis_local.memory.distillation import validate_extraction_proposal
from jarvis_local.memory.facts import Fact, FactOrigin, FactState, Sensitivity
from jarvis_local.memory.promotion import (
    PromotionEngine,
    is_authenticated_first_person_quote,
    is_uncertain_origin,
)

_VECTORS_PATH = (
    Path(__file__).resolve().parents[4]
    / "tests"
    / "fixtures"
    / "memory-extraction-policy.json"
)
_VECTORS: dict[str, Any] = json.loads(_VECTORS_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "test_case",
    _VECTORS["firstPersonCases"],
    ids=lambda test_case: str(test_case["name"]),
)
def test_first_person_classifier_matches_shared_vectors(
    test_case: dict[str, Any],
) -> None:
    assert (
        is_authenticated_first_person_quote(
            quote=test_case["quote"],
            source_text=test_case["sourceText"],
            authenticated_owner=test_case["authenticatedOwner"],
        )
        is test_case["expected"]
    )


@pytest.mark.parametrize(
    "test_case",
    _VECTORS["promotionCases"],
    ids=lambda test_case: str(test_case["name"]),
)
def test_promotion_engine_matches_shared_vectors(test_case: dict[str, Any]) -> None:
    origin = FactOrigin(test_case["origin"])
    fact = Fact(
        fact_id="fact-shared-vector",
        principal_id="sid",
        text="Shared-vector fact",
        origin=origin,
        state=FactState(test_case["currentState"]),
        sensitivity=Sensitivity.NORMAL,
        confidence=0.8,
        distiller_version="shared-vector@1.0.0",
        created_at="2026-09-14T12:00:00.000Z",
        content_hash="0" * 64,
        source_event_ids=("01k4z8m0q2a3b4c5d6e7f8g9h0",),
    )

    promoted = PromotionEngine().promote(fact)

    assert promoted.state.value == test_case["expectedState"]
    assert is_uncertain_origin(origin) is test_case["expectedUncertain"]
    assert test_case["expectedConfirmed"] is False


@pytest.mark.parametrize(
    "test_case",
    _VECTORS["validationCases"],
    ids=lambda test_case: str(test_case["name"]),
)
def test_extraction_validation_matches_shared_vectors(
    test_case: dict[str, Any],
) -> None:
    proposal = validate_extraction_proposal(
        test_case["proposal"],
        frozenset(test_case["suppliedSourceEventIds"]),
        principal_id="sid",
    )

    expected = test_case["expected"]
    if expected is None:
        assert proposal is None
        return

    assert proposal is not None
    assert {
        "text": proposal.text,
        "sourceEventIds": list(proposal.source_event_ids),
        "confidence": proposal.confidence,
        "sensitivity": proposal.sensitivity.value,
        "origin": proposal.origin.value,
        "uncertain": is_uncertain_origin(proposal.origin),
    } == expected
