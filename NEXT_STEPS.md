# Next steps

Two tracks are open.

## Local agent (the product gap)

`apps/local-agent` now exists: validated configuration, DPAPI-sealed device
keys, and `jarvis doctor`. That is Task 4 of
`docs/superpowers/plans/2026-08-29-jarvis-telegram-memory-release.md`.

Next: **Task 6 — the append-only content-addressed raw archive**, then Task 7
(local semantic retrieval) and Task 8 (fact provenance and promotion). Task 5
(signed event synchronization) can proceed in parallel.

The Obsidian memory adapter follows, per
`docs/superpowers/plans/2026-08-30-jarvis-obsidian-memory-implementation.md`.
That plan supersedes the Obsidian hard block in the Telegram/memory plan, so
both now execute through the combined graph.

Still unimplemented on this track: Telegram (Tasks 1-3), the named-pipe
service and backup/restore (Task 9), and deployment (Task 10).

## Hermes H1 (the local model runtime)

Tasks 0-9 are complete and on `main`. Task 10 is started: the deterministic
OpenAI compatibility stub is implemented on `codex/hermes-h1-task10`. The
rest of Task 10 installs two Windows services with dedicated accounts and
protected DACLs, and needs an elevated shell.

Tasks 11-13 follow. Note that finishing this track yields a hardened local
model runtime, not a shippable 0.1.0 -- nothing in Tasks 10-13 touches
Telegram, memory, or deployment.
