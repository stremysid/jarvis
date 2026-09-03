"""Turning what changed in the vault into observations.

Four properties carry this module, and each exists because its absence is a
specific failure rather than a missing nicety.

**Content-hash dedup.** A daily crawl re-reads every note. Without comparing
the hash to the current head, each crawl appends an identical copy of every
file, and an archive designed to keep everything forever fills with duplicates
that make the real edits impossible to find. Nothing here uses timestamps to
decide whether a file changed: a touched file with identical bytes is not a
new version, and a file restored from backup with an older timestamp is.

**NFC before hashing.** "café" written with a combining accent and "café"
written precomposed are the same note. Hashing the bytes as they arrive makes
every Unicode-normalisation difference look like a permanent, unfixable edit:
the file's hash never matches the head, so every crawl appends another
version, forever.

**Tombstones, never deletions.** A note that disappears becomes an observation
saying it disappeared. Removing the row instead would make the archive unable
to answer "what did this say before it was deleted", which is the question the
archive exists for.

**Torn reads are skipped, not recorded.** Obsidian writes while Jarvis reads.
Recording a half-written file as a new version is worse than recording
nothing: it becomes the head, so the next crawl sees the complete file as a
change and the archive keeps a version the owner never had. Stage one detects
this by bracketing the read with two stats and comparing size, modification
time and file index. That is genuinely weaker than the plan: with the native
bridge the file would be opened without FILE_SHARE_DELETE and the read
validated against the USN journal, so a concurrent writer could not slip
through. Here, a writer that completes entirely between the two stats and
leaves size and mtime unchanged is undetectable.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path, PurePath
from typing import Literal

from jarvis_local.archive.content_store import canonical_content_hash, normalize_nfc
from jarvis_local.clock import utc_now_iso
from jarvis_local.vault import paths
from jarvis_local.vault.identifiers import derive_ulid, new_ulid
from jarvis_local.vault.models import (
    SensitivityV1,
    VaultNoteOperationV1,
    observed,
    safe_display_label,
    tombstoned,
)
from jarvis_local.vault.repository import VaultBinding, VaultDocumentHead, VaultRepository

#: The plan's caps. A note larger than this is not a note; a slice larger than
#: this is a crawl that holds a transaction open long enough to matter.
MAX_FILE_BYTES = 1024 * 1024
MAX_SLICE_DOCUMENTS = 64
MAX_SLICE_BYTES = 4 * 1024 * 1024

MARKDOWN_SUFFIX = ".md"

#: Obsidian's own state, and the adapter's. Crawling these would archive the
#: editor's workspace layout as if it were the owner's writing.
IGNORED_DIRECTORY_NAMES: frozenset[str] = frozenset({".obsidian", ".trash", ".git", ".jarvis"})

DOCUMENT_NAMESPACE = "jarvis.vault.document"


@dataclass(frozen=True, slots=True)
class StableRead:
    """Bytes that were not observed changing while they were being read."""

    data: bytes
    size: int


@dataclass(frozen=True, slots=True)
class ReconciliationResult:
    status: Literal["completed", "incomplete"]
    documents_examined: int = 0
    observations_appended: int = 0
    unchanged: int = 0
    tombstoned: int = 0
    skipped_too_large: int = 0
    unstable: int = 0
    undecodable: int = 0

    @property
    def complete(self) -> bool:
        return self.status == "completed"


class LocalFileReader:
    """Reads a file and refuses to hand back bytes it saw change.

    The two stats bracket the read. `st_ino` is included because on Windows it
    carries the NTFS file index: a file replaced by a rename between the stats
    keeps its size and can keep its timestamp, but not its index.
    """

    def read_stable(self, path: Path, *, max_bytes: int) -> StableRead | None:
        try:
            before = os.stat(path)
        except OSError:
            return None
        data = self._read_bytes(path, max_bytes)
        if data is None:
            return None
        try:
            after = os.stat(path)
        except OSError:
            return None
        if _identity(before) != _identity(after):
            return None
        if len(data) != before.st_size:
            return None
        return StableRead(data=data, size=before.st_size)

    def _read_bytes(self, path: Path, max_bytes: int) -> bytes | None:
        """Read at most `max_bytes + 1` so an oversized file is detectable.

        A seam as well as a read: it is the narrowest place a test can stand in
        for a writer that modifies the file inside the read window.
        """
        try:
            with open(path, "rb") as handle:
                data = handle.read(max_bytes + 1)
        except OSError:
            return None
        if len(data) > max_bytes:
            return None
        return data


def _identity(status: os.stat_result) -> tuple[int, int, int]:
    return (status.st_size, status.st_mtime_ns, status.st_ino)


def document_id_for(vault_id: str, relative_path: PurePath) -> str:
    """A note's stable id, derived from where it sits.

    Derived rather than stored so a restart recognises yesterday's note with
    no lookup table that could disagree. The cost is explicit and accepted: a
    renamed file is a different document, which the reconciler records as a
    tombstone for the old location plus a first observation at the new one. It
    never guesses that two paths are the same note, because guessing wrong
    merges two people's notes into one history.
    """
    return derive_ulid(DOCUMENT_NAMESPACE, vault_id, paths.normalize_case(str(relative_path)))


def title_of(text: str, relative_path: PurePath) -> str:
    """The note's first ATX heading, else its filename stem.

    The stem is a path component, so it goes through `safe_display_label`,
    which strips anything separator-shaped. The label is the only
    human-readable field in an observation, and therefore the only place a
    directory name could ride along to somewhere it must not go.
    """
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip()
            if heading:
                return safe_display_label(heading)
        if stripped:
            break
    return safe_display_label(relative_path.stem)


class VaultReconciler:
    """Walks the vault and records what differs from the recorded heads."""

    def __init__(
        self,
        repository: VaultRepository,
        binding: VaultBinding,
        *,
        reader: LocalFileReader | None = None,
        sensitivity: SensitivityV1 | None = None,
        max_documents: int = MAX_SLICE_DOCUMENTS,
        max_slice_bytes: int = MAX_SLICE_BYTES,
        max_file_bytes: int = MAX_FILE_BYTES,
    ) -> None:
        self._repository = repository
        self._binding = binding
        self._reader = reader or LocalFileReader()
        #: Nothing in a vault arrives classified, so the fail-closed value is
        #: what everything gets. `None` means "no opinion", which the models
        #: turn into `restricted`.
        self._sensitivity = sensitivity
        self._max_documents = max_documents
        self._max_slice_bytes = max_slice_bytes
        self._max_file_bytes = max_file_bytes

    def run(self, *, now: str | None = None) -> ReconciliationResult:
        moment = now or utc_now_iso()
        result = ReconciliationResult(status="completed")
        seen: set[str] = set()
        consumed_bytes = 0

        for relative in self._markdown_files():
            if result.documents_examined >= self._max_documents or consumed_bytes >= self._max_slice_bytes:
                result = replace(result, status="incomplete")
                break

            absolute = self._binding.root / relative
            result = replace(result, documents_examined=result.documents_examined + 1)

            # Marked seen the moment the walk finds the file, before anything
            # can go wrong reading it. A note that is present but unreadable --
            # too large, mid-write, not UTF-8 -- must not be mistaken for a
            # note that is gone: "I could not read it" and "it is not there"
            # are different facts, and only the second is a tombstone.
            document_id = document_id_for(self._binding.vault_id, relative)
            seen.add(document_id)

            try:
                size = absolute.stat().st_size
            except OSError:
                # It vanished between the walk and the stat. Left for the next
                # crawl, which will not list it at all and will tombstone it
                # then; deciding now would race with the deletion.
                continue
            if size > self._max_file_bytes:
                result = replace(result, skipped_too_large=result.skipped_too_large + 1)
                continue

            stable = self._reader.read_stable(absolute, max_bytes=self._max_file_bytes)
            if stable is None:
                result = replace(result, unstable=result.unstable + 1)
                continue
            consumed_bytes += stable.size

            try:
                decoded = stable.data.decode("utf-8")
            except UnicodeDecodeError:
                # Not Markdown this parser accepts. Skipped rather than stored
                # with replacement characters, which would archive a corrupted
                # copy of a file that is fine.
                result = replace(result, undecodable=result.undecodable + 1)
                continue

            if self._record(document_id, relative, decoded, moment):
                result = replace(result, observations_appended=result.observations_appended + 1)
            else:
                result = replace(result, unchanged=result.unchanged + 1)

        if result.complete:
            tombstones = self._tombstone_absent(seen, moment)
            result = replace(
                result,
                tombstoned=tombstones,
                observations_appended=result.observations_appended + tombstones,
            )
        return result

    def _markdown_files(self) -> Iterator[PurePath]:
        """Every `.md` file under the root, in a deterministic order.

        Directory symlinks and junctions are not followed and reparse points
        are skipped outright: following one would walk out of the root, and
        confinement here is a path comparison rather than a handle.
        """
        root = self._binding.root
        if not root.is_dir():
            return
        for directory, subdirectories, filenames in os.walk(root, followlinks=False):
            subdirectories[:] = sorted(
                name
                for name in subdirectories
                if name.casefold() not in IGNORED_DIRECTORY_NAMES
                and not paths.is_reparse_point(Path(directory) / name)
            )
            for filename in sorted(filenames):
                if not filename.casefold().endswith(MARKDOWN_SUFFIX):
                    continue
                absolute = Path(directory) / filename
                if paths.is_reparse_point(absolute):
                    continue
                if not paths.is_within(root, absolute):
                    # Belt and braces: os.walk with followlinks=False should
                    # not produce one, but a check that only runs when the walk
                    # is already correct protects nothing.
                    continue
                yield PurePath(os.path.relpath(absolute, root))

    def _record(self, document_id: str, relative: PurePath, decoded: str, moment: str) -> bool:
        """Append an observation if the content differs from the head.

        Returns whether anything was appended. This is the dedup: the hash is
        computed over NFC-normalised text, so a file rewritten in a different
        normal form produces the same hash and no observation.
        """
        canonical = normalize_nfc(decoded)
        content_hash = canonical_content_hash(canonical)
        head = self._repository.current_head(document_id)
        if head is not None and head.operation is VaultNoteOperationV1.OBSERVED and head.content_hash == content_hash:
            return False

        label = title_of(canonical, relative)
        self._repository.upsert_document(
            vault_id=self._binding.vault_id,
            document_id=document_id,
            relative_path=str(relative),
            display_label=label,
            now=moment,
        )
        self._repository.append_observation(
            observed(
                observation_id=new_ulid(),
                vault_id=self._binding.vault_id,
                document_id=document_id,
                document_version=_next_version(head),
                text=canonical,
                observed_at=moment,
                display_label=label,
                sensitivity=self._sensitivity,
                previous_observation_id=None if head is None else head.observation_id,
                previous_content_hash=None if head is None else head.content_hash,
            ),
            now=moment,
        )
        return True

    def _tombstone_absent(self, seen: set[str], moment: str) -> int:
        """Record the disappearance of every note the walk did not find.

        Only reachable from a completed walk. Running this after a walk that
        stopped at a slice boundary would tombstone every note the crawl had
        not reached yet -- the archive would record the vault emptying itself
        once per crawl.
        """
        appended = 0
        for head in self._repository.current_heads(self._binding.vault_id):
            if head.document_id in seen or head.operation is VaultNoteOperationV1.TOMBSTONED:
                continue
            document = self._repository.document(head.document_id)
            self._repository.append_observation(
                tombstoned(
                    observation_id=new_ulid(),
                    vault_id=self._binding.vault_id,
                    document_id=head.document_id,
                    document_version=head.document_version + 1,
                    observed_at=moment,
                    display_label="" if document is None else document.display_label,
                    sensitivity=self._sensitivity,
                    previous_observation_id=head.observation_id,
                    previous_content_hash=head.content_hash,
                ),
                now=moment,
            )
            appended += 1
        return appended


def _next_version(head: VaultDocumentHead | None) -> int:
    return 1 if head is None else head.document_version + 1
