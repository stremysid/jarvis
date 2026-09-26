"""Refusal uses the gateway's owner-audience redaction without rewriting facts.

A projected fact is Sid's own memory going to his own cloud store, so Sid's
codes, PINs, phone numbers and passphrases are projected as they are. Only a
machine credential (Jarvis's infrastructure-secret shapes) is refused.
"""

import json
from pathlib import Path

import pytest

from jarvis_local.memory.projection_policy import redaction_would_change, representable_fact_text

VECTORS = json.loads(
    (Path(__file__).resolve().parents[4] / "tests/fixtures/memory-projection-policy.json").read_text("utf-8")
)
GAPS = json.loads(
    (Path(__file__).resolve().parents[4] / "tests/fixtures/redaction-gaps.json").read_text("utf-8")
)


@pytest.mark.parametrize("case", GAPS, ids=lambda case: case["name"])
def test_redaction_gaps_match_the_gateway_owner_decision(case: dict[str, str | bool]) -> None:
    text = str(case["text"])
    assert redaction_would_change(text) is case["refuse"]
    assert (text != case["owner"]) is case["refuse"]


def expand(text: str) -> str:
    return (
        text.replace("<six>", "6" * 6)
        .replace("<eight>", "7" * 8)
        .replace("<four>", "4" * 4)
        .replace("<bearer>", "a" * 15 + "1")
    )


@pytest.mark.parametrize("case", VECTORS["redactionCases"], ids=lambda case: case["name"])
def test_shared_redaction_decisions(case: dict[str, object]) -> None:
    assert redaction_would_change(expand(str(case["text"]))) is case["refuse"]


@pytest.mark.parametrize("code_point", VECTORS["jsWhitespaceCodePoints"])
def test_shared_ecmascript_whitespace(code_point: int) -> None:
    for template in VECTORS["spaceTemplates"]:
        assert redaction_would_change(expand(template.replace("<space>", chr(code_point))))


@pytest.mark.parametrize("code_point", VECTORS["factControlCodePoints"])
def test_fact_controls_are_refused_without_rewriting(code_point: int) -> None:
    assert not representable_fact_text("Coffee" + chr(code_point) + "- forged entry")


def test_shared_fact_byte_boundary_is_enforced_by_the_python_producer() -> None:
    maximum = int(VECTORS["maxFactBytes"])
    assert representable_fact_text("x" * maximum)
    assert not representable_fact_text("x" * (maximum + 1))


@pytest.mark.parametrize(
    "text",
    [
        "authorization: synthetic",
        "bearer " + "a" * 15 + "1",
        "sk-" + "a" * 20,
        "123456789:" + "A" * 35,
        "-----BEGIN PRIVATE KEY-----not a key",
    ],
    ids=["header", "bearer", "known-prefix", "bot-token", "key-block"],
)
def test_every_machine_credential_category_is_refused(text: str) -> None:
    assert redaction_would_change(text)


@pytest.mark.parametrize(
    "text",
    [
        "A coffee preference",
        "My sign-in code is " + "6" * 6,
        "my pin is 4821",
        "pin is " + "7" * 8,
        "Call (555) 555-0100",
        "my passphrase is synthetic meadow lantern",
        'password="synthetic fixture"',
        "Order " + "8" * 8,
        "bearer of good news",
        "[REDACTED_AUTH_DIGITS]",
        "é" * 2048,
    ],
    ids=[
        "ordinary", "sign-in-code", "pin", "eight-digit-pin", "phone", "passphrase", "password",
        "eight-digits", "ordinary-bearer", "already-redacted", "unicode",
    ],
)
def test_sids_own_data_is_projected_as_it_is(text: str) -> None:
    assert not redaction_would_change(text)
    assert representable_fact_text(text)
