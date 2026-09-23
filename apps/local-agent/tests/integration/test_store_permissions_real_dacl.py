r"""The one test that changes real permissions, and only under a scratch root.

Every other test of this module replaces the Win32 seam. This one does not: its
whole purpose is to prove that the DACL the module builds is the DACL Windows
actually stores, because the failure it fixes -- a folder its own user cannot
open -- was invisible to every check that only inspected intent.

It is deliberately hard to run by accident:

* it skips unless `C:\\jarvis-test-scratch` already exists, so the fact that a
  scratch root is wanted is a decision somebody made, not something this test
  makes for them;
* it asserts that the scratch root, the store directory and every path it is
  about to touch are that root or below it, before any call, and fails rather
  than proceeding if not;
* it never names `C:\\jarvis-test-scratch` itself as a target, only `data`
  inside it, so the scratch root's own access control is not this test's to set;
* it restores nothing on failure, on purpose -- a half-applied ACL is exactly
  what a repair needs to be able to fix, and rolling back would hide that.

See `store_permissions.py`'s module docstring for the measured DACL and for the
walk that reached `C:\Users\Sid` and destroyed the account's profile twice.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import pytest

from jarvis_local.archive import store_permissions
from jarvis_local.archive.store_permissions import (
    folder_only_sddl,
    tree_owner_sddl,
)
from jarvis_local.transport.pipe_server import current_user_sid

# Captured at import, before any fixture runs. `tests/conftest.py` replaces this
# with a no-op for the whole suite -- that fixture is what stops every other
# test from changing a real permission, and it must not be able to disarm this
# one, whose entire purpose is to change one.
_REAL_APPLY = store_permissions.apply_owner_only_dacl

SCRATCH_ROOT = Path(r"C:\jarvis-test-scratch")
SCRATCH_STORE = SCRATCH_ROOT / "data"

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="a Windows DACL is a Windows mechanism")
scratch_only = pytest.mark.skipif(
    not SCRATCH_ROOT.is_dir(),
    reason=f"creates and re-permissions a real directory, so it needs {SCRATCH_ROOT} to exist already",
)


@pytest.fixture(autouse=True)
def configured_root_is_the_scratch_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point this process's configured store root at the scratch directory.

    The guard checks a target against the configured roots as well as against
    the boundary passed in, so without this the test would be judged against
    whatever the machine is configured for -- `%LOCALAPPDATA%\\Jarvis` on the
    live PC -- and would be refused for being outside it. That refusal would be
    correct behaviour, and it is not what this test is measuring.

    The configured root has to **contain** the directory being changed, not
    merely be near it: the guard checks that a target is at or below a
    configured root. So the roots declared here are the scratch directory's own
    store files, putting `C:\\jarvis-test-scratch\\data` inside them. An earlier
    version pointed at `C:\\jarvis-test-scratch\\configured`, which does not
    contain `data`, and the guard refused -- correctly, and that is the refusal
    this test would otherwise have been measuring instead of the DACL.

    Scoping it to this process rather than editing the machine's configuration
    is deliberate: the test declares its own boundary, exactly as the guard
    requires of any caller, and leaves nothing behind in the environment.
    """
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(SCRATCH_ROOT / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(SCRATCH_ROOT / "memory.sqlite3"))


def assert_inside_scratch(*paths: Path) -> None:
    """Refuse to continue unless every path is the scratch root or below it.

    Called before any permission is changed, and once more after the directory
    is made, because the whole failure mode this guards against was a walk that
    reached the parent of what it was pointed at.
    """
    root = SCRATCH_ROOT.resolve(strict=False)
    for path in paths:
        resolved = path.resolve(strict=False)
        if resolved != root and root not in resolved.parents:
            raise AssertionError(f"refusing to touch {resolved}: outside {root}")


