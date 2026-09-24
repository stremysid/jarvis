"""Windows ownership and access control for the store directories.

This exists because of one measured failure, and the full story matters to
anyone tempted to simplify it away.

SQLite's store must be private. On POSIX that is a mode: 0700, enforced by
`_restrict_sqlite_directory` in `database.py`. On Windows it cannot be a mode.
Since CPython 3.12.4, the CVE-2024-4030 fix makes `mkdir(mode=0o700)` apply a
*protected* DACL -- `D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` --
instead of relying on inheritance. Measured on this PC, 2026-09-22, Python
3.12.6:

    os.mkdir(path, mode=stat.S_IRWXU)  ->  O:<user> G:<user's group>
                                           D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)
                                              (A;OICI;FA;;;BA)

`OW` is OWNER RIGHTS, the object's owner, and there is no entry naming the
user's own SID. That is fine while the owner is the user. It stops being fine
when the object is created by an elevated process, because Windows gives an
object created by an administrator token the *Administrators group* as its
owner. `OW` then resolves to Administrators, and the only entry that could
admit the user is gone: the DACL names SYSTEM, Administrators, and whoever owns
the object -- and the owner is not him.

That is exactly what happened. `ops/jarvis-logon-task.ps1` starts the agent
elevated, it created `%LOCALAPPDATA%\\Jarvis\\data`, and from Sid's normal
session `icacls` on that folder answers `Access is denied`, because his token
carries Administrators as deny-only and there is no ACE naming him. Confirmed
on this PC, from the ordinary session:

    icacls "%LOCALAPPDATA%\\Jarvis\\data"   ->  Access is denied.

So the DACL is written explicitly here, and the owner is set to the user's own
SID as well as the DACL -- setting only the DACL would leave `OW` pointing at
Administrators and the explicit SID entry is what actually admits him.

**This module damaged this PC once, and the shape of that is worth carrying.**
The first version reused `owner_only_sddl` from the pipe server. A pipe has no
children, so its ACEs carry no `OI`/`CI` inheritance flags -- put on a folder,
they grant access to that folder and nothing inside it. Worse, its caller
applied them to every *parent* of the store as well. `C:\\Users\\Sid` received
that list, Windows recomputed everything beneath it from a folder that now
passed nothing down, the whole profile became unreadable, and the second
attempt rewrote `C:\\` as well. `SetNamedSecurityInfoW` propagates
automatically, so an applied-but-wrong ACL is never local to the object it
names.

Three rules came out of that and are enforced here:

1. **The SDDL is this module's own, and it inherits.** `folder_only_sddl` grants
   the same three principals full control with `(OI)(CI)`, so every ACE can only
   ever *add* access below. Nothing here reuses the pipe helper.
2. **Only the store directory and what is inside it is ever touched.**
   `repair_store_tree` descends; it does not walk upward.
3. **The guard is not a caller's promise.** `_refuse_unsafe_path` re-checks every
   path immediately before it is written, refuses drive roots, the account and
   profile folders and the AppData/Temp roots outright, and refuses anything
   that is not at or below the store root passed in with the call.

Windows-only. `ctypes` is imported at module scope but no Win32 call happens at
import, so the Ubuntu job imports this too; the callers guard.
"""

from __future__ import annotations

import ctypes
import logging
import os
import re
from collections.abc import Iterable
from pathlib import Path

from jarvis_local.transport.pipe_server import current_user_sid

logger = logging.getLogger(__name__)

#: A SID as Windows renders it. Checked before the string is spliced into a
#: security descriptor, and it is the same shape `owner_only_sddl` accepts.
_SID_PATTERN = re.compile(r"S-1-\d{1,10}(-\d{1,10}){1,15}\Z")

#: Set the DACL, the owner, and mark the DACL protected.
_DACL_SECURITY_INFORMATION = 0x00000004
_OWNER_SECURITY_INFORMATION = 0x00000001
#: Without this, Windows keeps whatever protection flag the object already had
#: and the "P" in the SDDL is ignored, which is how `AppData\\Local` and `Temp`
#: stayed unprotected while the profile stayed protected.
_PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
_SDDL_REVISION_1 = 1
_SE_FILE_OBJECT = 1

