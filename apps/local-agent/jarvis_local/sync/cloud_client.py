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
        body = {
            "schemaVersion": SCHEMA_VERSION,
            # The gateway requires this to equal `device:<deviceId>` exactly,
            # binding the cursor to the signing device rather than letting one
            # device advance another's position.
            "consumerId": f"device:{self.device_id}",
            "afterSequence": after_sequence,
            "pageSize": self.page_size,
            "snapshotToken": self._snapshot.snapshot_token if self._snapshot else None,
        }
        page = self._post(PULL_PATH, body)

        events = tuple(self._flatten(item) for item in page.get("events", []))
        through = int(page.get("toSequence", after_sequence))
        self._snapshot = SnapshotCursor(
            snapshot_id=str(page["snapshotId"]),
            snapshot_token=str(page["snapshotToken"]),
            after_sequence=after_sequence,
            through_sequence=through,
        )
        return EventPage(events=events, highest_sequence=through)

    def acknowledge(self, through_sequence: int) -> None:
        snapshot = self._snapshot
        if snapshot is None:
            raise CloudSyncError("cannot acknowledge before pulling a page")
        self._post(
            ACK_PATH,
            {
                "schemaVersion": SCHEMA_VERSION,
                "snapshotId": snapshot.snapshot_id,
                # Where the cursor stood before this page. The cloud rejects the
                # acknowledgement unless its stored cursor still matches, so a
                # stale client cannot roll the position backwards.
                "expectedCurrent": snapshot.after_sequence,
                "throughSequence": int(through_sequence),
            },
        )

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
