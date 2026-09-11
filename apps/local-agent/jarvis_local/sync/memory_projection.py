"""Restart-safe publication of active local facts to the cloud gateway."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import rfc8785

from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.archive.content_store import normalize_nfc
from jarvis_local.clock import utc_now_iso
from jarvis_local.memory.facts import Fact, FactRepository, fact_content_hash
from jarvis_local.sync.cloud_client import CloudSyncError, HttpCloudClient

MEMORY_PROJECTION_PATH = "/sync/memory/project"
MAX_REQUEST_BYTES = 65_536
MAX_PROJECTION_PAGES = 32
MAX_FACTS_PER_PAGE = 32
MAX_PROJECTION_FACTS = 1_024
MAX_SOURCES_PER_FACT = 8
MAX_UNIQUE_SOURCES_PER_PAGE = 32
MAX_FACT_BYTES = 4_096
MAX_EXCERPT_BYTES = 4_096
MAX_VERSION_BYTES = 128

_ULID = re.compile(r"^[0-7][0-9a-hjkmnp-tv-z]{25}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_FACT_ID = re.compile(r"^fact_[a-f0-9]{32}$")
_UTC_MILLISECONDS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_PAGE_FIELDS = {
    "schemaVersion", "operation", "projectionVersion", "pageIndex", "pageCount",
    "totalFactCount", "pageHash", "manifestHash", "facts",
}
_FACT_FIELDS = {
    "factId", "text", "origin", "sensitivity", "confidence", "distillerVersion",
    "distilledAt", "contentHash", "sources",
}
_SOURCE_FIELDS = {"eventId", "eventSequence", "excerpt"}
_ORIGINS = {"authenticated_first_person", "deterministic_observation", "model", "third_party"}


class MemoryProjectionError(CloudSyncError):
    """The local snapshot or the gateway receipt is unsafe to publish."""


@dataclass(frozen=True, slots=True)
class ProjectionResult:
    published: bool
    fact_count: int
    stopped: bool = False


@dataclass(frozen=True, slots=True)
class _Pending:
    version: int
    content_digest: str
    manifest_hash: str
    page_count: int
    fact_count: int
    pages: tuple[dict[str, Any], ...]


class MemoryProjectionUploader:
    """Build once, persist, then resend one immutable projection until committed."""

    def __init__(
        self,
        facts: FactRepository,
        archive: ArchiveRepository,
        cloud: HttpCloudClient,
        *,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> None:
        self._facts = facts
        self._archive = archive
        self._cloud = cloud
        self._should_stop = should_stop

    def project(self) -> ProjectionResult:
        pending = self._load_pending()
        if pending is None:
            pending = self._prepare_pending()
        if pending is None:
            return ProjectionResult(False, len(self._facts.active_facts(self._cloud.principal_id)))

        for page in pending.pages:
            if self._should_stop():
                return ProjectionResult(False, pending.fact_count, stopped=True)
            receipt = self._cloud.post_signed(MEMORY_PROJECTION_PATH, page)
            self._validate_receipt(receipt, pending, page=page)

        if self._should_stop():
            return ProjectionResult(False, pending.fact_count, stopped=True)
        commit = {
            "schemaVersion": "1.0",
            "operation": "commit",
            "projectionVersion": pending.version,
            "pageCount": pending.page_count,
            "totalFactCount": pending.fact_count,
            "manifestHash": pending.manifest_hash,
        }
        receipt = self._cloud.post_signed(MEMORY_PROJECTION_PATH, commit)
        self._validate_receipt(receipt, pending, page=None)
        self._record_published(pending)
        return ProjectionResult(True, pending.fact_count)

    @property
    def _owner(self) -> tuple[str, str, str]:
        return (self._cloud.base_url, self._cloud.principal_id, self._cloud.device_id)

    def _load_pending(self) -> _Pending | None:
        row = self._facts.connection.execute(
            """
            SELECT projection_version, content_digest, manifest_hash, page_count, total_fact_count
            FROM memory_projection_pending
            WHERE gateway_origin = ? AND principal_id = ? AND device_id = ?
            """,
            self._owner,
        ).fetchone()
        if row is None:
            return None
        page_rows = self._facts.connection.execute(
            """
            SELECT projection_version, page_index, page_hash, page_json
            FROM memory_projection_pending_page
            WHERE gateway_origin = ? AND principal_id = ? AND device_id = ?
            ORDER BY page_index ASC
            """,
            self._owner,
        ).fetchall()
        if len(page_rows) != int(row[3]):
            raise MemoryProjectionError("the persisted projection is incomplete")
        pages: list[dict[str, Any]] = []
        for expected, page_row in enumerate(page_rows):
            try:
                decoded = json.loads(str(page_row[3]), parse_constant=_reject_json_constant)
            except (TypeError, ValueError) as error:
                raise MemoryProjectionError("the persisted projection is corrupt") from error
            if (
                not isinstance(decoded, dict)
                or type(page_row[0]) is not int
                or page_row[0] != int(row[0])
                or type(page_row[1]) is not int
                or page_row[1] != expected
                or decoded.get("pageHash") != page_row[2]
            ):
                raise MemoryProjectionError("the persisted projection is corrupt")
            pages.append(decoded)
        pending = _Pending(int(row[0]), str(row[1]), str(row[2]), int(row[3]), int(row[4]), tuple(pages))
        self._validate_persisted(pending)
        return pending

    def _prepare_pending(self) -> _Pending | None:
        connection = self._facts.connection
        now = utc_now_iso()
        connection.execute(
            """
            INSERT OR IGNORE INTO memory_projection_cursor
                (gateway_origin, principal_id, device_id, published_version,
                 published_digest, published_manifest, updated_at)
            VALUES (?, ?, ?, 0, NULL, NULL, ?)
            """,
            (*self._owner, now),
        )
        cursor = connection.execute(
            """
            SELECT published_version, published_digest FROM memory_projection_cursor
            WHERE gateway_origin = ? AND principal_id = ? AND device_id = ?
            """,
            self._owner,
        ).fetchone()
        if cursor is None:
            raise MemoryProjectionError("the local projection cursor is unavailable")

        projection_facts = self._capture_facts()
        content_digest = _sha256({"facts": projection_facts})
        if cursor[1] == content_digest:
            return None
        version = int(cursor[0]) + 1
        groups = _partition(projection_facts, version)
        page_hashes = [_sha256({"facts": group}) for group in groups]
        manifest_hash = _sha256(
            {
                "schemaVersion": "1.0",
                "projectionVersion": version,
                "pageCount": len(groups),
                "totalFactCount": len(projection_facts),
                "pageHashes": page_hashes,
            }
        )
        pages: tuple[dict[str, Any], ...] = tuple(
            {
                "schemaVersion": "1.0",
                "operation": "page",
                "projectionVersion": version,
                "pageIndex": index,
                "pageCount": len(groups),
                "totalFactCount": len(projection_facts),
                "pageHash": page_hashes[index],
                "manifestHash": manifest_hash,
                "facts": group,
            }
            for index, group in enumerate(groups)
        )
        pending = _Pending(version, content_digest, manifest_hash, len(pages), len(projection_facts), pages)
        self._validate_persisted(pending)

        connection.execute("BEGIN")
        try:
            connection.execute(
                """
                INSERT INTO memory_projection_pending
                    (gateway_origin, principal_id, device_id, projection_version, content_digest,
                     manifest_hash, page_count, total_fact_count, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (*self._owner, version, content_digest, manifest_hash, len(pages), len(projection_facts), now),
            )
            for page in pages:
                connection.execute(
                    """
                    INSERT INTO memory_projection_pending_page
                        (gateway_origin, principal_id, device_id, projection_version,
                         page_index, page_hash, page_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        *self._owner,
                        version,
                        page["pageIndex"],
                        page["pageHash"],
                        _canonical_bytes(page).decode("utf-8"),
                    ),
                )
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        connection.execute("COMMIT")
        return pending

    def _capture_facts(self) -> list[dict[str, Any]]:
        active = sorted(self._facts.active_facts(self._cloud.principal_id), key=lambda fact: fact.fact_id)
        if len(active) > MAX_PROJECTION_FACTS:
            raise MemoryProjectionError("the active fact snapshot exceeds the projection limit")
        return [self._capture_fact(fact) for fact in active]

    def _capture_fact(self, fact: Fact) -> dict[str, Any]:
        if not 1 <= len(fact.source_event_ids) <= MAX_SOURCES_PER_FACT:
            raise MemoryProjectionError("an active fact cannot be represented safely")
        sources = [self._capture_source(source_id, fact) for source_id in fact.source_event_ids]
        captured = {
            "factId": fact.fact_id,
            "text": fact.text,
            "origin": fact.origin.value,
            "sensitivity": fact.sensitivity.value,
            "confidence": fact.confidence,
            "distillerVersion": fact.distiller_version,
            "distilledAt": fact.created_at,
            "contentHash": fact.content_hash,
            "sources": sources,
        }
        try:
            self._validate_persisted_fact(captured)
        except MemoryProjectionError as error:
            raise MemoryProjectionError("an active fact cannot be represented safely") from error
        return captured

    def _capture_source(self, event_id: str, fact: Fact) -> dict[str, Any]:
        if not _ULID.fullmatch(event_id):
            raise MemoryProjectionError("an active fact cites an invalid source event")
        row = self._archive.connection.execute(
            """
            SELECT event_sequence, principal_id, canonical_text
            FROM archive_event WHERE event_id = ?
            """,
            (event_id,),
        ).fetchone()
        if (
            row is None
            or type(row[0]) is not int
            or row[0] < 1
            or str(row[1]) != fact.principal_id
        ):
            raise MemoryProjectionError("an active fact source is unavailable")
        excerpt = _bounded_prefix(str(row[2]), MAX_EXCERPT_BYTES)
        if not excerpt:
            raise MemoryProjectionError("an active fact source has no usable text")
        return {"eventId": event_id, "eventSequence": int(row[0]), "excerpt": excerpt}

    def _validate_persisted(self, pending: _Pending) -> None:
        if (
            not 1 <= pending.version <= 2_147_483_647
            or not _SHA256.fullmatch(pending.content_digest)
            or not _SHA256.fullmatch(pending.manifest_hash)
            or not 1 <= pending.page_count <= MAX_PROJECTION_PAGES
            or not 0 <= pending.fact_count <= MAX_PROJECTION_FACTS
            or len(pending.pages) != pending.page_count
        ):
            raise MemoryProjectionError("the persisted projection is invalid")
        hashes: list[str] = []
        all_facts: list[dict[str, Any]] = []
        fact_ids: set[str] = set()
        facts_seen = 0
        for index, page in enumerate(pending.pages):
            facts = page.get("facts")
            if (
                set(page) != _PAGE_FIELDS
                or page.get("schemaVersion") != "1.0"
                or page.get("operation") != "page"
                or type(page.get("projectionVersion")) is not int
                or page.get("projectionVersion") != pending.version
                or type(page.get("pageIndex")) is not int
                or page.get("pageIndex") != index
                or type(page.get("pageCount")) is not int
                or page.get("pageCount") != pending.page_count
                or type(page.get("totalFactCount")) is not int
                or page.get("totalFactCount") != pending.fact_count
                or page.get("manifestHash") != pending.manifest_hash
                or not isinstance(facts, list)
                or len(facts) > MAX_FACTS_PER_PAGE
                or len(_canonical_bytes(page)) > MAX_REQUEST_BYTES
            ):
                raise MemoryProjectionError("the persisted projection is invalid")
            sequences: set[int] = set()
            for fact in facts:
                self._validate_persisted_fact(fact)
                fact_id = str(fact["factId"])
                if fact_id in fact_ids:
                    raise MemoryProjectionError("the persisted projection contains duplicate facts")
                fact_ids.add(fact_id)
                sequences.update(int(source["eventSequence"]) for source in fact["sources"])
                all_facts.append(fact)
            if len(sequences) > MAX_UNIQUE_SOURCES_PER_PAGE:
                raise MemoryProjectionError("the persisted projection exceeds its source limit")
            page_hash = _sha256({"facts": facts})
            if page.get("pageHash") != page_hash:
                raise MemoryProjectionError("the persisted projection is corrupt")
            hashes.append(page_hash)
            facts_seen += len(facts)
        manifest = {
            "schemaVersion": "1.0",
            "projectionVersion": pending.version,
            "pageCount": pending.page_count,
            "totalFactCount": pending.fact_count,
            "pageHashes": hashes,
        }
        if (
            facts_seen != pending.fact_count
            or (pending.fact_count == 0 and (pending.page_count != 1 or pending.pages[0]["facts"] != []))
            or (pending.fact_count > 0 and any(not page["facts"] for page in pending.pages))
            or _sha256({"facts": all_facts}) != pending.content_digest
            or _sha256(manifest) != pending.manifest_hash
        ):
            raise MemoryProjectionError("the persisted projection is corrupt")

    def _validate_persisted_fact(self, fact: Any) -> None:  # noqa: ANN401 - decoded persisted JSON
        if not isinstance(fact, dict) or set(fact) != _FACT_FIELDS:
            raise MemoryProjectionError("the persisted projection contains an invalid fact")
        sources = fact.get("sources")
        confidence = fact.get("confidence")
        if (
            not isinstance(fact.get("factId"), str)
            or not _FACT_ID.fullmatch(fact["factId"])
            or not _valid_text(fact.get("text"), MAX_FACT_BYTES)
            or not isinstance(fact.get("origin"), str)
            or fact["origin"] not in _ORIGINS
            or not isinstance(fact.get("sensitivity"), str)
            or fact["sensitivity"] not in {"normal", "sensitive"}
            or not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not math.isfinite(confidence)
            or not 0.0 <= confidence <= 1.0
            or not _valid_text(fact.get("distillerVersion"), MAX_VERSION_BYTES)
            or not _valid_timestamp(fact.get("distilledAt"))
            or not isinstance(fact.get("contentHash"), str)
            or not _SHA256.fullmatch(fact["contentHash"])
            or not isinstance(sources, list)
            or not 1 <= len(sources) <= MAX_SOURCES_PER_FACT
        ):
            raise MemoryProjectionError("the persisted projection contains an invalid fact")
        event_ids: set[str] = set()
        sequences: set[int] = set()
        for source in sources:
            if (
                not isinstance(source, dict)
                or set(source) != _SOURCE_FIELDS
                or not isinstance(source.get("eventId"), str)
                or not _ULID.fullmatch(source["eventId"])
                or type(source.get("eventSequence")) is not int
                or int(source["eventSequence"]) < 1
                or not _valid_text(source.get("excerpt"), MAX_EXCERPT_BYTES)
            ):
                raise MemoryProjectionError("the persisted projection contains an invalid source")
            event_ids.add(source["eventId"])
            sequences.add(source["eventSequence"])
        if len(event_ids) != len(sources) or len(sequences) != len(sources):
            raise MemoryProjectionError("the persisted projection contains duplicate sources")
        content_hash = fact_content_hash(self._cloud.principal_id, fact["text"], tuple(event_ids))
        if fact["contentHash"] != content_hash or fact["factId"] != f"fact_{content_hash[:32]}":
            raise MemoryProjectionError("the persisted projection contains an invalid fact identity")

    @staticmethod
    def _validate_receipt(
        receipt: dict[str, Any], pending: _Pending, *, page: dict[str, Any] | None
    ) -> None:
        expected_published = page is None
        if set(receipt) != {
            "schemaVersion", "projectionVersion", "manifestHash", "pageIndex",
            "pageHash", "published", "replayed",
        } or not isinstance(receipt.get("replayed"), bool) or not isinstance(receipt.get("published"), bool):
            raise MemoryProjectionError("the gateway returned an invalid projection receipt")
        expected_index = None if page is None else page["pageIndex"]
        expected_hash = None if page is None else page["pageHash"]
        if (
            receipt.get("schemaVersion") != "1.0"
            or type(receipt.get("projectionVersion")) is not int
            or receipt.get("projectionVersion") != pending.version
            or receipt.get("manifestHash") != pending.manifest_hash
            or (page is not None and type(receipt.get("pageIndex")) is not int)
            or receipt.get("pageIndex") != expected_index
            or receipt.get("pageHash") != expected_hash
            or receipt.get("published") is not expected_published
        ):
            raise MemoryProjectionError("the gateway returned an invalid projection receipt")

    def _record_published(self, pending: _Pending) -> None:
        connection = self._facts.connection
        connection.execute("BEGIN")
        try:
            changed = connection.execute(
                """
                UPDATE memory_projection_cursor
                SET published_version = ?, published_digest = ?, published_manifest = ?, updated_at = ?
                WHERE gateway_origin = ? AND principal_id = ? AND device_id = ?
                  AND published_version = ?
                """,
                (
                    pending.version,
                    pending.content_digest,
                    pending.manifest_hash,
                    utc_now_iso(),
                    *self._owner,
                    pending.version - 1,
                ),
            )
            if changed.rowcount != 1:
                raise MemoryProjectionError("the local projection cursor changed unexpectedly")
            deleted = connection.execute(
                """
                DELETE FROM memory_projection_pending
                WHERE gateway_origin = ? AND principal_id = ? AND device_id = ?
                  AND projection_version = ? AND manifest_hash = ?
                """,
                (*self._owner, pending.version, pending.manifest_hash),
            )
            if deleted.rowcount != 1:
                raise MemoryProjectionError("the pending projection changed unexpectedly")
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        connection.execute("COMMIT")


def _partition(facts: Sequence[dict[str, Any]], version: int) -> list[list[dict[str, Any]]]:
    if not facts:
        return [[]]
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    sources: set[int] = set()
    for fact in facts:
        sequences = {int(source["eventSequence"]) for source in fact["sources"]}
        candidate = [*current, fact]
        if current and (
            len(candidate) > MAX_FACTS_PER_PAGE
            or len(sources | sequences) > MAX_UNIQUE_SOURCES_PER_PAGE
            or _worst_page_size(candidate, version, len(facts)) > MAX_REQUEST_BYTES
        ):
            groups.append(current)
            current = [fact]
            sources = set(sequences)
        else:
            current = candidate
            sources |= sequences
        if _worst_page_size(current, version, len(facts)) > MAX_REQUEST_BYTES:
            raise MemoryProjectionError("an active fact exceeds the projection page limit")
    groups.append(current)
    if len(groups) > MAX_PROJECTION_PAGES:
        raise MemoryProjectionError("the active fact snapshot exceeds the projection page limit")
    return groups


def _worst_page_size(facts: Sequence[dict[str, Any]], version: int, total: int) -> int:
    return len(
        _canonical_bytes(
            {
                "schemaVersion": "1.0",
                "operation": "page",
                "projectionVersion": version,
                "pageIndex": 31,
                "pageCount": 32,
                "totalFactCount": total,
                "pageHash": _sha256({"facts": facts}),
                "manifestHash": "0" * 64,
                "facts": facts,
            }
        )
    )


def _bounded_prefix(value: str, maximum_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum_bytes:
        return value
    return encoded[:maximum_bytes].decode("utf-8", errors="ignore")


def _valid_text(value: Any, maximum_bytes: int) -> bool:  # noqa: ANN401 - decoded JSON
    if not isinstance(value, str) or not value or normalize_nfc(value) != value:
        return False
    try:
        return len(value.encode("utf-8")) <= maximum_bytes
    except UnicodeError:
        return False


def _valid_timestamp(value: Any) -> bool:  # noqa: ANN401 - decoded JSON
    if not isinstance(value, str) or not _UTC_MILLISECONDS.fullmatch(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return False
    return True


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant: {value}")


def _canonical_bytes(value: Any) -> bytes:  # noqa: ANN401 - RFC 8785 input
    try:
        return rfc8785.dumps(value)
    except (TypeError, ValueError, UnicodeError) as error:
        raise MemoryProjectionError("the projection contains non-canonical data") from error


def _sha256(value: Any) -> str:  # noqa: ANN401 - RFC 8785 input
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()