#: Directories Windows owns. A store never legitimately lives under one, and
#: these ignore a parent folder's permissions anyway, so a match anywhere in the
#: path is refused. `ProgramData` is deliberately absent: it is only refused as a
#: whole path by `_REFUSED_ABSOLUTE_PATHS`, and listing it here as well meant the
#: name-based arm answered first and the literal arm was untestable through it.
_WINDOWS_OWNED_DIRECTORY_NAMES = frozenset({"Windows", "Program Files", "Program Files (x86)"})

#: Complete paths refused outright. Deliberately *not* recursive:
#: `AppData\\Local` and `Temp` are refused as objects, while
#: `...\\AppData\\Local\\Jarvis`, where the real store lives, is exactly what
#: this module is for.
_REFUSED_ABSOLUTE_PATHS = (
    Path(r"C:\Users"),
    Path(r"C:\Users\Public"),
    Path(r"C:\Program Files"),
    Path(r"C:\Program Files (x86)"),
    Path(r"C:\ProgramData"),
)

#: Account and junk roots, read from the environment at import. A store under
#: one of these is a configuration error, not a store.
_REFUSED_ENVIRONMENT_ROOTS = (
    "SystemRoot",
    "windir",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
)


class UnsafeStorePathError(RuntimeError):
    """A path was refused before any permission was written to it.

    Raised rather than skipped because reaching it means a caller asked for
    something this module must never do, and the last time that happened the
    account's own profile was rewritten.
    """


#: Where the local agent's own stores live, as configured. These are the names
#: `config.py` already requires, so there is one definition of the store root
#: rather than a second copy free to drift from it.
_ARCHIVE_PATH_VARIABLE = "JARVIS_ARCHIVE_PATH"
_MEMORY_PATH_VARIABLE = "JARVIS_MEMORY_PATH"

#: The fixed fallback, and the one the live PC actually uses:
#: `%LOCALAPPDATA%\\Jarvis`, which holds `data` and therefore the stores.
_FALLBACK_DIRECTORY_NAME = "Jarvis"


class StoreDaclRefusedError(RuntimeError):
    """The store's DACL could not be written, so the store is not private.

    The case that actually occurs: a store owned by Administrators, opened
    non-elevated. The DACL write is checked against the object's access, and
    this account is not named on it. The message has to carry the one-time fix,
    because nothing this process can do will change it -- and if the boot chain
    stops running elevated, no run of `jarvis serve` will either.
    """


class StoreOwnerUnknownError(RuntimeError):
    """The DACL was applied but the current owner could not be read.

    Access is fixed; ownership was not attempted. Raised rather than passed over
    because the owner is half the original defect and an unread owner is not the
    same as an owner that already matches.
    """


class StoreRootUnresolvedError(RuntimeError):
    """No store root could be determined, so no boundary can be checked.

    Raised rather than answered with an empty tuple. An empty result used to
    mean "no boundary configured", and `_refuse_unsafe_path` skipped the check
    on an empty result -- so a blank or missing configuration silently removed
    the guard on the one call that changes real permissions.
    """


def _default_store_root() -> Path:
    """`%LOCALAPPDATA%\\Jarvis`, or the POSIX equivalent.

    The POSIX leg exists so the Ubuntu job can exercise this path instead of
    skipping it; nothing in the fleet runs there, but a guard that cannot be
    tested is a guard nobody has tested.
    """
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA", "").strip()
        if base:
            return Path(base) / _FALLBACK_DIRECTORY_NAME
        profile = os.environ.get("USERPROFILE", "").strip()
        if profile:
            return Path(profile) / "AppData" / "Local" / _FALLBACK_DIRECTORY_NAME
    else:
        xdg = os.environ.get("XDG_DATA_HOME", "").strip()
        if xdg:
            return Path(xdg) / "jarvis"
        if Path.home():
            return Path.home() / ".local" / "share" / "jarvis"
    raise StoreRootUnresolvedError(
        "cannot locate the Jarvis data directory; set JARVIS_ARCHIVE_PATH and JARVIS_MEMORY_PATH"
    )


