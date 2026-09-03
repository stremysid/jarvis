"""Publishing a note into the vault, without ever replacing one.

This module exists because of a single rule, and the rule is the reason the
whole adapter is allowed near the owner's vault at all: **it never replaces,
renames, moves or deletes an existing file.** A vault is years of someone's
own writing. An adapter that can overwrite is one bug away from destroying
work that has no other copy, and no amount of care in the caller substitutes
for the write itself being incapable of it.

So the write is `os.open` with `O_CREAT | O_EXCL` (plus `O_BINARY` on
Windows), never `open(path, "w")`. `O_EXCL` makes "create this file" fail if
anything is already there, atomically, in the kernel -- a check-then-write
would leave a window in which Obsidian creates the file between the check and
the write, and the write would silently win. A collision is resolved by
choosing a different name. There is no branch in this module that overwrites,
and there is no `os.replace`, `shutil.move`, or `unlink` anywhere in it.

The journal
-----------
The operation row is durable *before* the file is created. A crash in between
therefore leaves an operation with no receipt, which `recover` can see. The
other ordering -- file first -- leaves a file that nothing in the database
knows about, and the next run publishes a second copy of it.

What stage one cannot do
------------------------
The plan holds no-delete-sharing namespace fences on the root, the destination
directory and the target from validation through durable receipt commit, so no
other process can substitute a directory underneath a publication in progress.
There are no fences here. Concretely:

* Between validating that the destination is inside the root and calling
  `os.open`, the destination directory could be replaced by a junction
  pointing elsewhere, and the file would be created there. `O_EXCL` still
  guarantees nothing was *overwritten*; it does not guarantee the file landed
  where it was meant to.
* `recover` identifies its file by content hash, because without a retained
  handle there is no object identity to match. A pre-existing file with
  byte-identical content would be adopted as this operation's output. In
  practice the content includes a unique operation id, which makes the
  collision vanishingly unlikely -- but "unlikely" is not the plan's word.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path, PurePath

from jarvis_local.archive.content_store import canonical_content_hash, normalize_nfc
from jarvis_local.clock import utc_now_iso
from jarvis_local.vault import paths
from jarvis_local.vault.identifiers import new_ulid
from jarvis_local.vault.repository import (
    ProjectionOperation,
    ProjectionReceipt,
    VaultBinding,
    VaultRepository,
)

MARKDOWN_SUFFIX = ".md"

#: How many alternative names a collision may consume before giving up. Bounded
#: so a directory full of collisions fails loudly instead of spinning.
MAX_NAME_ATTEMPTS = 100

ABANDONED = "vault_projection_abandoned"


class VaultProjectionError(RuntimeError):
    """A projection cannot proceed. Nothing has been written when this raises."""


@dataclass(frozen=True, slots=True)
class ProjectionRequest:
    """What to publish. `base_name` carries no extension and no directory."""

    base_name: str
    content: str
    directory_parts: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PublishedProjection:
    operation_id: str
    receipt_id: str
    requested_name: str
    final_name: str
    content_hash: str
    disposition: str

    @property
    def collided(self) -> bool:
        """Whether a name was already taken and a different one was chosen."""
        return self.final_name != self.requested_name


@dataclass(frozen=True, slots=True)
class RecoveredProjection:
    operation_id: str
    disposition: str
    final_name: str | None = None


class VaultProjector:
    """Creates new Markdown files in the vault. Only ever new ones."""

    def __init__(self, repository: VaultRepository, binding: VaultBinding, *, now: str | None = None) -> None:
        self._repository = repository
        self._binding = binding
        self._now = now

    def project(self, request: ProjectionRequest) -> PublishedProjection:
        moment = self._now or utc_now_iso()
        directory_parts = tuple(paths.validate_component(part) for part in request.directory_parts)
        base_name = paths.validate_component(request.base_name)

        canonical = normalize_nfc(request.content)
        payload = canonical.encode("utf-8")
        content_hash = canonical_content_hash(canonical)

        destination = self._destination(directory_parts)
        operation = self._repository.prepare_projection(
            ProjectionOperation(
                operation_id=new_ulid(),
                vault_id=self._binding.vault_id,
                intended_directory="/".join(directory_parts),
                intended_name=f"{base_name}{MARKDOWN_SUFFIX}",
                content_hash=content_hash,
                content_bytes=len(payload),
                prepared_at=moment,
            )
        )

        final_name = self._create_new(destination, base_name, payload)
        receipt = self._repository.record_projection_receipt(
            ProjectionReceipt(
                receipt_id=new_ulid(),
                operation_id=operation.operation_id,
                final_name=final_name,
                content_hash=content_hash,
                disposition="published",
                committed_at=moment,
            )
        )
        return PublishedProjection(
            operation_id=operation.operation_id,
            receipt_id=receipt.receipt_id,
            requested_name=operation.intended_name,
            final_name=final_name,
            content_hash=content_hash,
            disposition=receipt.disposition,
        )

    def recover(self) -> tuple[RecoveredProjection, ...]:
        """Resolve every operation that has no receipt and no abandonment.

        Recognising, not repeating. An operation whose file is found is closed
        with a receipt; one whose file is absent is recorded as abandoned and
        never retried, because republishing risks a second copy of something
        the owner may already have and may already have edited.
        """
        moment = self._now or utc_now_iso()
        resolved: list[RecoveredProjection] = []
        for operation in self._repository.unfinished_projections(self._binding.vault_id):
            found = self._find_published_file(operation)
            if found is None:
                self._repository.record_projection_abandonment(operation.operation_id, ABANDONED, now=moment)
                resolved.append(RecoveredProjection(operation.operation_id, ABANDONED))
                continue
            self._repository.record_projection_receipt(
                ProjectionReceipt(
                    receipt_id=new_ulid(),
                    operation_id=operation.operation_id,
                    final_name=found,
                    content_hash=operation.content_hash,
                    disposition="recovered",
                    committed_at=moment,
                )
            )
            resolved.append(RecoveredProjection(operation.operation_id, "recovered", found))
        return tuple(resolved)

    def _destination(self, directory_parts: tuple[str, ...]) -> Path:
        root = self._binding.root
        destination = root.joinpath(*directory_parts)
        # Re-checked after joining rather than trusted from the component
        # validation above: the components are individually safe, and this
        # asserts that what they compose to is still inside the root.
        if not paths.is_within(root, destination):
            raise VaultProjectionError("projection destination is outside the vault root")
        # The root is checked before the directory is created, so a junction
        # already sitting above the vault cannot be walked through on the way
        # to creating one. The destination is checked again afterwards, which
        # catches a junction that was already the destination.
        if paths.any_reparse_point(root):
            raise VaultProjectionError("the vault root passes through a reparse point")
        destination.mkdir(parents=True, exist_ok=True)
        if paths.any_reparse_point(destination):
            raise VaultProjectionError("projection destination passes through a reparse point")
        return destination

    def _candidate_names(self, base_name: str) -> list[str]:
        names = [f"{base_name}{MARKDOWN_SUFFIX}"]
        names.extend(f"{base_name} ({attempt}){MARKDOWN_SUFFIX}" for attempt in range(2, MAX_NAME_ATTEMPTS + 1))
        return names

    def _create_new(self, destination: Path, base_name: str, payload: bytes) -> str:
        """Create one new file, trying another name for every collision.

        `O_EXCL` is the whole mechanism. It is not an optimisation over a
        `path.exists()` check: the check has a window in which the editor can
        create the file, and this does not.
        """
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0)
        for name in self._candidate_names(base_name):
            target = destination / paths.validate_component(name)
            try:
                descriptor = os.open(target, flags, 0o600)
            except FileExistsError:
                continue
            except OSError as error:
                raise VaultProjectionError("could not create the projection file") from error
            try:
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
            except OSError as error:
                # The file exists and is possibly short. It is left alone
                # rather than deleted: this module does not delete, and the
                # journal already records that the operation did not complete.
                raise VaultProjectionError("could not write the projection file") from error
            return name
        raise VaultProjectionError("every candidate projection name is taken")

    def _find_published_file(self, operation: ProjectionOperation) -> str | None:
        """Look for the file this operation may have created, by content.

        Content hashing is the only identity available without a retained
        handle. It is checked against the *canonical* hash of the decoded text,
        so a file the owner has since edited will not match and the operation
        is recorded as abandoned rather than claimed.
        """
        parts = tuple(part for part in PurePath(operation.intended_directory).parts if part not in (".", ""))
        destination = self._binding.root.joinpath(*parts)
        if not destination.is_dir():
            return None
        base_name = operation.intended_name[: -len(MARKDOWN_SUFFIX)]
        for name in self._candidate_names(base_name):
            candidate = destination / name
            if not candidate.is_file():
                continue
            try:
                text = candidate.read_bytes().decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if canonical_content_hash(normalize_nfc(text)) == operation.content_hash:
                return name
        return None
