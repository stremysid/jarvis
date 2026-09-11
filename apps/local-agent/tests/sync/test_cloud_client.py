"""The client must not let a stale view advance the cursor past unstored events.

Every test here is about that: the snapshot pairing, the expectedCurrent
value, and refusing to acknowledge a page that was never pulled. A cursor that
moves past events the archive does not hold loses them permanently and
silently, because the cursor is the only record of what has been seen.
"""

from __future__ import annotations

import io
import json
import urllib.error
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.sync.cloud_client import (
    CloudAuthError,
    CloudSyncError,
    HttpCloudClient,
)

BASE = "https://gateway.example"
DEVICE = "device-1"
PRINCIPAL = "principal-1"
AUDIENCE = "jarvis-local-agent"


def envelope(sequence: int, text: str = "hello") -> dict[str, Any]:
    return {
        "eventSequence": sequence,
        "envelope": {
            "eventId": f"event_{sequence:026d}",
            "eventType": "conversation.user_committed",
            "subjectId": PRINCIPAL,
            "correlationId": "session-1",
            "occurredAt": "2026-09-02T12:00:00.000Z",
            "producerVersion": "conversation-v1",
            "payload": {"text": text},
        },
    }


class FakeOpener:
    """Captures requests and returns queued JSON responses."""

    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, dict[str, Any], dict[str, str]]] = []

    def __call__(self, request: Any, timeout: float | None = None) -> Any:
        body = json.loads(request.data.decode("utf-8"))
        headers = {key.lower(): value for key, value in request.headers.items()}
        self.requests.append((request.full_url, body, headers))
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        payload = json.dumps(nxt).encode("utf-8")
        stream = io.BytesIO(payload)
        stream.__enter__ = lambda: stream  # type: ignore[method-assign]
        stream.__exit__ = lambda *_: None  # type: ignore[method-assign]
        return stream

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [body for _, body, _ in self.requests]


def page(
    from_sequence: int,
    to_sequence: int,
    *,
    snapshot: str = "snap-1",
    has_more: bool = False,
) -> dict[str, Any]:
    return {
        "snapshotId": snapshot,
        "snapshotToken": f"token-{snapshot}",
        "fromSequence": from_sequence,
        "toSequence": to_sequence,
        "events": [envelope(n) for n in range(from_sequence, to_sequence + 1)],
        "hasMore": has_more,
    }


@pytest.fixture
def key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes(range(32)))


def client(key: Ed25519PrivateKey, opener: FakeOpener) -> HttpCloudClient:
    return HttpCloudClient(
        base_url=BASE,
        device_id=DEVICE,
        principal_id=PRINCIPAL,
        audience=AUDIENCE,
        key=key,
        opener=opener,
    )


def test_pull_returns_events_flattened_for_the_archive(key: Ed25519PrivateKey) -> None:
    opener = FakeOpener([page(1, 2)])
    result = client(key, opener).pull(0)

    assert result.highest_sequence == 2
    assert [event["event_sequence"] for event in result.events] == [1, 2]
    assert result.events[0]["canonical_text"] == "hello"
    assert result.events[0]["event_type"] == "conversation.user_committed"


def test_consumer_id_is_bound_to_the_signing_device(key: Ed25519PrivateKey) -> None:
    # The gateway requires this exactly, so one device cannot advance another's
    # cursor even with a valid signature.
    opener = FakeOpener([page(1, 1)])
    client(key, opener).pull(0)
    assert opener.bodies[0]["consumerId"] == f"device:{DEVICE}"


def test_acknowledgement_quotes_the_position_before_the_page(key: Ed25519PrivateKey) -> None:
    """expectedCurrent must be where the cursor stood, not where it is going.

    Sending the new position would make the check tautological and let a stale
    client move the cursor anywhere.
    """
    opener = FakeOpener([page(6, 9), {"schemaVersion": "1.0", "currentSequence": 9, "replayed": False}])
    sync = client(key, opener)
    sync.pull(5)
    sync.acknowledge(9)

    ack = opener.bodies[1]
    assert ack["expectedCurrent"] == 5
    assert ack["throughSequence"] == 9
    assert ack["snapshotId"] == "snap-1"


