"""Refusal uses the gateway's redaction categories without rewriting facts."""

import pytest

from jarvis_local.memory.projection_policy import redaction_would_change


@pytest.mark.parametrize(
    "text",
    [
        "Order " + "6" * 6,
        "pin is " + "7" * 8,
        "authorization: synthetic",
        "bearer " + "a" * 15 + "1",
        'password="synthetic fixture"',
        "sk-" + "a" * 20,
        "-----BEGIN PRIVATE KEY-----not a key",
    ],
    ids=["digits", "context", "header", "bearer", "assignment", "known-prefix", "key-block"],
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