def configured_store_roots() -> tuple[Path, ...]:
    """The directories Jarvis's own stores live in. Never empty, never broad.

    This is the boundary, and it is deliberately **not** derived from the path
    being changed. An earlier version took `store_root = path.parent`, which
    made the containment check in `_refuse_unsafe_path` vacuously true: the code
    choosing the target also chose the boundary, so every path passed. A caller
    that had opted into real DACL writes could then have named anything on the
    machine.

    An earlier version of *this* function returned an empty tuple when the
    variables were unset, and the guard treated empty as "no boundary" -- so a
    missing configuration removed the guard entirely. Two rules now:

    * **Unset falls back to `%LOCALAPPDATA%\\Jarvis`**, the fixed location the
      live store is under, so there is always a real boundary.
    * **Set to empty is a misconfiguration and raises.** Falling back from a
      blank value would hide a broken configuration and widen the boundary the
      administrator thought they had set.
    * **Set to a relative path is a misconfiguration and raises.** It used to be
      resolved against the process's working directory, which for a boot-started
      service is not a location anybody chose. The boundary would then depend on
      where the logon task happened to start the process, and the same
      configuration would name different directories on different runs -- which
      is the one property a boundary may not have. `config.py` already refuses a
      relative path for these two names; this is the same rule enforced at the
      point that actually writes permissions, because these functions are also
      reachable directly.

    The result is refused if it turns out to be a filesystem root, the user
    profile, or a temp directory: a store there is a misconfiguration, and
    accepting it would hand back exactly the broad boundary this exists to
    prevent.
    """
    roots: list[Path] = []
    supplied = False
    for variable in (_ARCHIVE_PATH_VARIABLE, _MEMORY_PATH_VARIABLE):
        if variable not in os.environ:
            continue
        value = os.environ[variable].strip()
        if not value:
            raise StoreRootUnresolvedError(f"{variable} is set but empty")
        if not os.path.isabs(value):
            raise StoreRootUnresolvedError(
                f"{variable} is not an absolute path: {value!r}. A relative store path would be "
                f"resolved against the process working directory, which for a boot-started service "
                f"nobody chose"
            )
        supplied = True
        roots.append(Path(value).parent.resolve(strict=False))
    if not supplied:
        roots.append(_default_store_root().resolve(strict=False))
    for root in roots:
        _refuse_broad_root(root)
    return tuple(dict.fromkeys(roots))


def store_root_summary() -> str:
    """The resolved store roots and their ownership, as one line, for a start-up log.

    Resolves rather than describes: a log line that restated the environment
    variables would not show the fallback, and the fallback is the part a reader
    cannot infer. Says so explicitly when the default applied, because "the
    default" and "an administrator chose this" must not look alike in a log
    somebody is reading at 2am.

    Also reports ownership, because a store owned by Administrators is the one
    state a non-elevated service cannot repair and the message has to name the
    one-time fix rather than leaving a reader to rediscover it.
    """
    supplied = any(
        os.environ.get(variable, "").strip()
        for variable in (_ARCHIVE_PATH_VARIABLE, _MEMORY_PATH_VARIABLE)
    )
    try:
        roots = configured_store_roots()
    except StoreRootUnresolvedError as error:
        # The service is going to refuse; the log should say why before it does.
        return f"unresolved ({error})"
    rendered = ", ".join(os.fspath(root) for root in roots)
    if not supplied:
        rendered = f"{rendered} (default; no store path configured)"
    return f"{rendered}{_ownership_note(roots)}"


def _ownership_note(roots: tuple[Path, ...]) -> str:
    """A warning suffix naming the one-time fix, or nothing when all is well.

    Nothing at all away from Windows, where there is no owner to read and no
    `ctypes.WinDLL` -- `current_user_sid` raises `AttributeError` there, not an
    `OSError`, which is why both are caught. A log line is not the place to
    discover that the platform has no such API.
    """
    try:
        ours = current_user_sid()
    except (OSError, AttributeError):
        return ""
    for root in roots:
        if not root.exists():
            continue
        try:
            owner = _current_owner_sid(root)
        except (OSError, AttributeError):
            continue
        if owner != ours:
            return (
                f"; WARNING {root} is owned by {owner}, not by {ours} -- a non-elevated service "
                f"cannot change that. One-time fix: run `jarvis serve` once from an elevated shell, "
                f'or: icacls "{root}" /grant "*{ours}:(OI)(CI)F" /T'
            )
    return ""


