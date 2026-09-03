"""The observation record refuses to be built in a shape that cannot be trusted."""

from __future__ import annotations

import pytest

from jarvis_local.archive.content_store import canonical_content_hash
from jarvis_local.vault.identifiers import derive_ulid, is_ulid, new_ulid
from jarvis_local.vault.models import (
    CONTRACT_FIELD_NAMES,
    FAIL_CLOSED_SENSITIVITY,
    InvalidObservationError,
    SensitivityV1,
    UnknownSensitivityError,
    VaultNoteOperationV1,
    VaultNoteOriginV1,
    observed,
    parse_sensitivity,
    path_shaped_payload_fields,
    safe_display_label,
    sensitivity_or_fail_closed,
    tombstoned,
)

OBSERVATION = "01k5d8s0m00000000000000009"
VAULT = "01k5d8s0m00000000000000001"
DOCUMENT = "01k5d8s0m00000000000000002"
WHEN = "2026-09-03T00:00:00.000Z"


def an_observation(**overrides: object) -> object:
    fields: dict[str, object] = {
        "observation_id": OBSERVATION,
        "vault_id": VAULT,
        "document_id": DOCUMENT,
        "document_version": 1,
        "text": "I like coffee",
        "observed_at": WHEN,
        "display_label": "Coffee",
    }
    fields.update(overrides)
    return observed(**fields)  # type: ignore[arg-type]


def test_the_payload_key_list_is_exactly_the_plans_field_list() -> None:
    """Asserted by equality, in order.

    Membership would pass while a field was missing, and a missing field is
    the only kind of contract drift nobody notices until an upload is parsed
    on the other side.
    """
    payload = observed(
        observation_id=OBSERVATION,
        vault_id=VAULT,
        document_id=DOCUMENT,
        document_version=1,
        text="x",
        observed_at=WHEN,
        display_label="X",
    ).canonical_payload()

    assert tuple(payload) == CONTRACT_FIELD_NAMES


def test_no_payload_field_carries_a_filesystem_path() -> None:
    payload = observed(
        observation_id=OBSERVATION,
        vault_id=VAULT,
        document_id=DOCUMENT,
        document_version=1,
        text="see C:\\javis\\Jarvis\\note.md for details",
        observed_at=WHEN,
        display_label="notes/inner/Secret Plan",
    ).canonical_payload()

    assert path_shaped_payload_fields(payload) == ()
    assert payload["displayLabel"] == "notes inner Secret Plan"


@pytest.mark.parametrize("absent_or_unknown", [None, "", "public", "internal", "PERSONAL", 7, object()])
def test_an_absent_or_unknown_sensitivity_is_refused(absent_or_unknown: object) -> None:
    with pytest.raises(UnknownSensitivityError):
        parse_sensitivity(absent_or_unknown)


@pytest.mark.parametrize("absent_or_unknown", [None, "", "public", 7])
def test_an_absent_or_unknown_sensitivity_fails_closed_to_restricted(absent_or_unknown: object) -> None:
    assert sensitivity_or_fail_closed(absent_or_unknown) is SensitivityV1.RESTRICTED
    assert FAIL_CLOSED_SENSITIVITY is SensitivityV1.RESTRICTED


def test_the_sensitivity_enum_is_closed_to_two_values() -> None:
    assert {str(value) for value in SensitivityV1} == {"personal", "restricted"}


def test_the_operation_and_origin_enums_match_the_contract() -> None:
    assert {str(value) for value in VaultNoteOperationV1} == {"observed", "tombstoned"}
    assert {str(value) for value in VaultNoteOriginV1} == {
        "user_authored",
        "jarvis_projection",
        "user_edited_projection",
    }


def test_an_unclassified_note_is_recorded_as_restricted() -> None:
    assert an_observation().sensitivity is SensitivityV1.RESTRICTED  # type: ignore[attr-defined]


def test_a_tombstone_carries_no_text() -> None:
    stone = tombstoned(
        observation_id=OBSERVATION,
        vault_id=VAULT,
        document_id=DOCUMENT,
        document_version=2,
        observed_at=WHEN,
        display_label="Coffee",
    )
    assert stone.canonical_text == ""
    assert stone.canonical_content_hash == canonical_content_hash("")


def test_a_hash_that_does_not_cover_the_text_is_refused() -> None:
    from jarvis_local.vault.models import VaultNoteLocalObservationV1

    with pytest.raises(InvalidObservationError, match="canonicalContentHash"):
        VaultNoteLocalObservationV1(
            observation_id=OBSERVATION,
            vault_id=VAULT,
            document_id=DOCUMENT,
            document_version=1,
            operation=VaultNoteOperationV1.OBSERVED,
            canonical_text="I like coffee",
            canonical_content_hash=canonical_content_hash("I like tea"),
            observed_at=WHEN,
            sensitivity=SensitivityV1.RESTRICTED,
            origin=VaultNoteOriginV1.USER_AUTHORED,
            display_label="Coffee",
        )


def test_text_that_is_not_nfc_is_refused_rather_than_silently_normalised() -> None:
    from jarvis_local.vault.models import VaultNoteLocalObservationV1

    decomposed = "cafe\u0301"
    with pytest.raises(InvalidObservationError, match="NFC"):
        VaultNoteLocalObservationV1(
            observation_id=OBSERVATION,
            vault_id=VAULT,
            document_id=DOCUMENT,
            document_version=1,
            operation=VaultNoteOperationV1.OBSERVED,
            canonical_text=decomposed,
            canonical_content_hash=canonical_content_hash(decomposed),
            observed_at=WHEN,
            sensitivity=SensitivityV1.RESTRICTED,
            origin=VaultNoteOriginV1.USER_AUTHORED,
            display_label="Cafe",
        )


def test_a_projection_observation_must_cite_a_receipt() -> None:
    with pytest.raises(InvalidObservationError, match="receipt"):
        an_observation(origin=VaultNoteOriginV1.JARVIS_PROJECTION)


@pytest.mark.parametrize("bad_id", ["not-a-ulid", "", "8k5d8s0m00000000000000001", "01K5D8S0M00000000000000001"])
def test_an_identifier_that_is_not_a_lowercase_ulid_is_refused(bad_id: str) -> None:
    with pytest.raises(InvalidObservationError):
        an_observation(observation_id=bad_id)


def test_a_version_below_one_is_refused() -> None:
    with pytest.raises(InvalidObservationError, match="documentVersion"):
        an_observation(document_version=0)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("notes/inner/Plan", "notes inner Plan"),
        (r"C:\javis\Jarvis\note", "C javis Jarvis note"),
        ("../escape", "escape"),
        ("  spaced   out  ", "spaced out"),
    ],
)
def test_a_display_label_can_never_be_path_shaped(raw: str, expected: str) -> None:
    assert safe_display_label(raw) == expected


def test_a_derived_identifier_is_stable_and_a_fresh_one_is_not() -> None:
    assert derive_ulid("ns", "a", "b") == derive_ulid("ns", "a", "b")
    assert derive_ulid("ns", "a", "b") != derive_ulid("ns", "a", "c")
    assert is_ulid(derive_ulid("ns", "a", "b"))
    assert new_ulid() != new_ulid()
    assert is_ulid(new_ulid())


def test_a_derived_identifier_cannot_be_confused_with_the_parts_it_came_from() -> None:
    """Joining is unambiguous, so two different splits cannot collide.

    Without a separator, `("ab", "c")` and `("a", "bc")` would hash the same
    and two different notes would share one document id.
    """
    assert derive_ulid("ns", "ab", "c") != derive_ulid("ns", "a", "bc")
