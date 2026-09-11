"""HTTP client for the cloud gateway's sync endpoints.

Implements the `CloudClient` protocol the replicator depends on, over
device-signed requests.

Snapshot semantics matter here. `pull` returns a snapshot token, and the
acknowledgement quotes the snapshot id it came from. That pairing is what lets
the cloud detect an acknowledgement written against a view of the log that has
since moved, rather than silently accepting a cursor that skips events.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.crypto.signed_request import build_signed_request
from jarvis_local.sync.cursor_store import PendingSyncAck, SyncAckIdentity
from jarvis_local.sync.event_replicator import EventPage

PULL_PATH = "/sync/pull"
ACK_PATH = "/sync/ack"
SCHEMA_VERSION = "1.0"
DEFAULT_PAGE_SIZE = 128
DEFAULT_TIMEOUT_SECONDS = 30.0

#: Identifies the agent to the gateway.
#:
#: Not cosmetic. urllib's default (`Python-urllib/x.y`) is rejected by
#: Cloudflare's edge bot protection with a 403 that never reaches the
#: Worker -- so it appears as an authentication failure with no matching
#: entry in the Worker logs, which is a genuinely confusing place to land.
USER_AGENT = "jarvis-local-agent/0.1.0"


class CloudSyncError(RuntimeError):
    """The gateway refused a request or answered unusably."""


class CloudAuthError(CloudSyncError):
    """The gateway rejected our identity or signature.

    Separate from the general failure because retrying will not help: the key
    is wrong, the device is no longer active, or the clock has drifted outside
    the freshness window.
    """


class CloudAckRejectedError(CloudSyncError):
    """A well-formed acknowledgement was refused with HTTP 400."""


@dataclass(frozen=True, slots=True)
class SnapshotCursor:
    """The snapshot a page came from, needed to acknowledge it."""

    snapshot_id: str
    snapshot_token: str
    #: The cursor position this page was pulled from. The acknowledgement
    #: quotes it as `expectedCurrent`, so the cloud can reject an
    #: acknowledgement written against a position its cursor has already left.
    after_sequence: int
    through_sequence: int
    has_more: bool


class HttpCloudClient:
    """Talks to the gateway over signed HTTPS."""

    def __init__(
        self,
        *,
        base_url: str,
        device_id: str,
        principal_id: str,
        audience: str,
        key: Ed25519PrivateKey,
        page_size: int = DEFAULT_PAGE_SIZE,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        # urlopen-compatible callable. Injected in tests; Any because the
        # stdlib exposes no protocol for it.
        opener: Any = None,  # noqa: ANN401
    ) -> None:
        if not base_url.startswith("https://"):
            # Signatures do not protect the response, and the archive is built
            # from what comes back. Plaintext transport would let anyone on the
            # path decide what Jarvis remembers.
            raise ValueError("cloud base URL must be https")
        self.base_url = base_url.rstrip("/")
        self.device_id = device_id
        self.principal_id = principal_id
        self.audience = audience
        self.key = key
        self.page_size = page_size
        self.timeout_seconds = timeout_seconds
        self._opener = opener or urllib.request.urlopen
        self._snapshot: SnapshotCursor | None = None

    # -- CloudClient protocol ---------------------------------------------

    def pull(self, after_sequence: int) -> EventPage:
        continuation = self._snapshot
        return self._pull_page(
            after_sequence,
            page_size=self.page_size,
            snapshot_token=(
                continuation.snapshot_token
                if continuation is not None
                and continuation.has_more
                and after_sequence == continuation.through_sequence
                else None
            ),
        )

    def recover_ack_page(self, acknowledgement: PendingSyncAck) -> EventPage:
        """Fetch a fresh root page for exactly one durable, rejected ACK range."""
        pending = self._pending_ack(acknowledgement)
        expected = pending.expected_current
        if expected is None:
            raise CloudSyncError("pending acknowledgement has no durable boundary")
        page_size = pending.through_sequence - expected
        if page_size < 1 or page_size > self.page_size:
            raise CloudSyncError("pending acknowledgement range is invalid")
        return self._pull_page(expected, page_size=page_size, snapshot_token=None)

    def _pull_page(
        self,
        after_sequence: int,
        *,
        page_size: int,
        snapshot_token: str | None,
    ) -> EventPage:
        body = {
            "schemaVersion": SCHEMA_VERSION,
            # The gateway requires this to equal `device:<deviceId>` exactly,
            # binding the cursor to the signing device rather than letting one
            # device advance another's position.
            "consumerId": f"device:{self.device_id}",
            "afterSequence": after_sequence,
            "pageSize": page_size,
            "snapshotToken": snapshot_token,
        }
        page = self._post(PULL_PATH, body)

        raw_events = page.get("events")
        returned_from = page.get("fromSequence")
        through = page.get("toSequence")
        snapshot_id = page.get("snapshotId")
        snapshot_token = page.get("snapshotToken")
        has_more = page.get("hasMore")
        if (
            not isinstance(raw_events, list)
            or type(returned_from) is not int
            or returned_from != after_sequence
            or type(through) is not int
            or through < after_sequence
            or not isinstance(snapshot_id, str)
            or not snapshot_id
            or not isinstance(snapshot_token, str)
            or not snapshot_token
            or not isinstance(has_more, bool)
        ):
            raise CloudSyncError("gateway returned an invalid sync page")
        events = tuple(self._flatten(item) for item in raw_events)
        if len(events) != through - after_sequence or (not events and has_more):
            raise CloudSyncError("gateway returned an invalid sync page")
        snapshot = SnapshotCursor(
            snapshot_id=snapshot_id,
            snapshot_token=snapshot_token,
            after_sequence=after_sequence,
            through_sequence=through,
            has_more=has_more,
        )
        # An empty page has no local transaction and therefore no ACK. Its
        # token is complete and must not be presented as a continuation on the
        # next scheduled cycle.
        self._snapshot = snapshot if events else None
        return EventPage(
            events=events,
            highest_sequence=through,
            acknowledgement=(
                SyncAckIdentity(
                    snapshot_id=snapshot_id,
                    expected_current=after_sequence,
                    gateway_origin=self.base_url,
                    device_id=self.device_id,
                    principal_id=self.principal_id,
                )
                if events else None
            ),
        )

    def acknowledge(self, acknowledgement: PendingSyncAck | int) -> None:
        pending = self._pending_ack(acknowledgement)
        response = self._post(
            ACK_PATH,
            {
                "schemaVersion": SCHEMA_VERSION,
                "snapshotId": pending.snapshot_id,
                # Where the cursor stood before this page. The cloud rejects the
                # acknowledgement unless its stored cursor still matches, so a
                # stale client cannot roll the position backwards.
                "expectedCurrent": pending.expected_current,
                "throughSequence": pending.through_sequence,
            },
        )
        if (
            set(response) != {"schemaVersion", "currentSequence", "replayed"}
            or response.get("schemaVersion") != SCHEMA_VERSION
            or type(response.get("currentSequence")) is not int
            or response.get("currentSequence") != pending.through_sequence
            or not isinstance(response.get("replayed"), bool)
        ):
            raise CloudSyncError("gateway returned an invalid acknowledgement receipt")
        # Once the page is accepted, the cloud cursor equals our durable local
        # cursor. A fresh root snapshot is safe and avoids carrying a five-
        # minute continuation token into the next 20-30 minute node cycle.
        self._snapshot = None

    def _pending_ack(self, acknowledgement: PendingSyncAck | int) -> PendingSyncAck:
        if isinstance(acknowledgement, int):
            snapshot = self._snapshot
            if snapshot is None:
                raise CloudSyncError("cannot acknowledge before pulling a page")
            if acknowledgement != snapshot.through_sequence:
                raise CloudSyncError("acknowledgement does not match the pulled page")
            return PendingSyncAck(
                consumer="direct",
                through_sequence=acknowledgement,
                staged_at="direct",
                snapshot_id=snapshot.snapshot_id,
                expected_current=snapshot.after_sequence,
                gateway_origin=self.base_url,
                device_id=self.device_id,
                principal_id=self.principal_id,
            )
        if (
            not acknowledgement.has_snapshot_identity()
            or acknowledgement.gateway_origin != self.base_url
            or acknowledgement.device_id != self.device_id
            or acknowledgement.principal_id != self.principal_id
            or acknowledgement.expected_current is None
            or acknowledgement.expected_current < 0
            or acknowledgement.expected_current >= acknowledgement.through_sequence
        ):
            raise CloudSyncError("pending acknowledgement does not belong to this client")
        return acknowledgement

    # -- internals --------------------------------------------------------

    def _flatten(self, item: Any) -> dict[str, Any]:  # noqa: ANN401 - decoded JSON
        """Turn a SequencedEventV1 into the flat shape the archive stores.

        The wire form nests the envelope under the sequence; the archive keeps
        the sequence as a column alongside the envelope's own fields.
        """
        envelope = item["envelope"]
        payload = envelope.get("payload", {})
        return {
            "event_id": envelope["eventId"],
            "event_sequence": int(item["eventSequence"]),
            "event_type": envelope["eventType"],
            "principal_id": envelope.get("subjectId", ""),
            "session_id": envelope.get("correlationId", ""),
            "canonical_text": _text_of(payload),
            "occurred_at": envelope["occurredAt"],
            "producer_version": envelope["producerVersion"],
        }

    def post_signed(self, path: str, body: Any) -> dict[str, Any]:  # noqa: ANN401 - per-endpoint shape
        """Sign and send one request. Public so other endpoints share this transport."""
        return self._post(path, body)

    def _post(self, path: str, body: Any) -> dict[str, Any]:  # noqa: ANN401 - per-endpoint shape
        signed = build_signed_request(
            self.key,
            device_id=self.device_id,
            principal_id=self.principal_id,
            audience=self.audience,
            method="POST",
            path=path,
            body=body,
        )
        # The signed envelope travels in a header and the canonical body as the
        # raw payload, because the gateway hashes exactly the bytes it receives.
        request = urllib.request.Request(  # noqa: S310 - scheme checked in __init__
            f"{self.base_url}{path}",
            data=signed.raw_body,
            method="POST",
            headers={
                "content-type": "application/json",
                "user-agent": USER_AGENT,
                "x-jarvis-signed-request": json.dumps(signed.envelope, separators=(",", ":")),
            },
        )
        try:
            with self._opener(request, timeout=self.timeout_seconds) as response:
                decoded = json.loads(response.read().decode("utf-8"))
            # The gateway always answers with an object. Anything else means we
            # are not talking to the gateway, so refuse rather than index into it.
            if not isinstance(decoded, dict):
                raise CloudSyncError(f"gateway returned {type(decoded).__name__}, expected an object")
            return decoded
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise CloudAuthError(f"gateway rejected the device: HTTP {error.code}") from error
            if path == ACK_PATH and error.code == 400:
                raise CloudAckRejectedError("gateway rejected the acknowledgement") from error
            raise CloudSyncError(f"gateway returned HTTP {error.code}") from error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise CloudSyncError(f"gateway unreachable or unusable: {error}") from error


def _text_of(payload: Any) -> str:  # noqa: ANN401 - decoded JSON
    """Best-effort canonical text for the archive.

    Conversation events carry their text directly. Anything else is archived
    by its canonical JSON, so the record is complete even for event types this
    version does not interpret.
    """
    if isinstance(payload, dict):
        text = payload.get("text")
        if isinstance(text, str):
            return text
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)
