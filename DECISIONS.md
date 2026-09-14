# Decisions

- D1 is the authoritative operational store; bootstrap-token hashes are consumed atomically with initial principal and device creation.
- R2 is the archive store.
- Authentication state does not use eventually consistent KV.

## R2 cloud memory direction and corrected attribution (2026-09-14, delegated design decision)

Sid's requirement is the outcome: Jarvis keeps every accepted conversation,
automatically remembers what matters, can recall even small unimportant details
by searching full history including R2 archives, and labels guesses as uncertain
rather than presenting them as facts or instructions. Memory must work from the
phone with every PC off.

The small Linux home node recorded below and in the 3 September roadmap was a
planning-session implementation choice that Sid never made. He owns no Linux
host and did not authorize one. The home-node plan and runbook are historical;
keep their code and documentation for provenance, but do not provision, port,
deploy or make R2/R3 depend on that node.

Sid asked for the best cloud memory and delegated the design. The reviewer
recorded the decision at `951675e`: **D1 is authoritative** for the conversation
ledger, versioned memory items, receipts and topic tree. D1 FTS5 and Vectorize
are rebuildable search indexes; Workers AI `bge-m3` supplies embeddings. Live
D1 events plus verified R2 archive segments remain the complete conversation
record.

Obsidian is not the memory store and is not built in R2. The ledger and topic
tree stay compatible with a later optional **one-way** Obsidian-format Markdown
export: folders mirror areas, stable block ids identify memory lines, and
guesses have a separate section. An export is never read back into memory or
prompts. Sid later approved a private GitHub repository as the destination for
that future copy, excluding health, money, passwords and credentials, and other
people's personal details through tested category rules. That approval does not
authorize building the exporter in R2, creating the repository, installing an
app, supplying a token, buying a plan or making a live push; Sid performs the
single-repository access step only after the exporter is separately reviewed.

The 2026-08-30 Obsidian spec and its rejection of a read-only export assumed
Sid wanted a notes interface he could edit. That premise was never confirmed
with him. The 3 September git-backed editable-vault entry below repeated the
same unconfirmed attribution. Both are **superseded as product decisions** by
the D1-authoritative design; retain their documents and code only as historical
work. Do not describe either choice as Sid's decision.

D1 must support the topic tree Sid requested: areas, sub-areas and deeper
levels; automatic filing; reversible rename, move and merge history; subtree
answers; and full-history search independent of filing. Migration number
`0016` remains reserved for the later reviewed schema PR; no migration is
created or authorized by this documentation decision.
The extraction model is configurable and starts with `deepseek-v4-pro`. Before
finalizing it, compare the same sanitized conversations with
`deepseek-v4.1-flash`; extraction quality decides, and a paid comparison needs
Sid's explicit OK. Memory-model spend has a configurable hard monthly cap of
USD 5.00 by default, and reprocessing older conversations is owner-triggered
and bounded.

## Capacity admission stops at the configured limit (2026-09-13, owner decision)

The owner does not enable provider auto-recharge. Voice calls and turns may
continue until a fresh capacity report reaches 100% of any configured D1, R2,
model or Twilio limit, or until a provider refuses the request. This is **stop
at the configured limit or provider refusal**, not a reserved-spend guarantee.
An admitted call can end mid-conversation when credit runs out. Actual usage
can exceed the last accepted report because interrupted and concurrent requests,
reporting delay and other consumers can still add charges.

Keep `CapacityEstimate` unchanged: prepaid providers use the configured
allocation as `budget` and allocation minus remaining credit as `used`;
postpaid providers use an owner-configured cap and provider-reported spending.
These are different observation types normalized for the same threshold test,
not a reconstructed charge ledger. Reject failed, incomplete, malformed or
stale observations. Monetary configuration has no source-code default.

Only voice calls and voice turns use this capacity gate. Telegram text and
`/sync/distill` do not. Every measured resource emits best-effort owner
Telegram warnings at 85% and 95% of its configured limit. Failed and leased
sends retry through the existing durable receipt path but never decide
admission. A resource that falls below a threshold rearms that crossing.
There is no 70% warning, separate $1 DeepSeek notice, reserve margin, provider
switch, top-up accounting or new metering product in R1. Existing
watchdog/Telegram delivery remains the alert channel.

## Historical migration numbering divergence (2026-09-02; superseded for R2)

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

This remains an explanation of existing files, not the current cloud-memory
plan. R2's new D1 ledger keeps the separately reserved migration number `0016`.

## The Obsidian adapter shipped in two stages (2026-09-02; historical)

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

The 2026-09-14 D1 decision supersedes this as an R2 direction. Keep the adapter
and its tests for provenance; do not resume the native bridge or make local
vault state part of cloud memory.

## Planning-session record from 2026-09-03 (unconfirmed and superseded in part)

Recorded from a planning session; the reasoning is in
`docs/plan/2026-09-03-jarvis-roadmap.md`, section 5. The Linux home node and
git-backed editable Obsidian implementation in this historical list were
planning choices, not choices Sid made. The 2026-09-14 decision above
supersedes both.

- **Phone first, PC optional.** Jarvis must work from the iPhone with every
  computer off. Everything not tied to a machine runs in the cloud: the
  gateway and watchdog, plus one small always-on server (the home node) for
  Hermes and the memory work. The laptop, home gaming PC and St. Remy office
  PC run thin device agents and are optional.
- **Hermes is the hands, not a caged sidecar and not a replacement.** It runs
  on the home node with tools, browser, skills and cron; the Cloudflare
  gateway stays the front door; the Codex sidecar plan is retired.
- **Models.** DeepSeek until the prepaid balance is spent, then Opus 5 or
  GPT-5.6 Terra for reasoning with GPT-5.6 Luna for cheap high-volume work,
  routed per task.
- **Memory and Obsidian — unconfirmed, superseded.** This planning session
  recorded an editable git-backed vault without confirming that Sid wanted to
  edit notes. D1 is now the source of truth; only a later optional one-way
  export may mirror the topic tree, and it is not part of R2.
- **Calling is in the first release.** The Twilio number and credentials
  already exist.
- **St. Remy is no longer off limits.** Full control of the office PC and all
  St. Remy systems on Sid's command, with a tap for anything touching
  production, money or other people. This overrules the builder prompt's
  rule. The office PC runs only the thin device agent.
- **Send on command.** Email, texts from Jarvis's number, and an iMessage
  handoff, with read-back and a confirm before anyone else is contacted.

## 2026-09-11

- **The gateway heartbeat is deferred to the end of the project.** It has
  failed every cron since deployment with a 404 from the watchdog, and
  diagnosing it further was consuming more attention than it is worth. Sid's
  call, and the right one: the watchdog is inherited scope from an earlier
  plan rather than something he asked for, its own health is fine, and it has
  already proved it can reach his phone. **It is removed from R0's exit test**
  so it cannot block R1. Fix it once Jarvis is finished.

