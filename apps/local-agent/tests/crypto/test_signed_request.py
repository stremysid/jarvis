"""The signature must agree byte-for-byte with the gateway's verifier.

A mismatch produces `signature_invalid`, which is indistinguishable from a
wrong key or a revoked device. These tests pin the exact signed string, the
canonical body encoding and the encodings of every field, because each of
those is a separate way to be silently wrong.
"""

from __future__ import annotations

import base64
import hashlib

import pytest
import rfc8785
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.crypto.signed_request import (
    SignedRequest,
    build_signed_request,
    signature_text,
)

DEVICE = "device-1"
PRINCIPAL = "principal-1"
AUDIENCE = "jarvis-local-agent"
ISSUED_AT = "2026-09-02T12:00:00.000Z"
NONCE_BYTES = bytes(range(32))


@pytest.fixture
def key() -> Ed25519PrivateKey:
    # Deterministic, so the signature is reproducible across runs.
    return Ed25519PrivateKey.from_private_bytes(bytes(range(32)))


def build(key: Ed25519PrivateKey, **overrides: object) -> SignedRequest:
    arguments = {
        "device_id": DEVICE,
        "principal_id": PRINCIPAL,
        "audience": AUDIENCE,
        "method": "POST",
        "path": "/sync/events",
        "body": {"afterSequence": 0},
        "issued_at": ISSUED_AT,
        "nonce_bytes": NONCE_BYTES,
    }
    arguments.update(overrides)
    return build_signed_request(key, **arguments)


def test_signed_string_matches_the_gateway_field_order(key: Ed25519PrivateKey) -> None:
    """Field order is the contract; a different order verifies against nothing."""
    request = build(key)
    expected = "\n".join(
        [
            "POST",
            "/sync/events",
            DEVICE,
            PRINCIPAL,
            AUDIENCE,
            ISSUED_AT,
            request.envelope["nonce"],
            request.envelope["bodyHash"],
        ]
    ).encode("utf-8")

    assert signature_text(
        method="POST",
        path="/sync/events",
        device_id=DEVICE,
        principal_id=PRINCIPAL,
        audience=AUDIENCE,
        issued_at=ISSUED_AT,
        nonce=request.envelope["nonce"],
        body_hash=request.envelope["bodyHash"],
    ) == expected


def test_signature_verifies_against_the_public_key(key: Ed25519PrivateKey) -> None:
    request = build(key)
    signed = signature_text(
        method="POST",
        path="/sync/events",
        device_id=DEVICE,
        principal_id=PRINCIPAL,
        audience=AUDIENCE,
        issued_at=ISSUED_AT,
        nonce=request.envelope["nonce"],
        body_hash=request.envelope["bodyHash"],
    )
    key.public_key().verify(base64.b64decode(request.envelope["signatureBase64"]), signed)


def test_body_hash_is_over_the_canonical_encoding(key: Ed25519PrivateKey) -> None:
    """The gateway re-canonicalizes and compares bytes, so the hash must be
    over RFC 8785 output rather than any other JSON serialization."""
    body = {"b": 2, "a": 1}
    request = build(key, body=body)
    assert request.raw_body == rfc8785.dumps(body)
    assert request.envelope["bodyHash"] == hashlib.sha256(rfc8785.dumps(body)).hexdigest()


def test_key_order_does_not_change_the_signature(key: Ed25519PrivateKey) -> None:
    """Canonicalization is what makes this true; without it the same object
    written differently would produce a different hash."""
    first = build(key, body={"a": 1, "b": 2})
    second = build(key, body={"b": 2, "a": 1})
    assert first.envelope["bodyHash"] == second.envelope["bodyHash"]
    assert first.envelope["signatureBase64"] == second.envelope["signatureBase64"]


def test_nonce_is_unpadded_base64url(key: Ed25519PrivateKey) -> None:
    # decodeCanonicalBase64Url on the gateway rejects padding and the
    # standard-alphabet characters.
    nonce = build(key).envelope["nonce"]
    assert "=" not in nonce
    assert "+" not in nonce and "/" not in nonce
    assert base64.urlsafe_b64decode(nonce + "==") == NONCE_BYTES


def test_signature_is_standard_base64_not_url(key: Ed25519PrivateKey) -> None:
    # decodeCanonicalBase64 expects the standard alphabet with padding, which
    # is deliberately different from the nonce encoding.
    signature = build(key).envelope["signatureBase64"]
    assert len(base64.b64decode(signature, validate=True)) == 64


def test_envelope_carries_exactly_the_expected_fields(key: Ed25519PrivateKey) -> None:
    assert set(build(key).envelope) == {
        "schemaVersion",
        "deviceId",
        "principalId",
        "audience",
        "issuedAt",
        "nonce",
        "bodyHash",
        "signatureBase64",
    }


def test_a_different_path_produces_a_different_signature(key: Ed25519PrivateKey) -> None:
    """So a signature captured from one endpoint cannot be replayed at another."""
    assert (
        build(key, path="/sync/events").envelope["signatureBase64"]
        != build(key, path="/sync/ack").envelope["signatureBase64"]
    )


def test_a_different_audience_produces_a_different_signature(key: Ed25519PrivateKey) -> None:
    """So a signature for one deployment cannot be used against another."""
    assert (
        build(key, audience="jarvis-local-agent").envelope["signatureBase64"]
        != build(key, audience="other-deployment").envelope["signatureBase64"]
    )


def test_a_different_method_produces_a_different_signature(key: Ed25519PrivateKey) -> None:
    assert (
        build(key, method="POST", path="/sync/events").envelope["signatureBase64"]
        != build(key, method="GET", path="/sync/events").envelope["signatureBase64"]
    )


def test_nonces_differ_between_requests(key: Ed25519PrivateKey) -> None:
    """The gateway consumes each nonce once; a repeat is rejected as a replay."""
    first = build_signed_request(
        key, device_id=DEVICE, principal_id=PRINCIPAL, audience=AUDIENCE,
        method="POST", path="/sync/events", body={},
    )
    second = build_signed_request(
        key, device_id=DEVICE, principal_id=PRINCIPAL, audience=AUDIENCE,
        method="POST", path="/sync/events", body={},
    )
    assert first.envelope["nonce"] != second.envelope["nonce"]


def test_issued_at_has_millisecond_precision(key: Ed25519PrivateKey) -> None:
    # The gateway's UTC_MILLISECONDS pattern requires exactly three fractional
    # digits and rejects anything else.
    import re

    request = build_signed_request(
        key, device_id=DEVICE, principal_id=PRINCIPAL, audience=AUDIENCE,
        method="POST", path="/sync/events", body={},
    )
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", request.envelope["issuedAt"])


@pytest.mark.parametrize("method", ["PUT", "DELETE", "post", ""])
def test_unsupported_methods_are_refused(key: Ed25519PrivateKey, method: str) -> None:
    with pytest.raises(ValueError, match="method"):
        build(key, method=method)


def test_relative_paths_are_refused(key: Ed25519PrivateKey) -> None:
    with pytest.raises(ValueError, match="absolute"):
        build(key, path="sync/events")
