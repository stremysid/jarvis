"""Path comparison that survives Windows.

Containment is the whole of the vault's confinement in stage one: without the
native bridge there is no retained directory handle, so "is this file inside
the root I own" is answered by comparing two strings rather than by comparing
two NTFS object identities. Windows offers several ways to write the same
location -- a different case, an 8.3 short name, a junction, a `..` that walks
out and back -- and a comparison that misses any of them is a confinement
check that says yes to a path outside the vault.

Two comparisons live here and the difference matters.

* `is_within_lexical` is pure string work: `abspath` collapses `..` and
  `normcase` folds case and separators. It touches no file, so it can be
  applied to a path the caller must not disturb.
* `is_within` additionally resolves through `realpath`, which on Windows asks
  the filesystem for the final name and so also collapses 8.3 aliases,
  symlinks and junctions. It requires the path to be reachable and is a
  time-of-check-to-time-of-use answer: the object it describes can be renamed
  the instant after it returns. Only a retained handle -- the native bridge --
  can turn that into a guarantee.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path, PurePath, PureWindowsPath

#: Names MS-DOS device compatibility still reserves, at any directory level and
#: with any extension. `notes/CON.md` is not a file, it is the console.
WINDOWS_RESERVED_NAMES: frozenset[str] = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{digit}" for digit in range(1, 10)}
    | {f"lpt{digit}" for digit in range(1, 10)}
)

#: Characters Windows refuses in a filename plus the separators. Checked
#: explicitly rather than left to the OS, because the OS's refusal arrives
#: after we have already decided a name is safe to join onto the root.
_FORBIDDEN_NAME_CHARACTERS = frozenset('<>:"/\\|?*') | {chr(code) for code in range(32)}

MAX_COMPONENT_LENGTH = 96


class UnsafePathComponentError(ValueError):
    """A directory or file name that must never be joined onto the vault root."""


def normalize_case(value: str) -> str:
    """Fold a path string the way the running platform folds it.

    `os.path.normcase` lowercases and converts separators on Windows and is
    the identity on POSIX. Hard-coding either rule would make the comparison
    wrong on the other platform in the direction that matters: too permissive.
    """
    return os.path.normcase(value)


def lexical_parts(path: Path | str) -> tuple[str, ...]:
    """Case-folded components of an absolute path, computed without any I/O."""
    absolute = os.path.abspath(os.fspath(path))
    return tuple(normalize_case(part) for part in PurePath(absolute).parts)


def canonical_parts(path: Path | str) -> tuple[str, ...]:
    """Case-folded components of the resolved path, asking the filesystem.

    `realpath` is used rather than `Path.resolve()` because the two differ on
    a path that does not exist: `resolve()` has historically raised or
    round-tripped differently across platforms, while `realpath` resolves the
    longest existing prefix and joins the rest lexically, which is what a
    containment check needs for a file that is about to be created.
    """
    return tuple(normalize_case(part) for part in PurePath(os.path.realpath(os.fspath(path))).parts)


def is_within_lexical(root: Path | str, candidate: Path | str) -> bool:
    """Whether `candidate` is the root or sits under it, by string alone."""
    return _is_prefix(lexical_parts(root), lexical_parts(candidate))


def is_within(root: Path | str, candidate: Path | str) -> bool:
    """Whether `candidate` resolves to the root or somewhere under it.

    Refuses when either side is a UNC path: a network location is outside the
    supported vault entirely, and comparing two of them component-wise would
    imply this code understands share semantics it does not.
    """
    if is_unc(root) or is_unc(candidate):
        return False
    return _is_prefix(canonical_parts(root), canonical_parts(candidate))


def _is_prefix(root: tuple[str, ...], candidate: tuple[str, ...]) -> bool:
    return len(candidate) >= len(root) and candidate[: len(root)] == root


def is_unc(path: Path | str) -> bool:
    """Whether the path names a network share rather than a local volume."""
    text = os.fspath(path)
    if text.startswith(("\\\\", "//")):
        return True
    return PureWindowsPath(text).drive.startswith(("\\\\", "//"))


def is_reparse_point(path: Path | str) -> bool:
    """Whether the object itself is a junction, symlink, or other reparse point.

    `st_reparse_tag` is Windows-only and is the accurate answer there:
    `is_symlink()` alone returns False for a directory junction, which is the
    reparse point a caller is most likely to be handed by accident because
    creating one needs no privilege.
    """
    try:
        status = os.lstat(os.fspath(path))
    except OSError:
        return False
    tag = getattr(status, "st_reparse_tag", 0)
    if tag:
        return True
    return Path(path).is_symlink()


def ancestors(path: Path | str) -> tuple[Path, ...]:
    """The path itself and every directory above it, nearest first."""
    resolved = Path(os.path.abspath(os.fspath(path)))
    return (resolved, *resolved.parents)


def any_reparse_point(path: Path | str) -> bool:
    """Whether the path or any directory above it is a reparse point.

    Checked all the way up because a junction anywhere in the chain means the
    location the owner believes they configured is not the location the vault
    is confined to, and stage one has no handle to notice the substitution.
    """
    return any(is_reparse_point(candidate) for candidate in ancestors(path))


def relative_within(root: Path | str, candidate: Path | str) -> PurePath:
    """The candidate's path relative to the root, refusing anything outside."""
    root_parts = canonical_parts(root)
    candidate_parts = canonical_parts(candidate)
    if not _is_prefix(root_parts, candidate_parts):
        raise UnsafePathComponentError("path is outside the vault root")
    # Rebuilt from the *unresolved* candidate so the returned relative path
    # keeps the owner's own capitalisation; only the comparison folds case.
    return PurePath(*Path(os.path.abspath(os.fspath(candidate))).parts[len(root_parts) :])


def validate_component(name: str) -> str:
    """Check one directory or file name before it is joined onto the root.

    A projection's filename is derived from data. Every historical directory
    traversal is this check being skipped, so it is spelled out rather than
    delegated to `Path`, which will happily absorb a `..` or a drive letter
    into a join and silently produce a path outside the vault.
    """
    if not name:
        raise UnsafePathComponentError("path component is empty")
    if len(name) > MAX_COMPONENT_LENGTH:
        raise UnsafePathComponentError("path component is too long")
    if name in (".", ".."):
        raise UnsafePathComponentError("path component is a relative traversal")
    if set(name) & _FORBIDDEN_NAME_CHARACTERS:
        raise UnsafePathComponentError("path component holds a separator or reserved character")
    if name != name.strip() or name.endswith("."):
        # Windows silently strips these, so `evil.md ` and `evil.md` become the
        # same file and an exclusive create would not detect the collision.
        raise UnsafePathComponentError("path component has leading or trailing whitespace or a trailing dot")
    if name.split(".")[0].lower() in WINDOWS_RESERVED_NAMES:
        raise UnsafePathComponentError("path component is a reserved device name")
    return name


def is_case_insensitive_filesystem() -> bool:
    """Whether this platform folds case in paths.

    Reported rather than assumed so a test can say which rule it is exercising
    instead of encoding one platform's answer as a constant.
    """
    return sys.platform == "win32" or os.path.normcase("A") == "a"
