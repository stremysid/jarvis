"""Projection limits and a refusal check matching contracts/src/calls.ts.

Refuse rather than rewrite a fact: changing text would change its identity and
the claim the owner confirmed. Keep these patterns aligned with the OWNER
audience of sanitizeRedaction.

A projected fact is Sid's own memory going from his own PC to his own cloud
store, so its reader is Sid. Sid, 2026-09-24: "there should be nothing between
Jarvis and I interms of what he knows and I know". His codes, PINs, phone
numbers and passphrases are therefore projected as they are. The only text
refused is a machine credential -- a private key, an Authorization header, a
bearer token or a known API-key/bot-token shape -- because that is what
Jarvis's own infrastructure secrets look like, and the cloud treats stored
memory as a fixed point of the owner redactor.
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
    return re.compile(pattern.replace(r"\s", f"[{_JS_WHITESPACE}]"), re.I | re.ASCII)


_REDACTED_PATTERNS = (
    _js_whitespace_pattern(
        r"\bauthorization\s*:\s*(?:bearer[ \t\r\n]+[A-Za-z0-9._~+/=-]+[^\r\n]*|[^\r\n]*)"
    ),
    re.compile(
        r"\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
        r"xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|"
        r"eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|"
        r"[0-9]{8,10}:[A-Za-z0-9_-]{35})\b",
        re.ASCII,
    ),
    re.compile(r"-----BEGIN ([A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*)-----"),
)
_BEARER = re.compile(r"\bbearer[ \t\r\n]+([A-Za-z0-9._~+/=-]{8,})", re.I | re.ASCII)


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
