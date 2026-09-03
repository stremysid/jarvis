"""Obsidian vault memory adapter: read the owner's notes, never rewrite them.

The vault is the one memory surface Jarvis does not own. Every byte in it was
written by the owner in another program, so the adapter's entire job is to
observe without disturbing: read what changed, record it immutably, and add
new files without ever replacing one.

This package ships stage one of the design in
`docs/superpowers/plans/2026-08-30-jarvis-obsidian-memory-implementation.md`:
the capability in pure Python. The Rust/PyO3 native bridge, USN journal
replay, VSS-backed backup, and the privileged broker are deliberately absent
rather than stubbed -- a stub would let a reader believe an NTFS handle fence
is holding when nothing is. Every check here that the bridge would have made
into a guarantee is marked in the module that makes it, and the difference is
recorded in KNOWN_ISSUES.md.
"""