@windows_only
@scratch_only
def test_a_plain_inherited_folder_can_still_be_made_private() -> None:
    """D15: the case that failed, end to end and against the real API.

    A folder created by a plain `mkdir` inherits the parent's DACL, which grants
    modify through Authenticated Users and no WRITE_OWNER. In that state a single
    `SetNamedSecurityInfoW` carrying OWNER|DACL|PROTECTED is refused with
    ERROR_ACCESS_DENIED even though this user already owns it and the new DACL
    would grant everything -- measured 20 times out of 20. Writing the DACL
    first, then the owner, succeeded 20 times out of 20.

    This is the state an `mkdir(mode=0o700)` store never has, because Python's
    CVE-2024-4030 DACL carries an `OW` entry, which is why the module looked
    correct for so long.
    """
    store = scratch_store()
    inherited = store / "inherited"
    shutil.rmtree(inherited, ignore_errors=True)
    inherited.mkdir(parents=True)
    assert_inside_scratch(inherited)

    before = tree_owner_sddl(inherited)
    # The precondition this test exists for: inherited, and no OWNER RIGHTS entry.
    assert "D:AI" in before, before
    assert ";;;OW)" not in before, before

    sid = current_user_sid()
    _REAL_APPLY(inherited, sid, store_root=SCRATCH_ROOT)

    after = tree_owner_sddl(inherited)
    assert f"O:{sid}" in after, after
    assert f";;;{sid})" in after, after
    assert after.count("OICI") == 3, after
    # Protected now, rather than inheriting the parent's list.
    assert "D:PAI" in after, after
    assert ";;;OW)" not in after, after

    # And the folder is still the user's to remove -- the `ownertest` failure was
    # a folder left with no entry for him at all, which this ordering prevents.
    shutil.rmtree(inherited)
    assert not inherited.exists(), "the repaired folder could not be deleted non-elevated"


def scratch_store() -> Path:
    """The one directory this file is allowed to create and re-permission.

    Created here rather than assumed, because `SetNamedSecurityInfoW` needs the
    object to exist. `C:\\jarvis-test-scratch` itself is never a target and is
    never created by this file: it exists because a person made it, and that is
    the signal that a real-permission test is wanted. Its own access control is
    left exactly as it was found.
    """
    if SCRATCH_STORE.resolve(strict=False) == SCRATCH_ROOT.resolve(strict=False):
        raise AssertionError("the scratch root itself must never be a target")
    SCRATCH_STORE.mkdir(parents=True, exist_ok=True)
    assert_inside_scratch(SCRATCH_STORE)
    return SCRATCH_STORE


@windows_only
@scratch_only
def test_the_applied_dacl_is_the_inheriting_one_windows_actually_stores() -> None:
    """Read the descriptor back off the directory rather than trusting the SDDL.

    A descriptor handed to `SetNamedSecurityInfoW` and one that was applied look
    identical from the caller's side. The original defect was a DACL that
    looked right in the source and left the user locked out of his own folder.
    """
    store = scratch_store()

    sid = current_user_sid()
    assert_inside_scratch(store)
    _REAL_APPLY(store, sid, store_root=SCRATCH_ROOT)

    applied = tree_owner_sddl(store)
    assert f"O:{sid}" in applied, applied
    # The three principals, and crucially the inheritance flags: without OI/CI
    # the ACEs apply to this folder only, which is what emptied a profile.
    assert applied.count("OICI") == 3, applied
    assert f";;;{sid})" in applied, applied
    assert ";;;SY)" in applied, applied
    assert ";;;BA)" in applied, applied
    # Nothing wider than those three.
    assert ";;;WD)" not in applied, applied
    assert ";;;AU)" not in applied, applied
    assert ";;;BU)" not in applied, applied
    # The DACL is protected, which is what stops inherited entries riding in.
    assert "D:P" in applied, applied
    assert folder_only_sddl(sid).startswith("O:"), "the owner must be pinned, not left to the creator"


@windows_only
@scratch_only
def test_a_child_created_under_the_store_inherits_access() -> None:
    """The property the pipe SDDL does not have, asserted against the OS.

    This is the regression in one test: the old DACL granted the store folder
    and nothing inside it, so every file and subdirectory was unreachable.
    """
    assert_inside_scratch(SCRATCH_STORE)

    store = scratch_store()
    sid = current_user_sid()
    nested = store / "nested"
    _REAL_APPLY(store, sid, store_root=SCRATCH_ROOT)
    nested.mkdir(exist_ok=True)
    assert_inside_scratch(nested)

    inherited = tree_owner_sddl(nested)
    assert f"O:{sid}" in inherited or f";;;{sid})" in inherited, inherited
    # Inherited rather than explicitly set: the parent is passing them down.
    assert "D:AI" in inherited or "D:PAI" in inherited, inherited
    assert os.access(nested, os.R_OK), "the store's own directory is not readable by its owner"
