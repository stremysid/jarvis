"""Refusal uses the gateway's redaction categories without rewriting facts."""

import json
from pathlib import Path

import pytest

from jarvis_local.memory.projection_policy import redaction_would_change, representable_fact_text

VECTORS = json.loads(
    (Path(__file__).resolve().parents[4] / "tests/fixtures/memory-projection-policy.json").read_text("utf-8")
)


def expand(text: str) -> str:
    return (
        text.replace("<six>", "6" * 6)
        .replace("<eight>", "7" * 8)
        .replace("<four>", "4" * 4)
        .replace("<five>", "5" * 5)
        .replace("<nine>", "9" * 9)
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
        "Order " + "6" * 6,
        "pin is " + "7" * 8,
        "my pin is " + "4" * 4,
        "the passcode is " + "5" * 5,
        "otp:" + "9" * 9,
        "authorization: synthetic",
        "bearer " + "a" * 15 + "1",
        'password="synthetic fixture"',
        "sk-" + "a" * 20,
        "-----BEGIN PRIVATE KEY-----not a key",
    ],
    ids=[
        "digits",
        "context",
        "four-digit-pin",
        "five-digit-passcode",
        "nine-digit-otp",
        "header",
        "bearer",
        "assignment",
        "known-prefix",
        "key-block",
    ],
)
def test_every_redaction_category_is_refused(text: str) -> None:
    assert redaction_would_change(text)


@pytest.mark.parametrize(
    "text",
    [
        "A coffee preference",
        "Order " + "7" * 7,
        "Order " + "8" * 8,
        "bearer of good news",
        "[REDACTED_AUTH_DIGITS]",
        "é" * 2048,
    ],
    ids=["ordinary", "seven-digits", "eight-digits", "ordinary-bearer", "already-redacted", "unicode"],
)
def test_ordinary_facts_are_not_rewritten_or_refused(text: str) -> None:
    assert not redaction_would_change(text)
