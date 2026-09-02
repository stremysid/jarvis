"""Device-signed requests to the cloud gateway.

Every request the agent makes is signed with the device key, and the cloud
verifies the signature, the body hash, the freshness window and a single-use
nonce before doing anything. Possession of a valid signature is possession of
the device's authority, so the signed material has to cover everything that
could otherwise be swapped.

The signed string is exactly:

    method \\n path \\n deviceId \\n principalId \\n audience \\n issuedAt \\n nonce \\n bodyHash

Method and path are in there so a signature captured from one endpoint cannot
be replayed against another. The audience is in there so a signature for one
deployment cannot be used against another. The body hash is in there rather
than the body itself, so the signature stays a fixed size regardless of
payload.

This must agree byte-for-byte with `signatureText` in the gateway's
signed-request.ts. A mismatch produces `signature_invalid`, which looks
identical to a wrong key.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from typing import Any

import rfc8785
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.clock import utc_now_iso

SCHEMA_VERSION = "1.0"
NONCE_BYTES = 32


@dataclass(frozen=True, slots=True)
class SignedRequest:
    """The envelope plus the exact bytes it commits to.

    `raw_body` is carried alongside because the gateway compares the body it
    receives against the canonical encoding byte-for-byte. Re-serialising the
    parsed body on the way out could produce different bytes and fail that
    check for no visible reason.
    """

    envelope: dict[str, Any]
    raw_body: bytes


def _base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _base64url(data: bytes) -> str:
    """Unpadded base64url, matching decodeCanonicalBase64Url on the gateway."""
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def signature_text(
    *,
    method: str,
    path: str,
    device_id: str,
    principal_id: str,
    audience: str,
    issued_at: str,
    nonce: str,
    body_hash: str,
) -> bytes:
    """The exact bytes the gateway verifies. Field order is part of the contract."""
    return "\n".join(
        [method, path, device_id, principal_id, audience, issued_at, nonce, body_hash]
    ).encode("utf-8")


def build_signed_request(
    key: Ed25519PrivateKey,
    *,
    device_id: str,
    principal_id: str,
    audience: str,
    method: str,
    path: str,
    # JSON-serialisable request body. Deliberately Any: the gateway accepts a
    # different shape per endpoint, and rfc8785 rejects anything unencodable.
    body: Any,  # noqa: ANN401
    issued_at: str | None = None,
    nonce_bytes: bytes | None = None,
) -> SignedRequest:
    """Canonicalize, hash, and sign one request.

    `nonce_bytes` and `issued_at` are injectable for tests only. In use both
    are generated here: a caller-supplied nonce that repeated would be rejected
    by the gateway as a replay, which is the point of it.
    """
    if method not in ("GET", "POST"):
        raise ValueError(f"unsupported method: {method}")
    if not path.startswith("/"):
        raise ValueError(f"path must be absolute: {path}")

    # RFC 8785 canonical JSON. The gateway re-canonicalizes what it receives
    # and compares bytes, so any other encoding fails even when the JSON is
    # semantically identical.
    raw_body = rfc8785.dumps(body)
    body_hash = hashlib.sha256(raw_body).hexdigest()

    nonce = _base64url(nonce_bytes if nonce_bytes is not None else secrets.token_bytes(NONCE_BYTES))
    stamp = issued_at or utc_now_iso()

    signed = signature_text(
        method=method,
        path=path,
        device_id=device_id,
        principal_id=principal_id,
        audience=audience,
        issued_at=stamp,
        nonce=nonce,
        body_hash=body_hash,
    )

    return SignedRequest(
        envelope={
            "schemaVersion": SCHEMA_VERSION,
            "deviceId": device_id,
            "principalId": principal_id,
            "audience": audience,
            "issuedAt": stamp,
            "nonce": nonce,
            "bodyHash": body_hash,
            "signatureBase64": _base64(key.sign(signed)),
        },
        raw_body=raw_body,
    )
