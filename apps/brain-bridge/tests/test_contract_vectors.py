from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from typing import Any

import pytest

from jarvis_brain_bridge.canonical import CanonicalJsonError, canonical_json_bytes, decode_json_bytes, sha256_hex
from jarvis_brain_bridge.contracts import (
    ContractError,
    TokenEventV1,
    build_native_input_v1,
    create_event_chain_v1,
    create_request_v1,
    derive_session_id_v1,
    encode_event_sse_frame_v1,
    encode_readiness_v1,
    event_to_dict,
    parse_admission_failure_v1,
    parse_cancel_request_v1,
    parse_cancel_response_v1,
    parse_event_sse_frame_v1,
    parse_event_v1,
    parse_readiness_v1,
    parse_request_json_bytes_v1,
    parse_request_v1,
    readiness_to_dict,
    request_hash_material_to_dict,
    request_to_dict,
    session_hmac_message_v1,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = REPOSITORY_ROOT / "tests" / "fixtures" / "hermes-h1"
REQUEST_ID = "01k3s6k8000000000000000003"


def load_fixture_bytes(name: str) -> bytes:
    return (FIXTURE_ROOT / name).read_bytes()


def load_fixture(name: str) -> Any:
    return json.loads(load_fixture_bytes(name).decode("utf-8"))


def request_fixture() -> dict[str, Any]:
    value = load_fixture("token-request-golden-v1.json")
    assert isinstance(value, dict)
    return value


def valid_material() -> dict[str, Any]:
    fixture = request_fixture()
    value = decode_json_bytes(fixture["canonicalRequestBody"].encode("utf-8"))
    assert isinstance(value, dict)
    return value


def test_golden_request_matches_canonical_bytes_hash_native_input_and_session() -> None:
    fixture = request_fixture()
    material_bytes = fixture["canonicalRequestBody"].encode("utf-8")
    material = decode_json_bytes(material_bytes)

    request = create_request_v1(material)

    assert canonical_json_bytes(request_hash_material_to_dict(request)) == material_bytes
    assert request.request_hash == fixture["requestHash"]
    assert sha256_hex(material_bytes) == fixture["requestHash"]
    assert parse_request_v1(request_to_dict(request)) == request
    assert parse_request_json_bytes_v1(canonical_json_bytes(request_to_dict(request))) == request

    native_input = build_native_input_v1(request)
    assert native_input.hex() == fixture["nativeInputUtf8Hex"]
    assert sha256_hex(native_input) == fixture["nativeInputSha256"]

    public_key = bytes.fromhex(fixture["publicProfileKeyHex"])
    message = session_hmac_message_v1(fixture["profileId"], request.request_id)
    digest = hmac.digest(public_key, message, "sha256")
    expected_session = "jv1_" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    assert message.hex() == fixture["sessionHmacMessageHex"]
    assert digest.hex() == fixture["sessionHmacSha256"]
    assert (
        derive_session_id_v1(public_key, fixture["profileId"], request.request_id)
        == expected_session
        == fixture["sessionId"]
    )


def test_request_types_are_deeply_immutable() -> None:
    request = create_request_v1(valid_material())

    with pytest.raises(FrozenInstanceError):
        request.user_text = "changed"  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        request.context[0].text = "changed"  # type: ignore[misc]
    assert isinstance(request.context, tuple)


@pytest.mark.parametrize(
    "raw",
    [
        b'{"value":1,"value":2}',
        b'{"value":NaN}',
        b'{"value":Infinity}',
        b'{"value":-Infinity}',
        b'\xef\xbb\xbf{"value":1}',
        b'{"value":"\xff"}',
        '{"value":"e\u0301"}'.encode(),
    ],
)
def test_json_byte_boundary_rejects_duplicates_nonfinite_invalid_utf8_bom_and_non_nfc(raw: bytes) -> None:
    with pytest.raises(CanonicalJsonError):
        decode_json_bytes(raw)


def test_canonical_json_matches_rfc8785_number_and_key_ordering() -> None:
    assert canonical_json_bytes({"z": -0.0, "é": "é", "a": [1, True, None]}) == (
        '{"a":[1,true,null],"z":0,"é":"é"}'.encode()
    )
    with pytest.raises(CanonicalJsonError):
        canonical_json_bytes({"value": float("nan")})


@pytest.mark.parametrize(
    ("mutation", "match"),
    [
        (lambda value: value.update(extra=True), "exactly"),
        (lambda value: value.pop("userText"), "exactly"),
        (lambda value: value.update(requestId="invalid"), "requestId"),
        (lambda value: value.update(correlationId=value["context"][0]["sourceEventId"]), "identical"),
        (lambda value: value.update(channel="chat"), "voice"),
        (lambda value: value.update(userText="e\u0301"), "NFC"),
        (lambda value: value.update(principalId="principal\nsid"), "CR or LF"),
        (lambda value: value.update(firstTokenTimeoutMs=True), "firstTokenTimeoutMs"),
        (lambda value: value.update(firstTokenTimeoutMs=0), "firstTokenTimeoutMs"),
        (lambda value: value.update(timeoutMs=7_999), "timeoutMs"),
        (
            lambda value: value.update(contextTokenBudget=3, context=[{**value["context"][0], "text": "éé"}]),
            "contextTokenBudget",
        ),
        (lambda value: value.update(context=[{**value["context"][0], "extra": True}]), "exactly"),
        (lambda value: value.update(context=[{**value["context"][0], "text": ""}]), "empty"),
        (lambda value: value.update(reasoningEffort="medium"), "reasoningEffort"),
        (lambda value: value.update(maxOutputCharacters=65_537), "maxOutputCharacters"),
    ],
)
def test_request_constructor_rejects_contract_drift(mutation: Any, match: str) -> None:
    material = valid_material()
    mutation(material)

    with pytest.raises(ContractError, match=match):
        create_request_v1(material)


def test_request_parser_rejects_changed_hash_material_under_same_identity() -> None:
    request = request_to_dict(create_request_v1(valid_material()))
    request["userText"] = "changed"

    with pytest.raises(ContractError, match="requestHash"):
        parse_request_v1(request)

    changed = create_request_v1({**valid_material(), "userText": "changed"})
    assert changed.request_id == REQUEST_ID
    assert changed.request_hash != request_fixture()["requestHash"]


def test_json_integral_float_spellings_match_typescript_safe_integer_semantics() -> None:
    expected_request = create_request_v1(valid_material())
    request_json = json.dumps(request_to_dict(expected_request), ensure_ascii=False, separators=(",", ":"))
    request_json = request_json.replace('"firstTokenTimeoutMs":8000', '"firstTokenTimeoutMs":8e3')
    request_json = request_json.replace('"timeoutMs":30000', '"timeoutMs":30000.0')

    assert parse_request_json_bytes_v1(request_json.encode()) == expected_request

    readiness = load_fixture_bytes("readiness-golden-v1.json").replace(
        b'"brainSchemaMajor": 1', b'"brainSchemaMajor": 1.0'
    )
    assert parse_readiness_v1(decode_json_bytes(readiness)).brain_schema_major == 1


def test_committed_ndjson_and_sse_vectors_have_identical_canonical_frames_and_chain() -> None:
    ndjson = load_fixture_bytes("token-events-golden-v1.ndjson")
    sse = load_fixture_bytes("token-events-golden-v1.sse")
    ndjson_lines = ndjson.rstrip(b"\n").split(b"\n")
    events = [parse_event_v1(decode_json_bytes(line)) for line in ndjson_lines]
    frames = [encode_event_sse_frame_v1(event) for event in events]

    assert [canonical_json_bytes(event_to_dict(event)) for event in events] == ndjson_lines
    assert b"".join(frames) == sse
    assert sse.endswith(b"\n\n")
    assert b"\r" not in sse
    assert not sse.startswith(b"\xef\xbb\xbf")
    assert [parse_event_sse_frame_v1(frame) for frame in frames] == events
    assert [event.event_index for event in events] == [0, 1, 2]
    assert sum(event.type != "token" for event in events) == 1

    chain = create_event_chain_v1(request_fixture()["requestHash"], frames)
    assert chain.initial_hash == request_fixture()["eventChain"]["initialHash"]
    assert list(chain.frame_hashes) == request_fixture()["eventChain"]["frameHashes"]


@pytest.mark.parametrize(
    "value",
    [
        {
            "schemaVersion": "1.0",
            "requestId": REQUEST_ID,
            "eventIndex": 0,
            "type": "token",
            "tokenIndex": 0,
            "text": "",
            "extra": True,
        },
        {"schemaVersion": "1.0", "requestId": REQUEST_ID, "eventIndex": -1, "type": "cancelled"},
        {"schemaVersion": "1.0", "requestId": REQUEST_ID, "eventIndex": 0, "type": "failed", "code": "secret_detail"},
        {"schemaVersion": "1.0", "requestId": REQUEST_ID, "eventIndex": 0, "type": "completed", "outputHash": "A" * 64},
        {"schemaVersion": "1.0", "requestId": REQUEST_ID, "eventIndex": 0, "type": "tool"},
    ],
)
def test_event_parser_rejects_unknown_fields_indices_hashes_and_types(value: dict[str, Any]) -> None:
    with pytest.raises(ContractError):
        parse_event_v1(value)


@pytest.mark.parametrize("shape", [[], {}])
@pytest.mark.parametrize(
    "site",
    ["reasoning", "sensitivity", "failure", "admission", "cancellation", "health"],
)
def test_malformed_enum_container_shapes_always_raise_contract_error(site: str, shape: object) -> None:
    def parse_case() -> object:
        if site == "reasoning":
            return create_request_v1({**valid_material(), "reasoningEffort": shape})
        if site == "sensitivity":
            material = valid_material()
            return create_request_v1({**material, "context": [{**material["context"][0], "sensitivity": shape}]})
        if site == "failure":
            return parse_event_v1(
                {
                    "schemaVersion": "1.0",
                    "requestId": REQUEST_ID,
                    "eventIndex": 0,
                    "type": "failed",
                    "code": shape,
                }
            )
        if site == "admission":
            return parse_admission_failure_v1({"schemaVersion": "1.0", "requestId": REQUEST_ID, "code": shape})
        if site == "cancellation":
            return parse_cancel_response_v1({"schemaVersion": "1.0", "requestId": REQUEST_ID, "status": shape})
        readiness = load_fixture("readiness-golden-v1.json")
        assert isinstance(readiness, dict)
        return parse_readiness_v1({**readiness, "health": shape})

    with pytest.raises(ContractError):
        parse_case()


def test_boundary_fixture_enforces_scalar_utf8_and_escaped_frame_limits() -> None:
    boundary = load_fixture("token-events-boundary-v1.json")
    control_text = boundary["control"] * boundary["scalarNearLimit"]
    emoji_text = "😀" * boundary["utf8NearLimit"]

    control_frame = encode_event_sse_frame_v1(
        {
            "schemaVersion": "1.0",
            "requestId": REQUEST_ID,
            "eventIndex": 0,
            "type": "token",
            "tokenIndex": 0,
            "text": control_text,
        }
    )
    assert len(control_frame) == boundary["escapedNearLimitFrameBytes"]
    parsed_control = parse_event_sse_frame_v1(control_frame)
    assert isinstance(parsed_control, TokenEventV1)
    assert parsed_control.text == control_text
    assert (
        len(
            encode_event_sse_frame_v1(
                {
                    "schemaVersion": "1.0",
                    "requestId": REQUEST_ID,
                    "eventIndex": 0,
                    "type": "token",
                    "tokenIndex": 0,
                    "text": emoji_text,
                }
            )
        )
        > 0
    )

    with pytest.raises(ContractError, match="output"):
        encode_event_sse_frame_v1(
            {
                "schemaVersion": "1.0",
                "requestId": REQUEST_ID,
                "eventIndex": 0,
                "type": "token",
                "tokenIndex": 0,
                "text": boundary["control"] * boundary["scalarOverLimit"],
            }
        )
    with pytest.raises(ContractError, match="output"):
        encode_event_sse_frame_v1(
            {
                "schemaVersion": "1.0",
                "requestId": REQUEST_ID,
                "eventIndex": 0,
                "type": "token",
                "tokenIndex": 0,
                "text": "😀" * boundary["utf8OverLimit"],
            }
        )


@pytest.mark.parametrize(
    "frame",
    [
        b'data: {"eventIndex":0}\r\n\r\n',
        b": keepalive\n\n",
        b'data: {"eventIndex":0}\ncontinued\n\n',
        b'data: {"type":"cancelled","schemaVersion":"1.0","requestId":"01k3s6k8000000000000000003","eventIndex":0}\n\n',
        (
            b'data: {"eventIndex":0,"requestId":"01k3s6k8000000000000000003",'
            b'"schemaVersion":"1.0","type":"cancelled"}\n\ntrailing'
        ),
        b"data: \xff\n\n",
    ],
)
def test_sse_parser_rejects_noncanonical_or_invalid_frames(frame: bytes) -> None:
    with pytest.raises(ContractError):
        parse_event_sse_frame_v1(frame)


def test_readiness_fixture_and_closed_control_bodies_are_exact_and_immutable() -> None:
    readiness_raw = load_fixture_bytes("readiness-golden-v1.json")
    readiness_value = decode_json_bytes(readiness_raw)
    readiness = parse_readiness_v1(readiness_value)

    assert readiness_to_dict(readiness) == readiness_value
    with pytest.raises(FrozenInstanceError):
        readiness.health = "not_ready"  # type: ignore[misc]
    with pytest.raises(ContractError):
        parse_readiness_v1({**readiness_value, "extra": True})
    with pytest.raises(ContractError, match="version"):
        parse_readiness_v1({**readiness_value, "brainSchemaMajor": True})

    admission = parse_admission_failure_v1(
        {"schemaVersion": "1.0", "requestId": REQUEST_ID, "code": "ledger_capacity_exhausted"}
    )
    assert admission.code == "ledger_capacity_exhausted"
    cancel_request = parse_cancel_request_v1({"schemaVersion": "1.0", "requestId": REQUEST_ID, "requestHash": "0" * 64})
    assert cancel_request.request_hash == "0" * 64
    cancel_response = parse_cancel_response_v1(
        {"schemaVersion": "1.0", "requestId": REQUEST_ID, "status": "model_cancel_unknown"}
    )
    assert cancel_response.status == "model_cancel_unknown"

    with pytest.raises(ContractError):
        parse_admission_failure_v1(
            {"schemaVersion": "1.0", "requestId": REQUEST_ID, "code": "not_started", "detail": "x"}
        )
    with pytest.raises(ContractError):
        parse_cancel_response_v1({"schemaVersion": "1.0", "requestId": REQUEST_ID, "status": "unknown"})


def test_readiness_encoder_revalidates_directly_constructed_values() -> None:
    readiness_value = load_fixture("readiness-golden-v1.json")
    readiness = parse_readiness_v1(readiness_value)

    assert encode_readiness_v1(readiness) == canonical_json_bytes(readiness_value)

    invalid_values = (
        replace(readiness, configuration_hash="invalid"),
        replace(readiness, runs_event_contract_hash="invalid"),
        replace(readiness, enabled_profile_ids=()),
    )
    for invalid in invalid_values:
        with pytest.raises(ContractError):
            readiness_to_dict(invalid)
        with pytest.raises(ContractError):
            encode_readiness_v1(invalid)


def test_session_contract_rejects_wrong_key_length_and_noncanonical_identifiers() -> None:
    with pytest.raises(ContractError, match="32 bytes"):
        derive_session_id_v1(b"short", "jarvis-voice-safe", REQUEST_ID)
    with pytest.raises(ContractError, match="profileId"):
        derive_session_id_v1(bytes(32), "other-profile", REQUEST_ID)
    with pytest.raises(ContractError, match="requestId"):
        derive_session_id_v1(bytes(32), "jarvis-voice-safe", "INVALID")


def test_event_chain_validates_every_frame_instead_of_hashing_opaque_bytes() -> None:
    with pytest.raises(ContractError):
        create_event_chain_v1("0" * 64, [b"opaque"])

    valid = encode_event_sse_frame_v1(
        {"schemaVersion": "1.0", "requestId": REQUEST_ID, "eventIndex": 0, "type": "cancelled"}
    )
    chain = create_event_chain_v1("0" * 64, [valid])
    expected_initial = hashlib.sha256(b"JARVIS-H1-EVENT-CHAIN-V1\0" + bytes(32)).hexdigest()
    assert chain.initial_hash == expected_initial


def test_event_encoder_revalidates_directly_constructed_immutable_values() -> None:
    invalid = TokenEventV1("1.0", REQUEST_ID, -1, 0, "text")

    with pytest.raises(ContractError, match="eventIndex"):
        encode_event_sse_frame_v1(invalid)


def test_native_input_builder_revalidates_directly_constructed_request_values() -> None:
    valid = create_request_v1(valid_material())
    forged = replace(valid, user_text="forged")

    with pytest.raises(ContractError, match="requestHash"):
        build_native_input_v1(forged)
