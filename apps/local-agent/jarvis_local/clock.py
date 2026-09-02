"""Timestamps in the one format every Jarvis payload uses.

RFC 3339, UTC, milliseconds. Centralised so that archive rows, observations,
and sync receipts cannot drift into different shapes and then fail to sort
against one another.
"""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now_iso() -> str:
    return format_iso(datetime.now(UTC))


def format_iso(moment: datetime) -> str:
    """RFC 3339 UTC with exactly three fractional digits and a `Z` suffix."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"
