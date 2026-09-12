"""Active facts reach the cloud as one restart-safe, signed snapshot."""

from __future__ import annotations

import io
import json
import sqlite3
import urllib.error
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.memory.facts import FactOrigin, FactProposal, FactRepository, FactState, Sensitivity
from jarvis_local.memory.promotion import PromotionEngine
from jarvis_local.sync.cloud_client import CloudSyncError, HttpCloudClient
from jarvis_local.sync.memory_projection import MemoryProjectionError, MemoryProjectionUploader

BASE = "https://gateway.example"
DEVICE = "device-vector"
PRINCIPAL = "principal:projection-vector"
AUDIENCE = "jarvis-local-agent"
EVENT_ID = "01k3w1t4000000000000000110"
CONTENT_HASH = "4d88ae4f8b685f140ef9103221b46a9fd3a9b90c74c315890ab786bd4ca88160"
PAGE_HASH = "d66840394f48b8f837e10e2fbdcc3cccbea82f7c321019bcab22f6b944ab6377"
MANIFEST_HASH = "f902cc11a9c3da36d53b2fb0ac3f71424f613f5c41585542923c4c028e2899dc"
BODY_HASH = "84763e2e95a651bfc2defacb584852fe6033787df84fe8aede5b2b1ec708a2cc"


class Response(io.BytesIO):
    def __enter__(self) -> Response:
        return self

    def __exit__(self, *_: object) -> None:
        return None


class ProjectionOpener:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float | None = None) -> Response:
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return Response(json.dumps(response).encode("utf-8"))

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.data.decode("utf-8")) for request in self.requests]


class BindingOpener:
    """Returns receipts bound to the request that arrived."""

    def __init__(self) -> None:
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float | None = None) -> Response:
        self.requests.append(request)
        body = json.loads(request.data.decode("utf-8"))
        page = body["operation"] == "page"
        return Response(
            json.dumps(
                {
                    "schemaVersion": "1.0",
                    "projectionVersion": body["projectionVersion"],
                    "manifestHash": body["manifestHash"],
                    "pageIndex": body["pageIndex"] if page else None,
                    "pageHash": body["pageHash"] if page else None,
                    "published": not page,
                    "replayed": False,
                }
            ).encode("utf-8")
        )

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.data.decode("utf-8")) for request in self.requests]


@pytest.fixture
def stores(tmp_path: Path) -> Iterator[tuple[ArchiveRepository, FactRepository, Path]]:
    memory_path = tmp_path / "memory.sqlite3"
    archive = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    facts = FactRepository.open(memory_path)
    yield archive, facts, memory_path
    archive.close()
    facts.close()


def cloud(opener: ProjectionOpener | BindingOpener) -> HttpCloudClient:
    return HttpCloudClient(
        base_url=BASE,
        device_id=DEVICE,
        principal_id=PRINCIPAL,
        audience=AUDIENCE,
        key=Ed25519PrivateKey.from_private_bytes(bytes(range(32))),
        opener=opener,
    )


def record_vector_fact(archive: ArchiveRepository, facts: FactRepository) -> None:
    archive.insert_event_if_absent(
        {
            "event_id": EVENT_ID,
            "event_sequence": 1,
            "event_type": "conversation.user_committed",
            "principal_id": PRINCIPAL,
            "session_id": "session-vector",
            "canonical_text": "Mon café préféré est le moka.",
            "occurred_at": "2026-09-11T12:00:00.000Z",
            "producer_version": "conversation-v1",
        },
        now="2026-09-11T12:00:00.000Z",
    )
    proposal = facts.record_proposal(
        FactProposal(
            principal_id=PRINCIPAL,
            text="Mon café préféré est le moka.",
            origin=FactOrigin.AUTHENTICATED_FIRST_PERSON,
            source_event_ids=(EVENT_ID,),
            sensitivity=Sensitivity.NORMAL,
            confidence=0.95,
            distiller_version="vector-v1",
        ),
        now="2026-09-11T12:00:00.000Z",
    )
    PromotionEngine(facts).promote(proposal)


def receipt(*, page: bool, replayed: bool = False) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "projectionVersion": 1,
        "manifestHash": MANIFEST_HASH,
        "pageIndex": 0 if page else None,
        "pageHash": PAGE_HASH if page else None,
        "published": not page,
        "replayed": replayed,
    }


