"""Projection limits and a refusal check matching contracts/src/calls.ts.

Refuse rather than rewrite a fact: changing text would change its identity and
the claim the owner confirmed. Keep these patterns aligned with sanitizeRedaction.
"""

import re

MAX_FACT_BYTES = 4_096
MAX_SOURCES_PER_FACT = 8

_REDACTED_PATTERNS = (
    re.compile(r"(?<![0-9])[0-9]{6}(?![0-9])"),
    re.compile(
        r"\b(?:pin|passcode|otp|authentication(?:[_ -]?code)?|verification(?:[_ -]?code)?)"
        r"(?:\s+is)?\s*[=:]?\s*[0-9]{8}(?![0-9])",
        re.I | re.ASCII,
    ),
    re.compile(r"\bauthorization\s*:\s*[^\r\n]*", re.I | re.ASCII),
    re.compile(
        r"(?<![A-Za-z0-9])([\"']?)(?:api(?:[_-]|\s+)?key|password|client(?:[_-]|\s+)?secret|access(?:[_-]|\s+)?token|token|secret)\1\s*[=:]\s*(?:\"(?:\\[^\r\n]|[^\"\\\r\n])*(?:\"|(?=\r?\n|$))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|(?=\r?\n|$))|[^\s,;]+)",
        re.I | re.ASCII,
    ),
    re.compile(
        r"\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b",
        re.ASCII,
    ),
    re.compile(r"-----BEGIN ([A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*)-----"),
)
_BEARER = re.compile(r"\bbearer[ \t]+([A-Za-z0-9._~+/=-]{8,})", re.I | re.ASCII)


def redaction_would_change(text: str) -> bool:
    if any(pattern.search(text) for pattern in _REDACTED_PATTERNS):
        return True
    return any(
        len(value) >= 16 and re.search(r"[A-Za-z]", value) and re.search(r"[0-9._~+/=-]", value)
        for value in _BEARER.findall(text)
    )


def representable_fact_text(text: str) -> bool:
    try:
        return len(text.encode("utf-8")) <= MAX_FACT_BYTES and not redaction_would_change(text)
    except UnicodeError:
        return False
