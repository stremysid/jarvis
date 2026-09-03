"""Local vault records, shaped like the contracts they will one day become.

Nothing here crosses a network in stage one, and that is exactly why the field
names are the cloud contract's field names. A local record with a convenient
local shape has to be translated at the boundary, and a translation is a place
where `previousContentHash` quietly becomes the hash of the wrong thing --
visible only once uploads exist, by which time the archive is full of records
built the wrong way. `canonical_payload` produces the plan's exact key list,
and a test pins that list by equality so a renamed field fails here rather
than at the boundary.

Two rules are enforced by construction rather than by the caller remembering.
A sensitivity that is absent or unrecognised fails closed: it is refused, and
where a value must be produced anyway the answer is `restricted`. And a
display label may never be path-shaped -- the label is the one human-readable
string that would travel, so a filename with its directories still attached is
how a raw path leaves the machine.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from jarvis_local.archive.content_store import canonical_content_hash, normalize_nfc
from jarvis_local.vault.identifiers import is_ulid

SCHEMA_VERSION = "1.0"

_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")

MAX_DISPLAY_LABEL_CHARS = 120

#: The observation's key list, in the plan's order. Pinned by equality in the
#: tests: a field added here without being added there is a field the eventual
#: cloud parser has never seen.
CONTRACT_FIELD_NAMES: tuple[str, ...] = (
    "schemaVersion",
    "observationId",
    "vaultId",
    "documentId",
    "documentVersion",
    "operation",
    "previousObservationId",
    "previousContentHash",
    "derivedFromObservationId",
    "canonicalText",
    "canonicalContentHash",
    "observedAt",
    "sensitivity",
    "redaction",
    "origin",
    "projectionOperationId",
    "projectionReceiptId",
    "displayLabel",
)


class UnknownSensitivityError(ValueError):
    """A sensitivity value nobody chose. Refused rather than guessed at."""


class InvalidObservationError(ValueError):
    """A local observation that must not be stored in the shape it arrived in."""


class SensitivityV1(StrEnum):
    """Closed to two values. There is no `public` and there is no default."""

    PERSONAL = "personal"
    RESTRICTED = "restricted"


#: What an unclassified thing is treated as. The more protective of the two,
#: which is the whole meaning of failing closed.
FAIL_CLOSED_SENSITIVITY = SensitivityV1.RESTRICTED


class VaultNoteOperationV1(StrEnum):
    OBSERVED = "observed"
    TOMBSTONED = "tombstoned"


class VaultNoteOriginV1(StrEnum):
    USER_AUTHORED = "user_authored"
    JARVIS_PROJECTION = "jarvis_projection"
    USER_EDITED_PROJECTION = "user_edited_projection"


class RedactionStatusV1(StrEnum):
    NONE = "none"
    REDACTED = "redacted"


def parse_sensitivity(value: object) -> SensitivityV1:
    """Turn a stored or supplied value into a sensitivity, or refuse.

    Absent and unrecognised are the same answer here: refusal. Coercing an
    unknown string to a default would make a value that arrived from a future
    version, or from a typo, indistinguishable from one the owner chose.
    """
    if isinstance(value, SensitivityV1):
        return value
    if not isinstance(value, str):
        raise UnknownSensitivityError("sensitivity is absent")
    try:
        return SensitivityV1(value)
    except ValueError as error:
        raise UnknownSensitivityError("sensitivity is not a recognised value") from error


def sensitivity_or_fail_closed(value: object) -> SensitivityV1:
    """The supplied sensitivity, or `restricted` when there is not one.

    For the callers that must produce a record regardless -- a crawl cannot
    stop because a note carries no classification. It answers with the value
    that lets the note do the least, never with the one that lets it do more.
    """
    try:
        return parse_sensitivity(value)
    except UnknownSensitivityError:
        return FAIL_CLOSED_SENSITIVITY


def safe_display_label(raw: str) -> str:
    """A label that cannot be a path.

    Separators, drive colons and traversals are removed rather than rejected,
    because the input is a note title the owner wrote and refusing it would
    make their note unsearchable. What must not survive is the *shape* of a
    path: this is the only human-readable string in the record, so it is the
    only place a directory name could ride along.
    """
    collapsed = normalize_nfc(raw).replace("\\", " ").replace("/", " ").replace(":", " ")
    collapsed = collapsed.replace("..", " ").replace("\x00", " ")
    collapsed = " ".join(collapsed.split())
    return collapsed[:MAX_DISPLAY_LABEL_CHARS]


def assert_not_path_shaped(label: str) -> None:
    if any(marker in label for marker in ("\\", "/", ":", "..")):
        raise InvalidObservationError("display label is path-shaped")


@dataclass(frozen=True, slots=True)
class RedactionV1:
    status: RedactionStatusV1 = RedactionStatusV1.NONE
    markers: tuple[str, ...] = ()

    def payload(self) -> dict[str, Any]:
        return {"status": str(self.status), "markers": list(self.markers)}


@dataclass(frozen=True, slots=True)
class VaultNoteLocalObservationV1:
    """One immutable sighting of one note at one version.

    A tombstone carries no text: absence is the fact being recorded, and text
    on a tombstone would be a copy of the note surviving the note's removal.
    """

    observation_id: str
    vault_id: str
    document_id: str
    document_version: int
    operation: VaultNoteOperationV1
    canonical_text: str
    canonical_content_hash: str
    observed_at: str
    sensitivity: SensitivityV1
    origin: VaultNoteOriginV1
    display_label: str
    previous_observation_id: str | None = None
    previous_content_hash: str | None = None
    derived_from_observation_id: str | None = None
    redaction: RedactionV1 = field(default_factory=RedactionV1)
    projection_operation_id: str | None = None
    projection_receipt_id: str | None = None
    schema_version: str = SCHEMA_VERSION

    def __post_init__(self) -> None:
        for name, value in (
            ("observationId", self.observation_id),
            ("vaultId", self.vault_id),
            ("documentId", self.document_id),
        ):
            if not is_ulid(value):
                raise InvalidObservationError(f"{name} is not a lowercase ULID")
        if self.document_version < 1:
            raise InvalidObservationError("documentVersion starts at 1")
        if self.canonical_text != normalize_nfc(self.canonical_text):
            raise InvalidObservationError("canonicalText is not Unicode NFC")
        if self.canonical_content_hash != canonical_content_hash(self.canonical_text):
            raise InvalidObservationError("canonicalContentHash does not cover canonicalText")
        if self.operation is VaultNoteOperationV1.TOMBSTONED and self.canonical_text:
            raise InvalidObservationError("a tombstone carries no text")
        if self.previous_content_hash is not None and len(self.previous_content_hash) != 64:
            raise InvalidObservationError("previousContentHash is not a SHA-256 digest")
        if self.origin is VaultNoteOriginV1.JARVIS_PROJECTION and not self.projection_receipt_id:
            # Without a receipt there is nothing tying the file to a write we
            # made, so "Jarvis wrote this" would rest on the note's own text.
            raise InvalidObservationError("a projection observation must cite its receipt")
        assert_not_path_shaped(self.display_label)

    def canonical_payload(self) -> dict[str, Any]:
        """The record as the cloud contract will read it.

        Deliberately holds no path, no volume identity, and no local row id.
        Everything in it is either an opaque identifier, a closed enum, a
        hash, or text the owner wrote.
        """
        return {
            "schemaVersion": self.schema_version,
            "observationId": self.observation_id,
            "vaultId": self.vault_id,
            "documentId": self.document_id,
            "documentVersion": self.document_version,
            "operation": str(self.operation),
            "previousObservationId": self.previous_observation_id,
            "previousContentHash": self.previous_content_hash,
            "derivedFromObservationId": self.derived_from_observation_id,
            "canonicalText": self.canonical_text,
            "canonicalContentHash": self.canonical_content_hash,
            "observedAt": self.observed_at,
            "sensitivity": str(self.sensitivity),
            "redaction": self.redaction.payload(),
            "origin": str(self.origin),
            "projectionOperationId": self.projection_operation_id,
            "projectionReceiptId": self.projection_receipt_id,
            "displayLabel": self.display_label,
        }


def observed(
    *,
    observation_id: str,
    vault_id: str,
    document_id: str,
    document_version: int,
    text: str,
    observed_at: str,
    display_label: str,
    sensitivity: object = None,
    origin: VaultNoteOriginV1 = VaultNoteOriginV1.USER_AUTHORED,
    previous_observation_id: str | None = None,
    previous_content_hash: str | None = None,
    projection_operation_id: str | None = None,
    projection_receipt_id: str | None = None,
) -> VaultNoteLocalObservationV1:
    """Build an `observed` record, normalising and hashing its text here.

    The hash is computed rather than accepted so no caller can record content
    under a digest that does not cover it.
    """
    canonical = normalize_nfc(text)
    return VaultNoteLocalObservationV1(
        observation_id=observation_id,
        vault_id=vault_id,
        document_id=document_id,
        document_version=document_version,
        operation=VaultNoteOperationV1.OBSERVED,
        canonical_text=canonical,
        canonical_content_hash=canonical_content_hash(canonical),
        observed_at=observed_at,
        sensitivity=sensitivity_or_fail_closed(sensitivity),
        origin=origin,
        display_label=safe_display_label(display_label),
        previous_observation_id=previous_observation_id,
        previous_content_hash=previous_content_hash,
        projection_operation_id=projection_operation_id,
        projection_receipt_id=projection_receipt_id,
    )


def tombstoned(
    *,
    observation_id: str,
    vault_id: str,
    document_id: str,
    document_version: int,
    observed_at: str,
    display_label: str,
    sensitivity: object = None,
    previous_observation_id: str | None = None,
    previous_content_hash: str | None = None,
) -> VaultNoteLocalObservationV1:
    """Build a tombstone: the note is gone, and that is all this says."""
    return VaultNoteLocalObservationV1(
        observation_id=observation_id,
        vault_id=vault_id,
        document_id=document_id,
        document_version=document_version,
        operation=VaultNoteOperationV1.TOMBSTONED,
        canonical_text="",
        canonical_content_hash=canonical_content_hash(""),
        observed_at=observed_at,
        sensitivity=sensitivity_or_fail_closed(sensitivity),
        origin=VaultNoteOriginV1.USER_AUTHORED,
        display_label=safe_display_label(display_label),
        previous_observation_id=previous_observation_id,
        previous_content_hash=previous_content_hash,
    )


def redaction_from_row(status: str, markers: Sequence[str] | None = None) -> RedactionV1:
    return RedactionV1(RedactionStatusV1(status), tuple(markers or ()))


def path_shaped_payload_fields(payload: Mapping[str, Any]) -> tuple[str, ...]:
    """Names of payload fields whose value is shaped like a filesystem path.

    Deliberately narrow, and it proves nothing about `canonicalText`, which is
    excluded: that field is the note, and a note may legitimately talk about a
    directory. What this catches is a *field* carrying a path -- a label built
    from a relative path, an id replaced by a filename -- which is the mistake
    that gets made once in a renderer and then repeated in every record after
    it.
    """
    offenders: list[str] = []
    for key, value in payload.items():
        if key == "canonicalText" or not isinstance(value, str):
            continue
        if "\\" in value or "://" in value or _WINDOWS_DRIVE.match(value):
            offenders.append(key)
    return tuple(offenders)