def _refuse_broad_root(root: Path) -> None:
    """Refuse a boundary that is too wide to be a store root.

    `%LOCALAPPDATA%\\Jarvis` is the intended shape. A drive root, the profile
    itself, or `Temp` would all make the containment check largely cosmetic, so
    they are refused where they are configured rather than at each write.
    """
    if root.parent == root:
        raise StoreRootUnresolvedError(f"a filesystem root is not a store root: {root}")
    for variable in ("USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME"):
        value = os.environ.get(variable, "").strip()
        if value and root == Path(value).resolve(strict=False):
            raise StoreRootUnresolvedError(f"{variable} is not a store root: {root}")


def store_root_base() -> Path:
    """The one directory a store root is allowed to be at or beneath.

    This is the allowlist, and it is deliberately a single fixed location rather
    than an enumeration of the places a store must not live. A denylist answers
    "is this one of the bad ones?" and is wrong for every bad place nobody
    listed; the question that matters before a process starts changing ACLs is
    "is this one of the *good* ones?", which only an allowlist can answer.

    The value is `_default_store_root()` -- `%LOCALAPPDATA%\\Jarvis` on Windows,
    its XDG equivalent elsewhere -- so the permitted set and the fallback the
    live PC actually uses are the same directory by construction rather than by
    two lists agreeing.
    """
    return _default_store_root().resolve(strict=False)


def permit_store_roots(roots: Iterable[Path]) -> tuple[Path, ...]:
    """The roots that are inside the allowlist, or a refusal.

    Applied where `jarvis serve` starts and **not** inside
    `configured_store_roots()`: the integration tests point a store at
    `C:\\jarvis-test-scratch`, and a boundary check there would need an
    environment variable to widen — which is a gate on the guard, and gates on
    guards are what D12 removed. The service, which is the thing that actually
    changes permissions on every run, is the right place to be strict.

    Returns the roots resolved, so callers and tests compare the same values.
    """
    base = store_root_base()
    if not roots:
        raise StoreRootUnresolvedError("no store root to allow; the configuration resolved to nothing")
    allowed: list[Path] = []
    for root in roots:
        resolved = root.resolve(strict=False)
        if resolved != base and base not in resolved.parents:
            raise StoreRootUnresolvedError(
                f"{resolved} is outside the only permitted store location ({base}); "
                f"move the store there, or point {_ARCHIVE_PATH_VARIABLE} / {_MEMORY_PATH_VARIABLE} at a file inside it"
            )
        allowed.append(resolved)
    return tuple(allowed)


def folder_only_sddl(user_sid: str) -> str:
    """The store's DACL: full control for SYSTEM, Administrators and the user.

    `D:PAI` is a protected, auto-inherited DACL and every entry carries
    `(OI)(CI)`, so the ACEs pass down to files and subdirectories. That is the
    opposite of the pipe server's `D:P(A;;GA;;;...)`, which has no inheritance
    flags because a pipe has nothing to inherit into -- and which, applied to a
    profile folder, is what emptied it.

    `O:` pins the owner so the object is owned by the user rather than by
    Administrators when an elevated process created it.

    Administrators stay on the list deliberately: an administrator can take
    ownership of the object regardless, so excluding them would buy no security
    and would remove the ability to diagnose the service from an elevated shell.
    The SID is re-checked here because a string spliced into a security
    descriptor is exactly the parameter that acquires a caller later.
    """
    if not _SID_PATTERN.match(user_sid):
        raise ValueError(f"not a well-formed SID: {user_sid!r}")
    return f"O:{user_sid}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user_sid})"


