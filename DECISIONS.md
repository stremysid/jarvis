# Decisions

- D1 is the authoritative operational store; bootstrap-token hashes are consumed atomically with initial principal and device creation.
- R2 is the archive store.
- Authentication state does not use eventually consistent KV.

## Migration numbering diverges from the Obsidian plan (2026-09-02)

`docs/superpowers/plans/2026-08-30-jarvis-obsidian-memory-implementation.md`
reserves migrations `0008`, `0009` and `0011` for vault state and `0010` for
baseline memory. Those numbers were taken first by the autonomy, decision
queue, project, deadline, liveness and scheduled-run schemas, which are built
and committed.

Renumbering the built migrations would rewrite files that already applied to
the test database and are referenced by name in the test migration list, to
free numbers nothing occupies. The vault migrations take `0014` onward
instead. Migration numbers carry no meaning beyond order, and the plan's file
table is the thing that is now out of date rather than the code.

## The Obsidian adapter ships in two stages (2026-09-02)

The plan's design is one capability -- a vault Jarvis can read, search and add
notes to, confined to its own root and never overwriting a file -- wrapped in
a second layer of Windows-specific hardening: a pinned Rust/PyO3 bridge for
NTFS object identity and namespace fences, USN journal replay, Cloud Files
reparse detection, and VSS-backed backup.

The hardening is not decoration. It is what makes "never replaced a file the
owner wrote" a property rather than a hope, and it is on the critical path for
the release audit. But it is also several times the work of the capability it
protects, and holding the capability back until it lands means the memory
system the rest of the plan depends on does not exist in the meantime.

So the adapter ships first in pure Python against the same contracts, with
write-once enforced by create-new file modes and the vault root checked before
every operation, and the native bridge replaces those checks afterwards
without changing the interface above them. Until it does, the adapter must not
be described as meeting the plan's write-once guarantee -- it meets a weaker
one, and the difference is recorded in KNOWN_ISSUES.md.
