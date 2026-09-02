"""Signed distillation requests to the cloud gateway.

Implements the `DistillationClient` protocol the coordinator depends on. The
agent never holds the model key: it submits excerpts and the gateway does the
asking.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from jarvis_local.memory.distillation import Excerpt
from jarvis_local.sync.cloud_client import HttpCloudClient

DISTILL_PATH = "/memory/distill"


class HttpDistillationClient:
    """Submits excerpts over the same signed transport as replication."""

    def __init__(self, cloud: HttpCloudClient) -> None:
        # Reuses the sync client's signing, transport, User-Agent and error
        # classification. Duplicating those here would be a second place for
        # them to drift.
        self._cloud = cloud

    def distill(self, excerpts: Sequence[Excerpt]) -> Sequence[dict[str, Any]]:
        response = self._cloud.post_signed(
            DISTILL_PATH,
            {
                "schemaVersion": "1.0",
                "excerpts": [
                    {"sourceEventId": excerpt.source_event_id, "text": excerpt.text}
                    for excerpt in excerpts
                ],
            },
        )
        proposals = response.get("proposals")
        # A response without a proposals array is not a failure worth raising
        # over -- distillation is best-effort background work, and the events
        # remain in the archive to be reconsidered on a later run.
        if not isinstance(proposals, list):
            return []
        return [item for item in proposals if isinstance(item, dict)]