def apply_owner_only_dacl(path: Path, user_sid: str, *, store_root: Path) -> None:
    """Write the store's DACL onto `path`, then set the owner if it differs.

    **Two calls, in this order, and the order is the whole point.** Windows
    checks whether the caller may set the owner against the DACL *as that same
    call receives it*, before the new DACL is applied -- so a single call
    carrying `OWNER | DACL | PROTECTED` is refused with ERROR_ACCESS_DENIED even
    when the caller already owns the object and the new DACL would grant it
    everything. Measured 20 times out of 20 on this PC, against a folder with a
    plain inherited DACL; the same call against a folder carrying Python's
    CVE-2024-4030 DACL (which includes an `OW` entry) succeeded 20/20, and
    `DACL`-then-`OWNER` as two calls succeeded in every case.

    So the DACL goes first. It grants SYSTEM, Administrators and the user full
    control with inheritance, which includes WRITE_OWNER for the user, and that
    is what then authorizes the second call -- which is why no elevation check
    belongs here: a non-elevated process that has just written this DACL can
    set the owner on its own store.

    The ordering also means a failure cannot leave the store unreachable. If the
    first call fails, nothing was changed. If it succeeds, the DACL already
    names the user with full control, so the second call failing leaves a store
    the user can still open -- and that second failure is unexpected, so it
    raises rather than being written off as a degraded mode.
    """
    target = _refuse_unsafe_path(path, store_root)
    # Read the owner before changing anything, so the DACL is still the old one
    # if this fails -- and apply the DACL anyway even then, because the fix the
    # user actually needs is access, not ownership.
    current_owner: str | None
    try:
        current_owner = _current_owner_sid(target)
    except OSError as error:
        current_owner = None
        logger.warning("cannot read the owner of %s: %s", target, error)

    try:
        _set_security_info(
            target, user_sid, _DACL_SECURITY_INFORMATION | _PROTECTED_DACL_SECURITY_INFORMATION, None
        )
    except OSError as error:
        # Nothing was changed, so the store keeps whatever access it had. The
        # message has to be actionable, because this process cannot fix it.
        raise StoreDaclRefusedError(dacl_refused_message(target, error)) from error

    if current_owner is None:
        raise StoreOwnerUnknownError(
            f"{target} has been given the store DACL, but its current owner could not be read, so "
            "ownership was not changed. Run `jarvis serve` elevated once to repair it."
        )
    if current_owner == user_sid:
        return
    _set_security_info(target, user_sid, _OWNER_SECURITY_INFORMATION, user_sid)


def dacl_refused_message(path: Path, error: OSError) -> str:
    """The sentence for a refused DACL write, naming the one-time fix.

    Two routes are offered because only one of them may exist: `jarvis serve`
    elevated repairs every store the service opens, and the `icacls` line
    repairs this exact path without depending on the boot chain ever running
    elevated again.
    """
    return (
        f"cannot set the permissions of {path}: {error.strerror or error}. "
        f"This is what a store owned by Administrators looks like from a non-elevated session. "
        f"One-time fix, either: run `jarvis serve` once from an elevated shell; "
        f'or run: icacls "{path}" /grant "*{_current_user_sid_or_none()}:(OI)(CI)F" /T'
    )


def _current_user_sid_or_none() -> str:
    """The current user's SID for an error message, or a placeholder.

    On a platform with no `ctypes.WinDLL` this raises `AttributeError`, not
    `OSError`; an error message must not fail to build because it could not name
    the user.
    """
    try:
        return current_user_sid()
    except (OSError, AttributeError):
        return "<your-sid>"