def test_the_python_wire_form_matches_the_independent_rfc8785_vector(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    opener = ProjectionOpener([receipt(page=True), receipt(page=False)])

    result = MemoryProjectionUploader(facts, archive, cloud(opener)).project()

    assert result.published is True
    assert result.fact_count == 1
    page = opener.bodies[0]
    assert page == {
        "schemaVersion": "1.0",
        "operation": "page",
        "projectionVersion": 1,
        "pageIndex": 0,
        "pageCount": 1,
        "totalFactCount": 1,
        "pageHash": PAGE_HASH,
        "manifestHash": MANIFEST_HASH,
        "facts": [
            {
                "factId": f"fact_{CONTENT_HASH[:32]}",
                "text": "Mon café préféré est le moka.",
                "origin": "authenticated_first_person",
                "sensitivity": "normal",
                "confidence": 0.95,
                "distillerVersion": "vector-v1",
                "distilledAt": "2026-09-11T12:00:00.000Z",
                "contentHash": CONTENT_HASH,
                "sources": [{"eventId": EVENT_ID, "eventSequence": 1, "excerpt": "Mon café préféré est le moka."}],
            }
        ],
    }
    signed = json.loads(opener.requests[0].headers["X-jarvis-signed-request"])
    assert signed["bodyHash"] == BODY_HASH


def test_malformed_receipt_keeps_the_exact_snapshot_for_a_restart(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, memory_path = stores
    record_vector_fact(archive, facts)
    first = ProjectionOpener([{**receipt(page=True), "pageHash": "0" * 64}])

    with pytest.raises(MemoryProjectionError, match="receipt"):
        MemoryProjectionUploader(facts, archive, cloud(first)).project()

    facts.close()
    restarted = FactRepository.open(memory_path)
    try:
        second = ProjectionOpener([receipt(page=True, replayed=True), receipt(page=False)])
        result = MemoryProjectionUploader(restarted, archive, cloud(second)).project()
    finally:
        restarted.close()

    assert result.published is True
    assert second.bodies[0] == first.bodies[0]
    first_nonce = json.loads(first.requests[0].headers["X-jarvis-signed-request"])["nonce"]
    second_nonce = json.loads(second.requests[0].headers["X-jarvis-signed-request"])["nonce"]
    assert first_nonce != second_nonce


def test_an_unchanged_snapshot_does_not_publish_another_version(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    opener = ProjectionOpener([receipt(page=True), receipt(page=False)])
    uploader = MemoryProjectionUploader(facts, archive, cloud(opener))

    assert uploader.project().published is True
    assert uploader.project().published is False
    assert len(opener.requests) == 2


def test_lost_commit_response_restarts_with_the_same_pages_and_version(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, memory_path = stores
    record_vector_fact(archive, facts)
    first = ProjectionOpener([receipt(page=True), urllib.error.URLError("response lost after commit")])

    with pytest.raises(CloudSyncError):
        MemoryProjectionUploader(facts, archive, cloud(first)).project()
    saved_page = first.bodies[0]
    facts.close()

    restarted = FactRepository.open(memory_path)
    try:
        second = ProjectionOpener([receipt(page=True, replayed=True), receipt(page=False, replayed=True)])
        result = MemoryProjectionUploader(restarted, archive, cloud(second)).project()
        cursor = restarted.connection.execute(
            "SELECT published_version, published_digest FROM memory_projection_cursor"
        ).fetchone()
    finally:
        restarted.close()

    assert result.published is True
    assert result.fact_count == 1
    assert second.bodies[0] == saved_page
    assert cursor[0] == 1
    assert isinstance(cursor[1], str) and len(cursor[1]) == 64


def test_active_metadata_changes_publish_and_supersession_retracts_the_fact(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    opener = BindingOpener()
    uploader = MemoryProjectionUploader(facts, archive, cloud(opener))
    assert uploader.project().published is True

    # Sensitivity is projection material even though local fact identity is
    # deliberately based only on principal, text, and source IDs.
    facts.connection.execute(
        "UPDATE fact SET sensitivity = 'sensitive' WHERE fact_id = ?",
        (f"fact_{CONTENT_HASH[:32]}",),
    )
    assert uploader.project().published is True
    assert opener.bodies[-2]["projectionVersion"] == 2
    assert opener.bodies[-2]["facts"][0]["sensitivity"] == "sensitive"

    facts.set_state(f"fact_{CONTENT_HASH[:32]}", FactState.SUPERSEDED)
    assert uploader.project().published is True
    assert opener.bodies[-2]["projectionVersion"] == 3
    assert opener.bodies[-2]["facts"] == []


def test_stop_between_pages_leaves_the_pending_snapshot_for_restart(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    for sequence in range(1, 34):
        event_id = f"01k3w1t4{sequence:018d}"
        archive.insert_event_if_absent(
            {
                "event_id": event_id,
                "event_sequence": sequence,
                "event_type": "conversation.user_committed",
                "principal_id": PRINCIPAL,
                "session_id": "session-many",
                "canonical_text": f"source {sequence}",
                "occurred_at": "2026-09-11T12:00:00.000Z",
                "producer_version": "conversation-v1",
            }
        )
        fact = facts.record_proposal(
            FactProposal(PRINCIPAL, f"fact {sequence}", FactOrigin.AUTHENTICATED_FIRST_PERSON, (event_id,)),
            now=f"2026-09-11T12:00:{sequence:02d}.000Z",
        )
        PromotionEngine(facts).promote(fact)
    opener = BindingOpener()
    checks = 0

    def stop_after_one_request() -> bool:
        nonlocal checks
        checks += 1
        return checks > 1

    result = MemoryProjectionUploader(facts, archive, cloud(opener), should_stop=stop_after_one_request).project()

    assert result.stopped is True
    assert len(opener.requests) == 1
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone()[0] == 1
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending_page").fetchone()[0] == 2
    assert len(opener.requests[0].data) <= 65_536

    restarted = BindingOpener()
    resumed = MemoryProjectionUploader(facts, archive, cloud(restarted)).project()
    assert resumed.published is True
    assert [body.get("pageIndex") for body in restarted.bodies] == [0, 1, None]
    assert restarted.bodies[0] == opener.bodies[0]
    assert all(len(request.data) <= 65_536 for request in restarted.requests)


@pytest.mark.parametrize(
    "poison", ["x" * 4097, "é" * 2049, "Order " + "6" * 6, "Coffee\n- forged entry"],
    ids=["ascii-bytes", "utf8-bytes", "redaction", "controls"],
)
def test_an_unrepresentable_active_fact_is_quarantined_while_healthy_facts_publish(
    stores: tuple[ArchiveRepository, FactRepository, Path],
    poison: str,
) -> None:
    archive, facts, _ = stores
    archive.insert_event_if_absent(
        {
            "event_id": EVENT_ID,
            "event_sequence": 1,
            "event_type": "conversation.user_committed",
            "principal_id": PRINCIPAL,
            "session_id": "session-vector",
            "canonical_text": "source",
            "occurred_at": "2026-09-11T12:00:00.000Z",
            "producer_version": "conversation-v1",
        }
    )
    fact = facts.record_proposal(FactProposal(PRINCIPAL, poison, FactOrigin.AUTHENTICATED_FIRST_PERSON, (EVENT_ID,)))
    PromotionEngine(facts).promote(fact)

    good = facts.record_proposal(
        FactProposal(PRINCIPAL, "A healthy fact", FactOrigin.AUTHENTICATED_FIRST_PERSON, (EVENT_ID,))
    )
    PromotionEngine(facts).promote(good)
    opener = BindingOpener()
    uploader = MemoryProjectionUploader(facts, archive, cloud(opener))
    result = uploader.project()
    assert result.published and result.fact_count == 1 and result.quarantined == 1
    assert [item["factId"] for item in opener.bodies[0]["facts"]] == [good.fact_id]
    assert uploader.project().published is False
    assert facts.get(fact.fact_id).state is FactState.ACTIVE


def test_superseded_quarantined_facts_stop_counting_without_erasing_the_record(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    old = facts.active_facts(PRINCIPAL)[0]
    # Quarantine through the real explicit rejection and abandonment path.
    rejected = ProjectionOpener([rejection(), {**receipt(page=False), "published": False}])
    first = MemoryProjectionUploader(facts, archive, cloud(rejected)).project()
    assert first.quarantined == 1
    replacement = facts.record_proposal(
        FactProposal(PRINCIPAL, "A corrected preference", FactOrigin.AUTHENTICATED_FIRST_PERSON, (EVENT_ID,))
    )
    PromotionEngine(facts).promote(replacement)
    facts.supersede(superseding_fact_id=replacement.fact_id, superseded_fact_id=old.fact_id)

    opener = BindingOpener()
    uploader = MemoryProjectionUploader(facts, archive, cloud(opener))
    second = uploader.project()
    assert second.published and second.quarantined == 0
    assert [item["factId"] for item in opener.bodies[0]["facts"]] == [replacement.fact_id]
    assert uploader.project().quarantined == 0
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (1,)


def test_owner_can_retry_one_quarantined_fact_without_touching_other_quarantine(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    retried = facts.active_facts(PRINCIPAL)[0]
    other = facts.record_proposal(
        FactProposal(PRINCIPAL, "Another preference", FactOrigin.AUTHENTICATED_FIRST_PERSON, (EVENT_ID,))
    )
    PromotionEngine(facts).promote(other)
    for fact in (retried, facts.get(other.fact_id)):
        facts.connection.execute(
            "INSERT INTO memory_projection_quarantine VALUES (?, ?, ?, ?, 'gateway_rejected', ?)",
            (BASE, PRINCIPAL, DEVICE, fact.fact_id, "2026-09-11T12:00:00.000Z"),
        )
    opener = BindingOpener()
    uploader = MemoryProjectionUploader(facts, archive, cloud(opener))

    assert uploader.retry_quarantined(retried.fact_id) is True
    result = uploader.project()

    assert result.published and result.quarantined == 1
    assert [fact["factId"] for fact in opener.bodies[0]["facts"]] == [retried.fact_id]
    assert facts.connection.execute(
        "SELECT fact_id FROM memory_projection_quarantine ORDER BY fact_id"
    ).fetchall() == [(other.fact_id,)]


def test_quarantine_retry_is_scoped_to_the_exact_owner_tuple(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    fact_id = facts.active_facts(PRINCIPAL)[0].fact_id
    owners = (
        (BASE, PRINCIPAL, DEVICE),
        ("https://staging.example", PRINCIPAL, DEVICE),
        (BASE, "principal:other", DEVICE),
        (BASE, PRINCIPAL, "device:replacement"),
    )
    for owner in owners:
        facts.connection.execute(
            "INSERT INTO memory_projection_quarantine VALUES (?, ?, ?, ?, 'gateway_rejected', ?)",
            (*owner, fact_id, "2026-09-11T12:00:00.000Z"),
        )

    uploader = MemoryProjectionUploader(facts, archive, cloud(BindingOpener()))
    assert uploader.retry_quarantined(fact_id) is True

    assert facts.connection.execute(
        """SELECT gateway_origin, principal_id, device_id
           FROM memory_projection_quarantine ORDER BY gateway_origin, principal_id, device_id"""
    ).fetchall() == sorted(owners[1:])


def test_malformed_fact_id_is_refused_before_any_quarantine_delete(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    statements: list[str] = []
    facts.connection.set_trace_callback(statements.append)
    try:
        uploader = MemoryProjectionUploader(facts, archive, cloud(BindingOpener()))
        assert uploader.retry_quarantined("fact_not-hex") is False
    finally:
        facts.connection.set_trace_callback(None)

    assert not any("DELETE FROM memory_projection_quarantine" in statement for statement in statements)


def test_a_foreign_source_is_never_copied_into_the_upload(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    foreign_id = "01k3w1t4000000000000000111"
    archive.insert_event_if_absent(
        {
            "event_id": foreign_id,
            "event_sequence": 2,
            "event_type": "conversation.user_committed",
            "principal_id": "principal:other",
            "session_id": "foreign",
            "canonical_text": "Another person's conversation",
            "occurred_at": "2026-09-11T12:00:00.000Z",
            "producer_version": "conversation-v1",
        }
    )
    bad = facts.record_proposal(
        FactProposal(PRINCIPAL, "Foreign citation", FactOrigin.AUTHENTICATED_FIRST_PERSON, (foreign_id,))
    )
    PromotionEngine(facts).promote(bad)
    opener = BindingOpener()
    result = MemoryProjectionUploader(facts, archive, cloud(opener)).project()
    assert result.fact_count == 1 and result.quarantined == 1
    assert all(b"Another person's conversation" not in request.data for request in opener.requests)


def rejection(code: str = "memory_projection_content_rejected") -> urllib.error.HTTPError:
    return urllib.error.HTTPError(BASE, 400, "rejected", {}, io.BytesIO(json.dumps({"error": code}).encode()))  # type: ignore[arg-type]


def test_a_legacy_fact_with_nine_sources_does_not_block_an_eight_source_fact(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    ids = []
    for sequence in range(1, 10):
        event_id = f"01k3w1t4{sequence:018d}"
        ids.append(event_id)
        archive.insert_event_if_absent(
            {
                "event_id": event_id,
                "event_sequence": sequence,
                "event_type": "conversation.user_committed",
                "principal_id": PRINCIPAL,
                "session_id": "sources",
                "canonical_text": "A source",
                "occurred_at": "2026-09-11T12:00:00.000Z",
                "producer_version": "conversation-v1",
            }
        )
    for count in (8, 9):
        fact = facts.record_proposal(
            FactProposal(
                PRINCIPAL,
                f"Has {count} sources",
                FactOrigin.AUTHENTICATED_FIRST_PERSON,
                tuple(ids[:count]),
            )
        )
        PromotionEngine(facts).promote(fact)
    opener = BindingOpener()
    source_reads: list[str] = []
    archive.connection.set_trace_callback(
        lambda sql: source_reads.append(sql) if "FROM archive_event WHERE event_id" in sql else None
    )
    result = MemoryProjectionUploader(facts, archive, cloud(opener)).project()
    archive.connection.set_trace_callback(None)
    assert result.fact_count == 1 and result.quarantined == 1
    assert [item["text"] for item in opener.bodies[0]["facts"]] == ["Has 8 sources"]
    # Refuse the oversized source set before reading any of its excerpts.
    assert len(source_reads) == 8


def test_a_rejected_pending_page_is_abandoned_and_new_facts_publish_after_restart(
    stores: tuple[ArchiveRepository, FactRepository, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive, facts, memory_path = stores
    record_vector_fact(archive, facts)
    facts.set_state(f"fact_{CONTENT_HASH[:32]}", FactState.SUPERSEDED)
    poison = facts.record_proposal(
        FactProposal(
            PRINCIPAL,
            "Order " + "6" * 6,
            FactOrigin.AUTHENTICATED_FIRST_PERSON,
            (EVENT_ID,),
        )
    )
    PromotionEngine(facts).promote(poison)
    # First preserve a durable pending snapshot, as produced by the old agent.
    lost = ProjectionOpener([urllib.error.URLError("offline")])
    with monkeypatch.context() as legacy:
        legacy.setattr("jarvis_local.sync.memory_projection.redaction_would_change", lambda _: False)
        with pytest.raises(CloudSyncError):
            MemoryProjectionUploader(facts, archive, cloud(lost)).project()
    assert lost.bodies[0]["facts"][0]["text"] == poison.text
    abandoned = {**receipt(page=False), "manifestHash": lost.bodies[0]["manifestHash"], "published": False}
    first = ProjectionOpener([rejection(), urllib.error.URLError("abandon response lost")])
    with pytest.raises(CloudSyncError):
        MemoryProjectionUploader(facts, archive, cloud(first)).resume_pending()
    assert [body["operation"] for body in first.bodies] == ["page", "abandon"]
    assert facts.connection.execute("SELECT published_version FROM memory_projection_cursor").fetchone() == (0,)
    facts.close()
    restarted = FactRepository.open(memory_path)
    try:
        second = ProjectionOpener([{**abandoned, "replayed": True}])
        result = MemoryProjectionUploader(restarted, archive, cloud(second)).resume_pending()
        assert result is not None and result.quarantined == 1 and not result.published
        assert second.bodies == [first.bodies[1]]
        assert restarted.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone() == (0,)
        restarted.set_state(poison.fact_id, FactState.SUPERSEDED)
        good = restarted.record_proposal(
            FactProposal(PRINCIPAL, "A new healthy fact", FactOrigin.AUTHENTICATED_FIRST_PERSON, (EVENT_ID,))
        )
        PromotionEngine(restarted).promote(good)
        third = BindingOpener()
        assert MemoryProjectionUploader(restarted, archive, cloud(third)).project().published
        assert third.bodies[0]["projectionVersion"] == 1
        assert [item["factId"] for item in third.bodies[0]["facts"]] == [good.fact_id]
    finally:
        restarted.close()


@pytest.mark.parametrize("code", ["sync_request_rejected", "memory_projection_source_missing"])
def test_an_unknown_http_400_preserves_pending_without_quarantining(
    stores: tuple[ArchiveRepository, FactRepository, Path],
    code: str,
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    opener = ProjectionOpener([rejection(code)])
    with pytest.raises(CloudSyncError):
        MemoryProjectionUploader(facts, archive, cloud(opener)).project()
    assert len(opener.requests) == 1
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone() == (1,)
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (0,)
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_rejection").fetchone() == (0,)


@pytest.mark.parametrize("published", [False, True])
def test_only_an_exact_abandon_receipt_can_clear_pending_or_advance(
    stores: tuple[ArchiveRepository, FactRepository, Path],
    published: bool,
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    bad = {**receipt(page=False), "published": published, "manifestHash": "0" * 64}
    with pytest.raises(CloudSyncError):
        MemoryProjectionUploader(facts, archive, cloud(ProjectionOpener([rejection(), bad]))).project()
    assert facts.connection.execute("SELECT published_version FROM memory_projection_cursor").fetchone() == (0,)
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone() == (1,)
    good = {**receipt(page=False), "published": published}
    result = MemoryProjectionUploader(facts, archive, cloud(ProjectionOpener([good]))).resume_pending()
    assert result is not None and result.published is published
    assert facts.connection.execute("SELECT published_version FROM memory_projection_cursor").fetchone() == (
        int(published),
    )
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (
        0 if published else 1,
    )


@pytest.mark.parametrize("phase", ["page", "commit"])
@pytest.mark.parametrize(
    "field,value",
    [
        ("manifestHash", "0" * 64),
        ("projectionVersion", 2),
        ("pageIndex", 7),
        ("published", "flip"),
        ("replayed", 1),
    ],
)
def test_each_receipt_binding_keeps_the_cursor_and_pending_on_mismatch(
    stores: tuple[ArchiveRepository, FactRepository, Path],
    phase: str,
    field: str,
    value: Any,
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    page = phase == "page"
    malformed = {**receipt(page=page), field: page if value == "flip" else value}
    opener = ProjectionOpener([malformed] if page else [receipt(page=True), malformed])
    with pytest.raises(MemoryProjectionError, match="receipt"):
        MemoryProjectionUploader(facts, archive, cloud(opener)).project()
    assert facts.connection.execute("SELECT published_version FROM memory_projection_cursor").fetchone() == (0,)
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone() == (1,)


def test_equal_timestamp_facts_keep_the_same_digest_when_database_order_changes(
    stores: tuple[ArchiveRepository, FactRepository, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    second = facts.record_proposal(
        FactProposal(PRINCIPAL, "Another fact", FactOrigin.AUTHENTICATED_FIRST_PERSON, (EVENT_ID,)),
        now="2026-09-11T12:00:00.000Z",
    )
    PromotionEngine(facts).promote(second)
    original = facts.active_facts
    opener = BindingOpener()
    uploader = MemoryProjectionUploader(facts, archive, cloud(opener))
    assert uploader.project().published
    monkeypatch.setattr(facts, "active_facts", lambda principal: list(reversed(original(principal))))
    assert uploader.project().published is False
    assert len(opener.requests) == 2


def test_receipt_booleans_are_not_accepted_as_truthy_numbers(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    malformed = {**receipt(page=True), "published": 0}

    with pytest.raises(MemoryProjectionError, match="receipt"):
        MemoryProjectionUploader(facts, archive, cloud(ProjectionOpener([malformed]))).project()


def test_malformed_commit_receipt_keeps_pending_and_does_not_advance(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    malformed = {**receipt(page=False), "published": 1}
    opener = ProjectionOpener([receipt(page=True), malformed])

    with pytest.raises(MemoryProjectionError, match="receipt"):
        MemoryProjectionUploader(facts, archive, cloud(opener)).project()

    assert facts.connection.execute("SELECT published_version FROM memory_projection_cursor").fetchone() == (0,)
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone() == (1,)


def test_corrupt_persisted_page_is_refused_before_any_request(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    first = ProjectionOpener([{**receipt(page=True), "pageHash": "0" * 64}])
    with pytest.raises(MemoryProjectionError):
        MemoryProjectionUploader(facts, archive, cloud(first)).project()
    page = json.loads(facts.connection.execute("SELECT page_json FROM memory_projection_pending_page").fetchone()[0])
    page["unexpected"] = "not covered by the page hash"
    facts.connection.execute(
        "UPDATE memory_projection_pending_page SET page_json = ?",
        (json.dumps(page),),
    )
    no_network = ProjectionOpener([])

    with pytest.raises(MemoryProjectionError, match="persisted projection"):
        MemoryProjectionUploader(facts, archive, cloud(no_network)).project()
    assert no_network.requests == []


def test_corrupt_persisted_content_digest_is_refused_before_any_request(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    first = ProjectionOpener([{**receipt(page=True), "pageHash": "0" * 64}])
    with pytest.raises(MemoryProjectionError):
        MemoryProjectionUploader(facts, archive, cloud(first)).project()
    facts.connection.execute(
        "UPDATE memory_projection_pending SET content_digest = ?",
        ("0" * 64,),
    )
    no_network = ProjectionOpener([])

    with pytest.raises(MemoryProjectionError, match="persisted projection"):
        MemoryProjectionUploader(facts, archive, cloud(no_network)).project()
    assert no_network.requests == []


@pytest.mark.parametrize("corruption", ["boolean-page-index", "unhashable-origin"])
def test_malformed_persisted_json_is_refused_before_any_request(
    stores: tuple[ArchiveRepository, FactRepository, Path], corruption: str
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    first = ProjectionOpener([{**receipt(page=True), "pageHash": "0" * 64}])
    with pytest.raises(MemoryProjectionError):
        MemoryProjectionUploader(facts, archive, cloud(first)).project()
    page = json.loads(facts.connection.execute("SELECT page_json FROM memory_projection_pending_page").fetchone()[0])
    if corruption == "boolean-page-index":
        page["pageIndex"] = False
    else:
        page["facts"][0]["origin"] = []
    facts.connection.execute(
        "UPDATE memory_projection_pending_page SET page_json = ?",
        (json.dumps(page),),
    )
    no_network = ProjectionOpener([])

    with pytest.raises(MemoryProjectionError, match="persisted projection"):
        MemoryProjectionUploader(facts, archive, cloud(no_network)).project()
    assert no_network.requests == []


def test_published_cursor_requires_both_integrity_hashes(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    _, facts, _ = stores
    with pytest.raises(sqlite3.IntegrityError):
        facts.connection.execute(
            """
            INSERT INTO memory_projection_cursor
                (gateway_origin, principal_id, device_id, published_version,
                 published_digest, published_manifest, updated_at)
            VALUES (?, ?, ?, 1, NULL, NULL, ?)
            """,
            (BASE, PRINCIPAL, DEVICE, "2026-09-11T12:00:00.000Z"),
        )


def test_only_active_facts_are_projected_and_confirmed_origins_are_allowed(
    stores: tuple[ArchiveRepository, FactRepository, Path],
) -> None:
    archive, facts, _ = stores
    archive.insert_event_if_absent(
        {
            "event_id": EVENT_ID,
            "event_sequence": 1,
            "event_type": "conversation.user_committed",
            "principal_id": PRINCIPAL,
            "session_id": "session-vector",
            "canonical_text": "source",
            "occurred_at": "2026-09-11T12:00:00.000Z",
            "producer_version": "conversation-v1",
        }
    )
    model = facts.record_proposal(FactProposal(PRINCIPAL, "model proposal", FactOrigin.MODEL, (EVENT_ID,)))
    third_party = facts.record_proposal(
        FactProposal(PRINCIPAL, "third-party proposal", FactOrigin.THIRD_PARTY, (EVENT_ID,))
    )
    opener = BindingOpener()
    uploader = MemoryProjectionUploader(facts, archive, cloud(opener))

    assert uploader.project().fact_count == 0
    assert opener.bodies[0]["facts"] == []
    PromotionEngine(facts).confirm(model)
    PromotionEngine(facts).confirm(third_party)
    assert uploader.project().fact_count == 2
    assert {fact["origin"] for fact in opener.bodies[-2]["facts"]} == {"model", "third_party"}


def test_more_than_the_total_fact_limit_fails_without_a_request(
    stores: tuple[ArchiveRepository, FactRepository, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    archive, facts, _ = stores
    record_vector_fact(archive, facts)
    active = facts.active_facts(PRINCIPAL)[0]
    monkeypatch.setattr(facts, "active_facts", lambda _: [active] * 1_025)
    opener = BindingOpener()

    with pytest.raises(MemoryProjectionError, match="snapshot exceeds"):
        MemoryProjectionUploader(facts, archive, cloud(opener)).project()
    assert opener.requests == []
    assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone() == (0,)
