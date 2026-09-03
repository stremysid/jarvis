"""Containment is the whole of stage one's confinement, so it is tested hard.

Windows offers several spellings of the same location. Each of the tests below
is a spelling that a naive string comparison would get wrong, and getting one
wrong means a confinement check that answers "inside the vault" about a path
that is not.
"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

import pytest

from jarvis_local.vault import paths
from jarvis_local.vault.paths import UnsafePathComponentError
from tests.vault.conftest import make_reparse_point


def test_containment_rejects_a_dot_dot_traversal_out_of_the_root(tmp_path: Path) -> None:
    root = tmp_path / "vault"
    root.mkdir()
    (tmp_path / "secrets").mkdir()

    escape = root / ".." / "secrets"

    assert not paths.is_within(root, escape)
    assert not paths.is_within_lexical(root, escape)


def test_containment_accepts_a_dot_dot_that_walks_out_and_back(tmp_path: Path) -> None:
    """The traversal is collapsed, not merely searched for.

    A check that rejected any path containing `..` would refuse this, which is
    inside the root; a check that only compared prefixes would accept the
    escape above. Both directions have to be right.
    """
    root = tmp_path / "vault"
    (root / "notes").mkdir(parents=True)

    assert paths.is_within(root, root / "notes" / ".." / "notes")


def test_containment_rejects_a_sibling_that_shares_a_name_prefix(tmp_path: Path) -> None:
    """`vault-backup` is not inside `vault`, though its string starts the same."""
    root = tmp_path / "vault"
    root.mkdir()
    sibling = tmp_path / "vault-backup"
    sibling.mkdir()

    assert not paths.is_within(root, sibling)


@pytest.mark.skipif(
    not paths.is_case_insensitive_filesystem(),
    reason="this filesystem is case-sensitive, so a case variant is a different path",
)
def test_a_case_variant_names_the_same_location_on_a_case_insensitive_filesystem(tmp_path: Path) -> None:
    """The security-relevant direction: a case variant cannot be used to escape.

    If containment folded case the wrong way, `VAULT\\note.md` would look like
    it were outside `vault`, and every deny-list check phrased as containment
    would be bypassable by pressing shift.
    """
    root = tmp_path / "vault"
    (root / "notes").mkdir(parents=True)
    variant = Path(str(root).upper()) / "NOTES"

    assert paths.is_within(root, variant)
    assert paths.is_within_lexical(root, variant)


@pytest.mark.skipif(sys.platform != "win32", reason="8.3 short names are a Windows feature")
def test_an_8_3_short_name_resolves_to_the_same_location(tmp_path: Path) -> None:
    """A short name is a real alias, so containment must see through it."""
    root = tmp_path / "vault directory with a long name"
    (root / "notes").mkdir(parents=True)

    buffer = ctypes.create_unicode_buffer(1024)
    length = ctypes.windll.kernel32.GetShortPathNameW(  # type: ignore[attr-defined]
        ctypes.c_wchar_p(str(root)), buffer, len(buffer)
    )
    if not length or buffer.value == str(root):
        pytest.skip("8.3 short-name generation is disabled on this volume")

    assert paths.is_within(root, Path(buffer.value) / "notes")


def test_a_junction_into_another_tree_is_not_inside_the_root(tmp_path: Path) -> None:
    """`realpath` follows the junction; a lexical comparison would not.

    This is why containment resolves rather than only normalising: a junction
    placed inside the vault is a door out of it, and the lexical answer says
    the door is a wall.
    """
    root = tmp_path / "vault"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    make_reparse_point(root / "door", outside)

    assert paths.is_within_lexical(root, root / "door")
    assert not paths.is_within(root, root / "door")


def test_a_unc_path_is_never_inside_a_local_root(tmp_path: Path) -> None:
    assert not paths.is_within(tmp_path, Path(r"\\server\share\notes"))
    assert paths.is_unc(Path(r"\\server\share"))
    assert not paths.is_unc(tmp_path)


def test_relative_within_refuses_a_path_outside_the_root(tmp_path: Path) -> None:
    root = tmp_path / "vault"
    root.mkdir()
    (tmp_path / "elsewhere").mkdir()

    assert str(paths.relative_within(root, root / "a" / "b.md")) == os.path.join("a", "b.md")
    with pytest.raises(UnsafePathComponentError):
        paths.relative_within(root, tmp_path / "elsewhere")


@pytest.mark.parametrize(
    "component",
    [
        "..",
        ".",
        "",
        "a/b",
        "a\\b",
        "C:",
        "trailing ",
        " leading",
        "trailing.",
        "CON",
        "con.md",
        "LPT1.md",
        "nul",
        "has\x00null",
        "x" * 200,
    ],
)
def test_an_unsafe_name_is_never_joined_onto_the_root(component: str) -> None:
    """Each of these composes into something other than a file in the vault.

    Traversals leave the root; separators smuggle a directory into a name;
    `C:` re-anchors the join; a trailing space or dot is silently stripped by
    Windows so two different names become one file; reserved names are
    devices, not files.
    """
    with pytest.raises(UnsafePathComponentError):
        paths.validate_component(component)


@pytest.mark.parametrize("component", ["note.md", "00 Inbox", "café.md", "a-b_c (2).md", "console.md"])
def test_an_ordinary_name_is_allowed(component: str) -> None:
    """The refusal must not swallow names the owner would reasonably use.

    `console.md` is included deliberately: it starts with `con`, and a
    reserved-name check written as a prefix match rather than an exact one
    would refuse it.
    """
    assert paths.validate_component(component) == component


def test_a_junction_is_detected_as_a_reparse_point_even_though_it_is_not_a_symlink(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    link = tmp_path / "link"
    make_reparse_point(link, target)

    assert paths.is_reparse_point(link)
    assert not paths.is_reparse_point(target)
    assert paths.any_reparse_point(link / "child" / "grandchild")