def _current_owner_sid(path: Path) -> str:
    """The SID that currently owns `path`, as a string."""
    advapi32, kernel32 = _windows_apis()
    descriptor = ctypes.c_void_p()
    result = advapi32.GetNamedSecurityInfoW(
        str(path), _SE_FILE_OBJECT, _OWNER_SECURITY_INFORMATION,
        None, None, None, None, ctypes.byref(descriptor),
    )
    if result != 0:
        raise ctypes.WinError(result)
    owner = ctypes.c_void_p()
    defaulted = ctypes.c_int()
    text = ctypes.c_wchar_p()
    try:
        if not advapi32.GetSecurityDescriptorOwner(descriptor, ctypes.byref(owner), ctypes.byref(defaulted)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not owner.value:
            raise OSError("the store descriptor carries no owner")
        if not advapi32.ConvertSidToStringSidW(owner, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        if text.value is None:
            raise OSError("the owner SID converted to nothing")
        return str(text.value)
    finally:
        if text:
            kernel32.LocalFree(text)
        kernel32.LocalFree(descriptor)


def _set_security_info(path: Path, user_sid: str, bits: int, owner_sid: str | None) -> None:
    """One `SetNamedSecurityInfoW` call carrying exactly `bits`.

    Kept separate from the policy above so a test can assert the two calls, the
    order, and the exact masks rather than only their combined effect.
    """
    advapi32, kernel32 = _windows_apis()
    descriptor = ctypes.c_void_p()
    length = ctypes.c_ulong()
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        folder_only_sddl(user_sid), _SDDL_REVISION_1, ctypes.byref(descriptor), ctypes.byref(length)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    owner = ctypes.c_void_p()
    if owner_sid is not None and not advapi32.ConvertStringSidToSidW(owner_sid, ctypes.byref(owner)):
        kernel32.LocalFree(descriptor)
        raise ctypes.WinError(ctypes.get_last_error())
    acl = ctypes.c_void_p()
    present = ctypes.c_int()
    defaulted = ctypes.c_int()
    try:
        # `SetNamedSecurityInfoW` takes a PACL, not the descriptor that was just
        # built -- passing the descriptor itself is accepted by ctypes and
        # answered with ERROR_INVALID_PARAMETER, which says nothing about which
        # of the seven arguments was wrong. The owner is likewise a real SID
        # pointer; a *string* SID is marshalled as a `char *` and rejected with
        # the same unhelpful error.
        if not advapi32.GetSecurityDescriptorDacl(
            descriptor, ctypes.byref(present), ctypes.byref(acl), ctypes.byref(defaulted)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if not present.value:
            raise OSError("the store descriptor carries no DACL")
        result = advapi32.SetNamedSecurityInfoW(
            str(path),
            _SE_FILE_OBJECT,
            bits,
            owner if owner_sid is not None else None,
            None,
            acl,
            None,
        )
        if result != 0:
            raise ctypes.WinError(result)
    finally:
        # Both conversions allocate with LocalAlloc, so the caller frees them.
        # Leaking them would leak once per repaired store, which is the sort of
        # thing that only shows up on the machine that has been running for a month.
        kernel32.LocalFree(owner)
        kernel32.LocalFree(descriptor)


def ensure_private_directory(path: Path, user_sid: str, *, store_root: Path) -> None:
    """Create `path` if missing, then hold it to the store DACL.

    Applied whether or not the directory was just created: an existing directory
    created the old way is repaired by the same call, which is what lets a
    running agent fix its own store at start.

    `mode=stat.S_IRWXU` is passed as well as the DACL. Windows ignores the mode,
    but these callers are platform-shared and the code this replaced created
    these directories 0700 -- dropping it would silently widen them on POSIX.
    """
    import stat

    _refuse_unsafe_path(path, store_root)
    path.mkdir(mode=stat.S_IRWXU, parents=True, exist_ok=True)
    apply_owner_only_dacl(path, user_sid, store_root=store_root)


def is_reparse_point(path: Path) -> bool:
    """Whether `path` is a junction, a symlink, or another reparse point.

    A local copy of `jarvis_local.vault.paths.is_reparse_point` rather than an
    import, because this module is imported by the archive open path and the
    vault package imports the archive one -- an import here would be a cycle.
    The two are deliberately identical; if one changes, both must.

    `st_reparse_tag` is the accurate answer on Windows and `is_symlink()` alone
    is not: it returns False for a directory *junction*, which is the reparse
    point this walk is most likely to meet, because creating one needs no
    privilege.
    """
    try:
        status = os.lstat(os.fspath(path))
    except OSError:
        return False
    if getattr(status, "st_reparse_tag", 0):
        return True
    return Path(path).is_symlink()


def repair_store_tree(root: Path, user_sid: str, *, store_root: Path | None = None) -> tuple[Path, ...]:
    """Re-apply the store DACL to every directory at or under `root`.

    `root` is both the outermost directory this may touch and the boundary the
    guard checks against, so there is no path by which this walks upward: the
    original defect was a caller looping over `path.parents` to the drive root.

    `store_root` names the boundary explicitly when the caller knows it. It is
    separate from `root` for the same reason `_refuse_unsafe_path` takes both:
    the walk chooses directories, and a walk that also chose the boundary would
    be free to reach anything. Defaults to `root`, which is still a boundary the
    caller cannot widen to a path above itself.

    The walk descends only. `os.walk` is given an `onerror` handler rather than
    left to `Path.rglob`, which raises the first `PermissionError` and abandons
    the rest of the tree -- precisely the tree that needs repairing.

    **Two things stop the descent, and the first is not an optimisation.** A
    reparse point is skipped rather than followed: a junction is a door out of
    the store, so following one would apply this DACL to whatever it points at,
    which is the class of mistake that damaged this account. And the whole walk
    aborts at the first directory the *guard* refuses, because a refusal there
    does not mean "this subtree is unlucky" -- it means the boundary or the
    caller is wrong, so every directory below would be refused identically.
    Walking the rest of the tree to collect hundreds of copies of one error is
    what made the first version's failures unreadable.

    A refused *DACL write* is deliberately not an abort. That one is the
    Administrators-owned store, it is recoverable by an elevated run, and the
    directories below it may well still be repairable -- aborting would abandon
    a tree on the strength of one unreachable folder.

    Returns the paths that could not be repaired; each one is also logged as it
    happens, because the caller that ignores this return value is how the first
    version's refusals went unnoticed.
    """
    boundary = store_root if store_root is not None else root
    failures: list[Path] = []
    aborted = False

    def record(error: OSError) -> None:
        nonlocal aborted
        failed = Path(getattr(error, "filename", None) or root)
        failures.append(failed)
        aborted = True
        logger.warning("could not read %s while repairing store permissions: %s", failed, error)

    if not root.exists():
        return ()
    for current, children, _files in os.walk(root, followlinks=False, onerror=record):
        if aborted:
            break
        directory = Path(current)
        if is_reparse_point(directory):
            # Not descended into and not written to. `followlinks=False` already
            # stops `os.walk` from following one; this stops the DACL write too.
            logger.warning("skipping %s: it is a junction or symlink, not a store directory", directory)
            children[:] = []
            continue
        try:
            apply_owner_only_dacl(directory, user_sid, store_root=boundary)
        except UnsafeStorePathError as error:
            failures.append(directory)
            aborted = True
            logger.warning("could not repair %s: %s", directory, error)
        except OSError as error:
            failures.append(directory)
            logger.warning("could not repair %s: %s", directory, error)
    return tuple(failures)




def _refuse_unsafe_path(path: Path, store_root: Path) -> Path:
    """Return `path` resolved, or raise `UnsafeStorePathError`.

    Every write goes through here. It is deliberately paranoid and deliberately
    last: it runs immediately before the Win32 call, so a caller that computed
    the path wrongly is stopped at the only moment that matters, rather than at
    whichever earlier check somebody remembered to call.

    The direction of every containment test matters. A path *above* the store
    root is refused -- that is the walk that damaged this PC. A path below it is
    the store, and is allowed. So `C:\\Users\\Sid\\AppData\\Local` is refused as
    an object while the store inside it is not, even though the store path has
    `Users` in its ancestry; matching ancestors by name would refuse the very
    path this module exists to fix.

    Two boundaries, both required: `store_root` from the caller, and the
    configured data directories from `configured_store_roots()`. The parameter
    alone is not enough, because a caller naming its own boundary can always
    satisfy it.
    """
    try:
        target = path.resolve(strict=False)
        root = store_root.resolve(strict=False)
    except OSError as error:
        raise UnsafeStorePathError(f"cannot resolve {path!r}: {error}") from error

    # Before the "no name" check, because a drive root has no name either and
    # would otherwise be refused as a nameless path -- which is true, and not the
    # fact worth reporting. Order here decides which sentence a reader gets.
    if target.parent == target:
        raise UnsafeStorePathError(f"refusing a drive or filesystem root: {target}")
    if not target.name:
        raise UnsafeStorePathError(f"refusing a path with no name: {path!r}")
    if any(part in _WINDOWS_OWNED_DIRECTORY_NAMES for part in target.parts):
        raise UnsafeStorePathError(f"refusing a directory Windows owns: {target}")
    for refused in _REFUSED_ABSOLUTE_PATHS:
        if target == refused.resolve(strict=False):
            raise UnsafeStorePathError(f"refusing a system or account root: {target}")
    for variable in _REFUSED_ENVIRONMENT_ROOTS:
        value = os.environ.get(variable)
        if value and target == Path(value).resolve(strict=False):
            raise UnsafeStorePathError(f"refusing {variable} ({target}) as a store directory")
    # One containment test, in one direction. `root not in target.parents` is
    # false exactly when `target` is the root or lies below it, so every other
    # path fails -- above the root, beside it, or on another drive. An earlier
    # draft also stated the "above the root" case as its own arm; no test could
    # distinguish it from this condition, which made it unpinned duplication
    # rather than the extra safety it looked like.
    if root not in target.parents and target != root:
        raise UnsafeStorePathError(f"{target} is not at or inside the store root {root}")
    # And the configured roots are checked as well, not instead. `store_root` is
    # a parameter, so on its own it is only as trustworthy as its caller; a
    # caller that passed the target's own parent would satisfy the test above
    # for any path it liked. These come from the configuration, which the code
    # choosing a target does not set.
    configured = configured_store_roots()
    if configured and not any(target == allowed or allowed in target.parents for allowed in configured):
        raise UnsafeStorePathError(
            f"{target} is outside every configured store root "
            f"({', '.join(os.fspath(allowed) for allowed in configured)})"
        )
    return target


def tree_owner_sddl(path: Path) -> str:
    """Read back the owner and DACL Windows actually holds for `path`.

    Exists so a test can ask the operating system what the directory carries
    rather than what it was handed. A descriptor that was passed to
    `SetNamedSecurityInfoW` and one that was applied look identical from the
    caller's side, and the failure this module fixes was invisible to every
    check that only inspected intent.
    """
    advapi32, kernel32 = _windows_apis()
    descriptor = ctypes.c_void_p()
    result = advapi32.GetNamedSecurityInfoW(
        str(path),
        _SE_FILE_OBJECT,
        _OWNER_SECURITY_INFORMATION | _DACL_SECURITY_INFORMATION,
        None,
        None,
        None,
        None,
        ctypes.byref(descriptor),
    )
    if result != 0:
        # `GetNamedSecurityInfoW` returns the error code; it does not set the
        # last-error value, so `WinError(get_last_error())` reported whatever
        # unrelated call had failed before.
        raise ctypes.WinError(result)
    text = ctypes.c_wchar_p()
    try:
        if not advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            _SDDL_REVISION_1,
            _OWNER_SECURITY_INFORMATION | _DACL_SECURITY_INFORMATION,
            ctypes.byref(text),
            None,
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if text.value is None:
            raise OSError("the store descriptor converted to nothing")
        return str(text.value)
    finally:
        if text:
            kernel32.LocalFree(text)
        kernel32.LocalFree(descriptor)


def _windows_apis() -> tuple[ctypes.WinDLL, ctypes.WinDLL]:
    """The two DLLs, with argument types declared.

    Declared rather than inferred because these calls pass pointers, and ctypes
    truncates a 64-bit pointer to 32 bits without a restype -- which is the kind
    of bug that works on a small test and corrupts on the real machine.

    This function is the module's single seam. Every test replaces it, which is
    what makes "no test changes a real permission" a property of the suite
    rather than a habit.
    """
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_ulong),
    ]
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = ctypes.c_int
    advapi32.SetNamedSecurityInfoW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    advapi32.SetNamedSecurityInfoW.restype = ctypes.c_ulong
    advapi32.ConvertStringSidToSidW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p)]
    advapi32.ConvertStringSidToSidW.restype = ctypes.c_int
    advapi32.GetSecurityDescriptorDacl.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_int),
    ]
    advapi32.GetSecurityDescriptorDacl.restype = ctypes.c_int
    advapi32.GetNamedSecurityInfoW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    advapi32.GetNamedSecurityInfoW.restype = ctypes.c_ulong
    advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_wchar_p),
        ctypes.POINTER(ctypes.c_ulong),
    ]
    advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype = ctypes.c_int
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return advapi32, kernel32


__all__ = [
    "StoreDaclRefusedError",
    "StoreOwnerUnknownError",
    "StoreRootUnresolvedError",
    "UnsafeStorePathError",
    "apply_owner_only_dacl",
    "configured_store_roots",
    "current_user_sid",
    "ensure_private_directory",
    "folder_only_sddl",
    "repair_store_tree",
    "store_root_summary",
    "tree_owner_sddl",
]
