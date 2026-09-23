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
#: path is refused.
_WINDOWS_OWNED_DIRECTORY_NAMES = frozenset({"Windows", "Program Files", "Program Files (x86)", "ProgramData"})

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


class RealDaclNotPermittedError(RuntimeError):
    """A real DACL write was attempted without the explicit opt-in.

    Every function here that changes a permission is gated on
    `JARVIS_ALLOW_REAL_DACL` for one reason: on 2026-09-22 the ordinary act of
    *running the test suite on this PC* rewrote the user's profile, because this
    module applies a DACL whenever a store is opened and `SetNamedSecurityInfoW`
    propagates to everything below. Anything that reaches these calls on a real
    machine now has to say so out loud.

    `jarvis serve` is the only production caller and permits it explicitly. The
    test suite does not: it replaces the seam instead, so no test changes a
    permission anywhere -- see `tests/conftest.py`.
    """


#: Set to `1` to allow real permission changes. Unset by default, so an ad-hoc
#: script or a test run cannot damage the machine it runs on.
_PERMISSION_ENVIRONMENT_VARIABLE = "JARVIS_ALLOW_REAL_DACL"


def real_dacl_permitted() -> bool:
    return os.environ.get(_PERMISSION_ENVIRONMENT_VARIABLE, "") == "1"


def permit_real_dacl() -> None:
    """Allow real permission changes for the rest of this process.

    Called by `jarvis serve`, the one caller that is supposed to change a
    store's permissions. Importable rather than set through the environment
    directly so the variable's name lives in exactly one file.
    """
    os.environ[_PERMISSION_ENVIRONMENT_VARIABLE] = "1"


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
    """Write the store's owner and DACL onto `path`, which must be inside `store_root`.

    `store_root` is required rather than optional on purpose. The damage this
    module caused came from a call that could name any directory on the machine;
    a required root, checked here and re-checked in `_refuse_unsafe_path`, means
    a wrong argument raises instead of rewriting a profile.

    The owner is set in the same call because it is half the defect. An object
    owned by Administrators with a DACL naming the user still works, but leaving
    the owner wrong means the next `mkdir(mode=0o700)` under it inherits the
    same trap.
    """
    target = _refuse_unsafe_path(path, store_root)
    if not real_dacl_permitted():
        raise RealDaclNotPermittedError(
            f"refusing to change permissions on {target}; set {_PERMISSION_ENVIRONMENT_VARIABLE}=1 to allow it"
        )
    advapi32, kernel32 = _windows_apis()
    descriptor = ctypes.c_void_p()
    length = ctypes.c_ulong()
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        folder_only_sddl(user_sid), _SDDL_REVISION_1, ctypes.byref(descriptor), ctypes.byref(length)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    owner = ctypes.c_void_p()
    if not advapi32.ConvertStringSidToSidW(user_sid, ctypes.byref(owner)):
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
            str(target),
            _SE_FILE_OBJECT,
            _OWNER_SECURITY_INFORMATION | _DACL_SECURITY_INFORMATION | _PROTECTED_DACL_SECURITY_INFORMATION,
            owner,
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


def repair_store_tree(root: Path, user_sid: str) -> tuple[Path, ...]:
    """Re-apply the store DACL to every directory at or under `root`.

    `root` is both the outermost directory this may touch and the boundary the
    guard checks against, so there is no path by which this walks upward: the
    original defect was a caller looping over `path.parents` to the drive root.

    The walk descends only. `os.walk` is given an `onerror` handler rather than
    left to `Path.rglob`, which raises the first `PermissionError` and abandons
    the rest of the tree -- precisely the tree that needs repairing.

    Returns the paths that could not be repaired; each one is also logged as it
    happens, because the caller that ignores this return value is how the first
    version's refusals went unnoticed.
    """
    failures: list[Path] = []

    def record(error: OSError) -> None:
        failed = Path(getattr(error, "filename", None) or root)
        failures.append(failed)
        logger.warning("could not read %s while repairing store permissions: %s", failed, error)

    if not root.exists():
        return ()
    for current, _children, _files in os.walk(root, followlinks=False, onerror=record):
        try:
            apply_owner_only_dacl(Path(current), user_sid, store_root=root)
        except (OSError, UnsafeStorePathError) as error:
            failures.append(Path(current))
            logger.warning("could not repair %s: %s", current, error)
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
    """
    try:
        target = path.resolve(strict=False)
        root = store_root.resolve(strict=False)
    except OSError as error:
        raise UnsafeStorePathError(f"cannot resolve {path!r}: {error}") from error

    if not target.name:
        raise UnsafeStorePathError(f"refusing a path with no name: {path!r}")
    if target.parent == target:
        raise UnsafeStorePathError(f"refusing a drive or filesystem root: {target}")
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


def _windows_apis() -> tuple[ctypes.WinDLL, ctypes.WinDLL]:  # type: ignore[name-defined]
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
    "RealDaclNotPermittedError",
    "UnsafeStorePathError",
    "apply_owner_only_dacl",
    "current_user_sid",
    "ensure_private_directory",
    "folder_only_sddl",
    "permit_real_dacl",
    "real_dacl_permitted",
    "repair_store_tree",
    "tree_owner_sddl",
]
