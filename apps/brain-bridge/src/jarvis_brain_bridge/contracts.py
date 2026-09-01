"""Closed, immutable Python mirror of the frozen H1 token bridge contract."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import ClassVar, Final, Literal, NoReturn, TypeAlias, cast

from .canonical import canonical_json_bytes, decode_json_bytes, sha256_hex

ULID_PATTERN = re.compile(r"^[0-7][0-9a-hjkmnp-tv-z]{25}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_OUTPUT = 65_536
MAX_SSE_FRAME_BYTES = 524_288
MAX_REQUEST_CANONICAL_BYTES = 252_664
PROFILE_ID: Final[Literal["jarvis-voice-safe"]] = "jarvis-voice-safe"
RELEASE_COMMIT: Final[Literal["5fc308a70719a83cccdbba4c0e39c23f5a8239d5"]] = "5fc308a70719a83cccdbba4c0e39c23f5a8239d5"
REQUEST_KEYS = (
    "schemaVersion",
    "requestId",
    "correlationId",
    "principalId",
    "channel",
    "userText",
    "context",
    "reasoningEffort",
    "firstTokenTimeoutMs",
    "timeoutMs",
    "contextTokenBudget",
    "maxOutputCharacters",
)


class ContractError(ValueError):
    """Raised when a value violates the frozen H1 bridge contract."""


def _fail(message: str) -> NoReturn:
    raise ContractError(f"invalid H1 token bridge contract: {message}")


@dataclass(frozen=True, slots=True)
class RequestContextV1:
    """One immutable context item in an H1 request."""

    source_event_id: str
    text: str
    sensitivity: Literal["personal", "restricted"]


@dataclass(frozen=True, slots=True)
class JarvisTokenBridgeRequestV1:
    """Validated and hash-bound H1 request."""

    schema_version: Literal["1.0"]
    request_id: str
    correlation_id: str
    principal_id: str
    channel: Literal["voice"]
    user_text: str
    context: tuple[RequestContextV1, ...]
    reasoning_effort: Literal["none", "low", "high", "max"]
    first_token_timeout_ms: int
    timeout_ms: int
    context_token_budget: int
    max_output_characters: int
    request_hash: str


@dataclass(frozen=True, slots=True)
class TokenEventV1:
    """One outward token event."""

    type: ClassVar[Literal["token"]] = "token"
    schema_version: Literal["1.0"]
    request_id: str
    event_index: int
    token_index: int
    text: str


@dataclass(frozen=True, slots=True)
class CompletedEventV1:
    """One outward successful terminal event."""

    type: ClassVar[Literal["completed"]] = "completed"
    schema_version: Literal["1.0"]
    request_id: str
    event_index: int
    output_hash: str


@dataclass(frozen=True, slots=True)
class FailedEventV1:
    """One outward failed terminal event."""

    type: ClassVar[Literal["failed"]] = "failed"
    schema_version: Literal["1.0"]
    request_id: str
    event_index: int
    code: Literal["model_provider_failure", "model_protocol_invalid"]


@dataclass(frozen=True, slots=True)
class CancelledEventV1:
    """One outward cancelled terminal event."""

    type: ClassVar[Literal["cancelled"]] = "cancelled"
    schema_version: Literal["1.0"]
    request_id: str
    event_index: int


JarvisTokenBridgeEventV1: TypeAlias = TokenEventV1 | CompletedEventV1 | FailedEventV1 | CancelledEventV1


@dataclass(frozen=True, slots=True)
class EventChainV1:
    """Length-bound hash chain over exact canonical SSE frames."""

    initial_hash: str
    frame_hashes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AdmissionFailureV1:
    """Closed admission failure body."""

    schema_version: Literal["1.0"]
    request_id: str
    code: Literal[
        "not_started", "ledger_capacity_exhausted", "model_admission_unknown", "request_conflict", "request_invalid"
    ]


@dataclass(frozen=True, slots=True)
class CancelRequestV1:
    """Hash-bound cancellation request."""

    schema_version: Literal["1.0"]
    request_id: str
    request_hash: str


@dataclass(frozen=True, slots=True)
class CancelResponseV1:
    """Closed cancellation response body."""

    schema_version: Literal["1.0"]
    request_id: str
    status: Literal["cancel_requested", "stop_accepted", "cancelled", "completed", "failed", "model_cancel_unknown"]


@dataclass(frozen=True, slots=True)
class ReadinessV1:
    """Closed H1 readiness body."""

    release_commit: Literal["5fc308a70719a83cccdbba4c0e39c23f5a8239d5"]
    configuration_hash: str
    brain_schema_major: Literal[1]
    runs_event_contract_hash: str
    enabled_profile_ids: tuple[Literal["jarvis-voice-safe"], ...]
    health: Literal["ready", "not_ready"]


def _exact_record(value: object, expected_keys: Sequence[str]) -> dict[str, object]:
    if type(value) is not dict:
        _fail("must be a plain record")
    record = cast(dict[object, object], value)
    if any(type(key) is not str for key in record):
        _fail("record keys must be strings")
    actual_keys = set(cast(dict[str, object], record))
    if actual_keys != set(expected_keys) or len(record) != len(expected_keys):
        _fail("must contain exactly the required fields")
    return {key: record[key] for key in expected_keys}


def _exact_array(value: object, label: str) -> list[object]:
    if type(value) is not list:
        _fail(f"{label} must be a plain array")
    return cast(list[object], value)


def _require_nfc_text(value: object, label: str, *, non_empty: bool = False) -> str:
    if type(value) is not str:
        _fail(f"{label} must be well-formed NFC text")
    text = value
    try:
        text.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail(f"{label} must be well-formed NFC text")
    if unicodedata.normalize("NFC", text) != text:
        _fail(f"{label} must be well-formed NFC text")
    if non_empty and not text:
        _fail(f"{label} must not be empty")
    return text


def _require_bounded_text(value: object, label: str, maximum_scalars: int, maximum_utf8_bytes: int) -> tuple[str, int]:
    text = _require_nfc_text(value, label, non_empty=True)
    utf8_bytes = len(text.encode("utf-8"))
    if len(text) > maximum_scalars or utf8_bytes > maximum_utf8_bytes:
        _fail(f"{label} exceeds Unicode-scalar or UTF-8-byte bounds")
    return text, utf8_bytes


def _require_ulid(value: object, label: str) -> str:
    if type(value) is not str or ULID_PATTERN.fullmatch(value) is None:
        _fail(f"{label} must be a lowercase ULID")
    return value


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or SHA256_PATTERN.fullmatch(value) is None:
        _fail(f"{label} must be a lowercase SHA-256 hex digest")
    return value


def _require_integer(value: object, label: str, minimum: int, maximum: int = MAX_SAFE_INTEGER) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        _fail(f"{label} is out of bounds")
    return value


def _parse_context(value: object, context_token_budget: int) -> tuple[RequestContextV1, ...]:
    items = _exact_array(value, "context")
    if len(items) > 128:
        _fail("context exceeds item bound")
    cumulative_utf8_bytes = 0
    parsed: list[RequestContextV1] = []
    for item in items:
        record = _exact_record(item, ("sourceEventId", "text", "sensitivity"))
        if record["sensitivity"] not in {"personal", "restricted"}:
            _fail("context sensitivity is unsupported")
        text, utf8_bytes = _require_bounded_text(record["text"], "context text", 65_536, 65_536)
        cumulative_utf8_bytes += utf8_bytes
        if cumulative_utf8_bytes > context_token_budget:
            _fail("context exceeds contextTokenBudget")
        parsed.append(
            RequestContextV1(
                source_event_id=_require_ulid(record["sourceEventId"], "context sourceEventId"),
                text=text,
                sensitivity=record["sensitivity"],
            )
        )
    return tuple(parsed)


def _parse_request_material(value: object) -> dict[str, object]:
    record = _exact_record(value, REQUEST_KEYS)
    if record["schemaVersion"] != "1.0":
        _fail("schemaVersion is unsupported")
    if record["channel"] != "voice":
        _fail("channel must be voice")
    if record["reasoningEffort"] not in {"none", "low", "high", "max"}:
        _fail("reasoningEffort is unsupported")
    request_id = _require_ulid(record["requestId"], "requestId")
    correlation_id = _require_ulid(record["correlationId"], "correlationId")
    if request_id != correlation_id:
        _fail("requestId and correlationId must be identical")
    principal_id, _ = _require_bounded_text(record["principalId"], "principalId", 256, 1_024)
    if "\r" in principal_id or "\n" in principal_id:
        _fail("principalId must not contain CR or LF")
    user_text, _ = _require_bounded_text(record["userText"], "userText", 8_000, 65_536)
    first_token_timeout_ms = _require_integer(record["firstTokenTimeoutMs"], "firstTokenTimeoutMs", 1, 8_000)
    timeout_ms = _require_integer(record["timeoutMs"], "timeoutMs", first_token_timeout_ms, 30_000)
    context_token_budget = _require_integer(record["contextTokenBudget"], "contextTokenBudget", 1, 32_000)
    return {
        "schemaVersion": "1.0",
        "requestId": request_id,
        "correlationId": correlation_id,
        "principalId": principal_id,
        "channel": "voice",
        "userText": user_text,
        "context": _parse_context(record["context"], context_token_budget),
        "reasoningEffort": record["reasoningEffort"],
        "firstTokenTimeoutMs": first_token_timeout_ms,
        "timeoutMs": timeout_ms,
        "contextTokenBudget": context_token_budget,
        "maxOutputCharacters": _require_integer(record["maxOutputCharacters"], "maxOutputCharacters", 1, 65_536),
    }


def _request_from_material(material: Mapping[str, object], request_hash: str) -> JarvisTokenBridgeRequestV1:
    contexts = cast(tuple[RequestContextV1, ...], material["context"])
    request = JarvisTokenBridgeRequestV1(
        schema_version="1.0",
        request_id=cast(str, material["requestId"]),
        correlation_id=cast(str, material["correlationId"]),
        principal_id=cast(str, material["principalId"]),
        channel="voice",
        user_text=cast(str, material["userText"]),
        context=contexts,
        reasoning_effort=cast(Literal["none", "low", "high", "max"], material["reasoningEffort"]),
        first_token_timeout_ms=cast(int, material["firstTokenTimeoutMs"]),
        timeout_ms=cast(int, material["timeoutMs"]),
        context_token_budget=cast(int, material["contextTokenBudget"]),
        max_output_characters=cast(int, material["maxOutputCharacters"]),
        request_hash=request_hash,
    )
    if len(canonical_json_bytes(request_to_dict(request))) > MAX_REQUEST_CANONICAL_BYTES:
        _fail("request exceeds canonical byte bound")
    return request


def request_hash_material_to_dict(request: JarvisTokenBridgeRequestV1) -> dict[str, object]:
    """Convert a validated request to its exact hash material."""

    return {
        "schemaVersion": request.schema_version,
        "requestId": request.request_id,
        "correlationId": request.correlation_id,
        "principalId": request.principal_id,
        "channel": request.channel,
        "userText": request.user_text,
        "context": [
            {"sourceEventId": item.source_event_id, "text": item.text, "sensitivity": item.sensitivity}
            for item in request.context
        ],
        "reasoningEffort": request.reasoning_effort,
        "firstTokenTimeoutMs": request.first_token_timeout_ms,
        "timeoutMs": request.timeout_ms,
        "contextTokenBudget": request.context_token_budget,
        "maxOutputCharacters": request.max_output_characters,
    }


def request_to_dict(request: JarvisTokenBridgeRequestV1) -> dict[str, object]:
    """Convert a validated request to its exact wire body."""

    return {**request_hash_material_to_dict(request), "requestHash": request.request_hash}


def create_request_v1(value: object) -> JarvisTokenBridgeRequestV1:
    """Validate request hash material and construct its hash-bound wire value."""

    material = _parse_request_material(value)
    hash_material = _request_from_material(material, "0" * 64)
    request_hash = sha256_hex(canonical_json_bytes(request_hash_material_to_dict(hash_material)))
    return _request_from_material(material, request_hash)


def parse_request_v1(value: object) -> JarvisTokenBridgeRequestV1:
    """Validate an exact hash-bound request body."""

    record = _exact_record(value, (*REQUEST_KEYS, "requestHash"))
    material = _parse_request_material({key: record[key] for key in REQUEST_KEYS})
    request_hash = _require_sha256(record["requestHash"], "requestHash")
    candidate = _request_from_material(material, request_hash)
    computed_hash = sha256_hex(canonical_json_bytes(request_hash_material_to_dict(candidate)))
    if not hmac.compare_digest(request_hash, computed_hash):
        _fail("requestHash does not match request material")
    return candidate


def parse_request_json_bytes_v1(raw: bytes) -> JarvisTokenBridgeRequestV1:
    """Decode and validate an exact request from strict JSON bytes."""

    return parse_request_v1(decode_json_bytes(raw))


def _require_output_text(value: object) -> str:
    text = _require_nfc_text(value, "token text")
    if len(text) > MAX_OUTPUT or len(text.encode("utf-8")) > MAX_OUTPUT:
        _fail("output exceeds Unicode-scalar or UTF-8-byte bounds")
    return text


def parse_event_v1(value: object) -> JarvisTokenBridgeEventV1:
    """Validate one exact outward H1 event."""

    if isinstance(value, (TokenEventV1, CompletedEventV1, FailedEventV1, CancelledEventV1)):
        value = event_to_dict(value)
    if type(value) is not dict or "type" not in cast(dict[object, object], value):
        _fail("event type is unsupported")
    event_type = cast(dict[str, object], value)["type"]
    if event_type == "token":
        record = _exact_record(value, ("schemaVersion", "requestId", "eventIndex", "type", "tokenIndex", "text"))
        _require_schema(record)
        return TokenEventV1(
            "1.0",
            _require_ulid(record["requestId"], "requestId"),
            _require_integer(record["eventIndex"], "eventIndex", 0),
            _require_integer(record["tokenIndex"], "tokenIndex", 0),
            _require_output_text(record["text"]),
        )
    if event_type == "completed":
        record = _exact_record(value, ("schemaVersion", "requestId", "eventIndex", "type", "outputHash"))
        _require_schema(record)
        return CompletedEventV1(
            "1.0",
            _require_ulid(record["requestId"], "requestId"),
            _require_integer(record["eventIndex"], "eventIndex", 0),
            _require_sha256(record["outputHash"], "outputHash"),
        )
    if event_type == "failed":
        record = _exact_record(value, ("schemaVersion", "requestId", "eventIndex", "type", "code"))
        _require_schema(record)
        if record["code"] not in {"model_provider_failure", "model_protocol_invalid"}:
            _fail("failure code is unsupported")
        return FailedEventV1(
            "1.0",
            _require_ulid(record["requestId"], "requestId"),
            _require_integer(record["eventIndex"], "eventIndex", 0),
            record["code"],
        )
    if event_type == "cancelled":
        record = _exact_record(value, ("schemaVersion", "requestId", "eventIndex", "type"))
        _require_schema(record)
        return CancelledEventV1(
            "1.0",
            _require_ulid(record["requestId"], "requestId"),
            _require_integer(record["eventIndex"], "eventIndex", 0),
        )
    _fail("event type is unsupported")


def _require_schema(record: Mapping[str, object]) -> None:
    if record["schemaVersion"] != "1.0":
        _fail("schemaVersion is unsupported")


def event_to_dict(event: JarvisTokenBridgeEventV1) -> dict[str, object]:
    """Convert a validated event to its exact wire body."""

    common: dict[str, object] = {
        "schemaVersion": event.schema_version,
        "requestId": event.request_id,
        "eventIndex": event.event_index,
        "type": event.type,
    }
    if isinstance(event, TokenEventV1):
        return {**common, "tokenIndex": event.token_index, "text": event.text}
    if isinstance(event, CompletedEventV1):
        return {**common, "outputHash": event.output_hash}
    if isinstance(event, FailedEventV1):
        return {**common, "code": event.code}
    return common


def encode_event_sse_frame_v1(value: object) -> bytes:
    """Encode one validated event as an exact canonical H1 SSE frame."""

    event = parse_event_v1(value)
    frame = b"data: " + canonical_json_bytes(event_to_dict(event)) + b"\n\n"
    if len(frame) > MAX_SSE_FRAME_BYTES:
        _fail("SSE frame is too large")
    return frame


def parse_event_sse_frame_v1(value: object) -> JarvisTokenBridgeEventV1:
    """Parse and byte-compare one exact canonical H1 SSE frame."""

    if type(value) is not bytes or len(value) > MAX_SSE_FRAME_BYTES:
        _fail("SSE frame must be bounded bytes")
    frame = value
    if not frame.startswith(b"data: ") or not frame.endswith(b"\n\n") or b"\r" in frame or b"\n" in frame[6:-2]:
        _fail("SSE frame must be one LF-delimited data line")
    try:
        event = parse_event_v1(decode_json_bytes(frame[6:-2]))
    except ValueError as error:
        raise ContractError("invalid H1 token bridge contract: SSE data is invalid") from error
    if not hmac.compare_digest(encode_event_sse_frame_v1(event), frame):
        _fail("SSE frame is not canonical")
    return event


def create_event_chain_v1(request_hash: object, frames: Sequence[bytes]) -> EventChainV1:
    """Create the frozen length-prefixed SHA-256 chain for canonical SSE frames."""

    validated_hash = _require_sha256(request_hash, "requestHash")
    previous = hashlib.sha256(b"JARVIS-H1-EVENT-CHAIN-V1\0" + bytes.fromhex(validated_hash)).digest()
    initial_hash = previous.hex()
    frame_hashes: list[str] = []
    for frame in frames:
        parse_event_sse_frame_v1(frame)
        previous = hashlib.sha256(previous + len(frame).to_bytes(8, "big") + frame).digest()
        frame_hashes.append(previous.hex())
    return EventChainV1(initial_hash, tuple(frame_hashes))


def parse_admission_failure_v1(value: object) -> AdmissionFailureV1:
    """Validate one exact admission failure body."""

    record = _exact_record(value, ("schemaVersion", "requestId", "code"))
    _require_schema(record)
    allowed = {
        "not_started",
        "ledger_capacity_exhausted",
        "model_admission_unknown",
        "request_conflict",
        "request_invalid",
    }
    if record["code"] not in allowed:
        _fail("admission failure code is unsupported")
    return AdmissionFailureV1(
        "1.0",
        _require_ulid(record["requestId"], "requestId"),
        cast(
            Literal[
                "not_started",
                "ledger_capacity_exhausted",
                "model_admission_unknown",
                "request_conflict",
                "request_invalid",
            ],
            record["code"],
        ),
    )


def parse_cancel_request_v1(value: object) -> CancelRequestV1:
    """Validate one exact cancellation request body."""

    record = _exact_record(value, ("schemaVersion", "requestId", "requestHash"))
    _require_schema(record)
    return CancelRequestV1(
        "1.0",
        _require_ulid(record["requestId"], "requestId"),
        _require_sha256(record["requestHash"], "requestHash"),
    )


def parse_cancel_response_v1(value: object) -> CancelResponseV1:
    """Validate one exact cancellation response body."""

    record = _exact_record(value, ("schemaVersion", "requestId", "status"))
    _require_schema(record)
    allowed = {"cancel_requested", "stop_accepted", "cancelled", "completed", "failed", "model_cancel_unknown"}
    if record["status"] not in allowed:
        _fail("cancellation status is unsupported")
    return CancelResponseV1(
        "1.0",
        _require_ulid(record["requestId"], "requestId"),
        cast(
            Literal["cancel_requested", "stop_accepted", "cancelled", "completed", "failed", "model_cancel_unknown"],
            record["status"],
        ),
    )


def parse_readiness_v1(value: object) -> ReadinessV1:
    """Validate one exact readiness body."""

    record = _exact_record(
        value,
        (
            "releaseCommit",
            "configurationHash",
            "brainSchemaMajor",
            "runsEventContractHash",
            "enabledProfileIds",
            "health",
        ),
    )
    if (
        record["releaseCommit"] != RELEASE_COMMIT
        or type(record["brainSchemaMajor"]) is not int
        or record["brainSchemaMajor"] != 1
    ):
        _fail("readiness version is unsupported")
    profiles = _exact_array(record["enabledProfileIds"], "enabledProfileIds")
    if profiles != [PROFILE_ID]:
        _fail("enabledProfileIds is unsupported")
    if record["health"] not in {"ready", "not_ready"}:
        _fail("health is unsupported")
    return ReadinessV1(
        RELEASE_COMMIT,
        _require_sha256(record["configurationHash"], "configurationHash"),
        1,
        _require_sha256(record["runsEventContractHash"], "runsEventContractHash"),
        (PROFILE_ID,),
        record["health"],
    )


def readiness_to_dict(value: ReadinessV1) -> dict[str, object]:
    """Convert validated readiness to its exact wire body."""

    return {
        "releaseCommit": value.release_commit,
        "configurationHash": value.configuration_hash,
        "brainSchemaMajor": value.brain_schema_major,
        "runsEventContractHash": value.runs_event_contract_hash,
        "enabledProfileIds": list(value.enabled_profile_ids),
        "health": value.health,
    }


def build_native_input_v1(request: JarvisTokenBridgeRequestV1) -> bytes:
    """Build the exact identifier-free native model input grammar."""

    request = parse_request_v1(request_to_dict(request))

    def text_bytes(text: str) -> bytes:
        encoded = text.encode("utf-8")
        return str(len(encoded)).encode("ascii") + b"\n" + encoded + b"\n"

    chunks = [b"JARVIS-H1-INPUT-V1\n", text_bytes(request.user_text), str(len(request.context)).encode("ascii") + b"\n"]
    for item in request.context:
        chunks.extend((item.sensitivity.encode("ascii") + b"\n", text_bytes(item.text)))
    return b"".join(chunks)


def session_hmac_message_v1(profile_id: object, request_id: object) -> bytes:
    """Build the exact public session-HMAC message bytes."""

    if profile_id != PROFILE_ID:
        _fail("profileId is unsupported")
    validated_request_id = _require_ulid(request_id, "requestId")
    profile_bytes = PROFILE_ID.encode("ascii")
    request_bytes = validated_request_id.encode("ascii")
    return (
        b"JARVIS-H1-SESSION-V1\0"
        + len(profile_bytes).to_bytes(4, "big")
        + profile_bytes
        + len(request_bytes).to_bytes(4, "big")
        + request_bytes
    )


def derive_session_id_v1(profile_key: object, profile_id: object, request_id: object) -> str:
    """Derive the opaque H1 session identifier from a 32-byte profile key."""

    if type(profile_key) is not bytes or len(profile_key) != 32:
        _fail("profileKey must be exactly 32 bytes")
    digest = hmac.digest(profile_key, session_hmac_message_v1(profile_id, request_id), "sha256")
    return "jv1_" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
