"""Projection limits and a refusal check matching contracts/src/calls.ts.

Refuse rather than rewrite a fact: changing text would change its identity and
the claim the owner confirmed. Keep these patterns aligned with sanitizeRedaction.
"""

import re

MAX_FACT_BYTES = 4_096
MAX_SOURCES_PER_FACT = 8

# JavaScript keeps ASCII word/case rules but gives \s this Unicode set.
# Python's Unicode mode also changes \b and case folding, and misses U+FEFF.
# Both runtimes exercise tests/fixtures/memory-projection-policy.json.
_JS_WHITESPACE = r"\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_FACT_CONTROLS = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")


def _js_whitespace_pattern(pattern: str) -> re.Pattern[str]:
    # Expand the one negated whitespace class before replacing standalone atoms.
    pattern = pattern.replace(r"[^\s,;]", f"[^{_JS_WHITESPACE},;]")
    return re.compile(pattern.replace(r"\s", f"[{_JS_WHITESPACE}]"), re.I | re.ASCII)


_REDACTED_PATTERNS = (
    re.compile(r"(?<![0-9])[0-9]{6}(?![0-9])"),
    _js_whitespace_pattern(
        r"\b(?:pin|passcode|otp|authentication(?:[_ -]?code)?|verification(?:[_ -]?code)?)"
        r"(?:\s+is)?\s*[=:]?\s*[0-9]{8}(?![0-9])",
    ),
    _js_whitespace_pattern(r"\bauthorization\s*:\s*[^\r\n]*"),
    _js_whitespace_pattern(
        r"(?<![A-Za-z0-9])([\"']?)(?:api(?:[_-]|\s+)?key|password|client(?:[_-]|\s+)?secret|access(?:[_-]|\s+)?token|token|secret)\1\s*[=:]\s*(?:\"(?:\\[^\r\n]|[^\"\\\r\n])*(?:\"|(?=\r?\n|$))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|(?=\r?\n|$))|[^\s,;]+)",
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


def has_fact_text_controls(text: str) -> bool:
    return _FACT_CONTROLS.search(text) is not None


def representable_fact_text(text: str) -> bool:
    try:
        return (
            len(text.encode("utf-8")) <= MAX_FACT_BYTES
            and not has_fact_text_controls(text)
            and not redaction_would_change(text)
        )
    except UnicodeError:
        return False
