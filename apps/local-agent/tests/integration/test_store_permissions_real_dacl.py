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
def test_the_applied_dacl_is_the_inheriting_one_windows_actually_stores() -> None:
    """Read the descriptor back off the directory rather than trusting the SDDL.

    A descriptor handed to `SetNamedSecurityInfoW` and one that was applied look
    identical from the caller's side. The original defect was a DACL that
    looked right in the source and left the user locked out of his own folder.
    """
    assert_inside_scratch(SCRATCH_STORE)

    store_permissions.permit_real_dacl()
    sid = current_user_sid()
    assert_inside_scratch(SCRATCH_STORE)
    _REAL_APPLY(SCRATCH_STORE, sid, store_root=SCRATCH_ROOT)

    applied = tree_owner_sddl(SCRATCH_STORE)
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

    store_permissions.permit_real_dacl()
    sid = current_user_sid()
    nested = SCRATCH_STORE / "nested"
    _REAL_APPLY(SCRATCH_STORE, sid, store_root=SCRATCH_ROOT)
    nested.mkdir(exist_ok=True)
    assert_inside_scratch(nested)

    inherited = tree_owner_sddl(nested)
    assert f"O:{sid}" in inherited or f";;;{sid})" in inherited, inherited
    # Inherited rather than explicitly set: the parent is passing them down.
    assert "D:AI" in inherited or "D:PAI" in inherited, inherited
    assert os.access(nested, os.R_OK), "the store's own directory is not readable by its owner"