def test_acknowledging_without_a_pull_is_refused(key: Ed25519PrivateKey) -> None:
    # Nothing to bind the acknowledgement to; guessing a snapshot id would be
    # asking the cloud to accept a cursor move on trust.
    with pytest.raises(CloudSyncError, match="before pulling"):
        client(key, FakeOpener([])).acknowledge(5)


def test_snapshot_token_is_carried_into_the_next_pull(key: Ed25519PrivateKey) -> None:
    opener = FakeOpener([page(1, 2, has_more=True), page(3, 4, snapshot="snap-2")])
    sync = client(key, opener)
    sync.pull(0)
    sync.pull(2)

    assert opener.bodies[0]["snapshotToken"] is None
    assert opener.bodies[1]["snapshotToken"] == "token-snap-1"


def test_requests_are_signed_and_body_is_the_canonical_bytes(key: Ed25519PrivateKey) -> None:
    opener = FakeOpener([page(1, 1)])
    client(key, opener).pull(0)

    _, _, headers = opener.requests[0]
    signed = json.loads(headers["x-jarvis-signed-request"])
    assert signed["deviceId"] == DEVICE
    assert signed["audience"] == AUDIENCE
    assert len(signed["bodyHash"]) == 64


def test_each_endpoint_is_signed_for_its_own_path(key: Ed25519PrivateKey) -> None:
    opener = FakeOpener([page(1, 1), {"schemaVersion": "1.0", "currentSequence": 1, "replayed": False}])
    sync = client(key, opener)
    sync.pull(0)
    sync.acknowledge(1)

    urls = [url for url, _, _ in opener.requests]
    assert urls == [f"{BASE}/sync/pull", f"{BASE}/sync/ack"]
    signatures = [json.loads(h["x-jarvis-signed-request"])["signatureBase64"] for _, _, h in opener.requests]
    assert signatures[0] != signatures[1]


@pytest.mark.parametrize("status", [401, 403])
def test_identity_rejection_is_distinct_from_a_transient_failure(
    key: Ed25519PrivateKey, status: int
) -> None:
    # Retrying will not help: the key is wrong, the device is inactive, or the
    # clock has drifted outside the freshness window.
    opener = FakeOpener([urllib.error.HTTPError(BASE, status, "no", {}, None)])  # type: ignore[arg-type]
    with pytest.raises(CloudAuthError):
        client(key, opener).pull(0)


@pytest.mark.parametrize("status", [500, 502, 429])
def test_server_failures_are_reported_as_sync_errors(key: Ed25519PrivateKey, status: int) -> None:
    opener = FakeOpener([urllib.error.HTTPError(BASE, status, "no", {}, None)])  # type: ignore[arg-type]
    with pytest.raises(CloudSyncError) as raised:
        client(key, opener).pull(0)
    assert not isinstance(raised.value, CloudAuthError)


def test_unreachable_gateway_is_a_sync_error(key: Ed25519PrivateKey) -> None:
    opener = FakeOpener([urllib.error.URLError("connection refused")])
    with pytest.raises(CloudSyncError, match="unreachable"):
        client(key, opener).pull(0)


def test_plaintext_transport_is_refused(key: Ed25519PrivateKey) -> None:
    # Signatures protect the request, not the response, and the archive is
    # built from the response.
    with pytest.raises(ValueError, match="https"):
        HttpCloudClient(
            base_url="http://gateway.example",
            device_id=DEVICE,
            principal_id=PRINCIPAL,
            audience=AUDIENCE,
            key=key,
        )


def test_an_unrecognised_payload_is_still_archived(key: Ed25519PrivateKey) -> None:
    """An event type this version does not interpret must not be dropped.

    The archive is permanent and complete; losing an event because a later
    version would have understood it better is not recoverable.
    """
    item = envelope(1)
    item["envelope"]["payload"] = {"updateId": 7, "reason": "unsupported_content"}
    opener = FakeOpener([{**page(1, 1), "events": [item]}])

    result = client(key, opener).pull(0)
    assert json.loads(result.events[0]["canonical_text"]) == {
        "reason": "unsupported_content",
        "updateId": 7,
    }
