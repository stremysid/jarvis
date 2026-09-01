"""Strict JSON decoding and RFC 8785 canonicalization."""

from __future__ import annotations

import hashlib
import json
import math
import unicodedata
from typing import Any, NoReturn, cast

import rfc8785


class CanonicalJsonError(ValueError):
    """Raised when input is outside the strict canonical JSON domain."""


def _fail(message: str) -> NoReturn:
    raise CanonicalJsonError(f"invalid canonical JSON: {message}")


def _reject_duplicate_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _fail(f"duplicate object key {key!r}")
        result[key] = value
    return result


def _reject_nonfinite_constant(value: str) -> NoReturn:
    _fail(f"non-finite number {value} is unsupported")


def _validate_text(value: str) -> None:
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail("text must be well-formed UTF-8")
    if unicodedata.normalize("NFC", value) != value:
        _fail("text must be NFC")


def _validate_json_value(value: object) -> None:
    if value is None or type(value) is bool or type(value) is int:
        return
    if type(value) is float:
        if not math.isfinite(value):
            _fail("numbers must be finite")
        return
    if type(value) is str:
        _validate_text(value)
        return
    if type(value) is list:
        for item in value:
            _validate_json_value(item)
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                _fail("object keys must be strings")
            _validate_text(key)
            _validate_json_value(item)
        return
    _fail("value is outside the JSON data model")


def decode_json_bytes(raw: bytes) -> object:
    """Decode strict UTF-8 JSON while rejecting duplicate keys and noncanonical text."""

    if type(raw) is not bytes:
        _fail("input must be bytes")
    if raw.startswith(b"\xef\xbb\xbf"):
        _fail("UTF-8 BOM is forbidden")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _fail("input must be valid UTF-8")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_object,
            parse_constant=_reject_nonfinite_constant,
        )
    except CanonicalJsonError:
        raise
    except (json.JSONDecodeError, UnicodeError, ValueError, TypeError) as error:
        raise CanonicalJsonError("invalid canonical JSON: input is not valid JSON") from error
    _validate_json_value(value)
    return value


def canonical_json_bytes(value: object) -> bytes:
    """Return RFC 8785 canonical UTF-8 bytes after strict JSON-domain validation."""

    _validate_json_value(value)
    try:
        return rfc8785.dumps(cast(Any, value))
    except (TypeError, ValueError, OverflowError) as error:
        raise CanonicalJsonError("invalid canonical JSON: value cannot be represented by RFC 8785") from error


def sha256_hex(value: bytes) -> str:
    """Return a lowercase SHA-256 digest for exact bytes."""

    if type(value) is not bytes:
        _fail("SHA-256 input must be bytes")
    return hashlib.sha256(value).hexdigest()
