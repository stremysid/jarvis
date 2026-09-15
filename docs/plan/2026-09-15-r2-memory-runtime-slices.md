# R2 cloud-memory runtime slices after `0019`

**Status:** proposed build order for Claude review. The schema and ingress
foundations are merged, but no R2 cloud-memory migration has been applied and
no new runtime writer is enabled.

## 1. Current baseline

`origin/main` at `f0bfbe9` contains:

- the storage-independent extraction policy, uncertainty rules, topic-tree
  reducer and offline evaluator from PRs #35 and #38;
- the approved D1-authoritative design from PR #36;
- additive migration `0016_cloud_memory.sql` from PR #39; and
- the guarded `memory.owner_command` ingress and topic-event recency bound in
  `0019_memory_ingress.sql` from PR #42.

Main therefore owns migration names through `0019`. They are merged source,
not proof of a live apply. Migrations `0016` through `0019` remain behind the
reviewed, Sid-attended scratch remote-D1 proof and Sid's separate production
approval.

The planning audit on 2026-09-15 found no open GitHub PRs. It also inspected
the migration tree and newest `docs/AGENT_LOG.md` entry on every unmerged
remote branch; none contains or reserves `0020`. The two school branches that
could have needed the number are already merged and contain no `0020`.
This plan reserves no migration. Any later slice that needs one repeats the
open-PR branch and mailbox audit immediately before choosing a number.

## 2. Next slice: canonical memory runtime foundation

Build one bounded code PR that gives the reviewed `0016` schema its first
canonical runtime repository. It does not expose a partial memory product to
Telegram or calls yet.

This slice comes first because automatic distillation, full-history recall,
plain-speech owner controls and voice retrieval must all share the same atomic
item writes, canonical reads and topic resolution. Building separate channel
implementations first would duplicate the authority boundary and let their
behavior drift.

### 2.1 Scope

Add a D1 repository that:

1. validates every row read from the memory tables before returning it;
2. bootstraps exactly one principal-scoped root and one explicit
   `Inbox / Needs filing` child through rules-authored topic events, with
   idempotent conflict handling;
3. commits one item, version, exact sources, initial lifecycle transition and
   initial primary placement as one D1 batch;
4. makes exact replay idempotent and rejects the same item or version identity
   with different material;
5. reads the canonical current item, lifecycle state, verified sources and live
   topic path without trusting caller-supplied denormalized fields;
6. resolves a current active topic path before consulting newest historical
   aliases, then follows bounded merge redirects;
7. obtains transition, topic-event and placement timestamps immediately
   before each write and obtains fresh timestamps for retries;
8. scopes every read and write to the authenticated principal; and
9. returns stable, non-secret failure codes so later services and channel
   adapters can explain unavailable, ambiguous and refused outcomes without
   exposing D1 text or exception details.

This repository exposes memory operations, not channel syntax. Later services
phrase owner actions as ordinary intents—remember this, explain why, forget
this and use this again. A channel adapter may keep slash spellings as an
undocumented compatibility fallback, but this foundation does not teach or
depend on them.

### 2.2 Expected files

New runtime files:

- `apps/cloud-gateway/src/memory/memory-types.ts`
- `apps/cloud-gateway/src/memory/memory-repository.ts`

New focused tests:

- `apps/cloud-gateway/test/memory/memory-repository.test.ts`
- `apps/cloud-gateway/test/memory/memory-repository-faults.test.ts`

`apps/cloud-gateway/src/persistence/transaction.ts` and its existing test may
change only if the current D1 batch seam cannot express the reviewed atomic
item write. The builder records that need in `docs/AGENT_LOG.md` before
expanding the file list. The PR updates
`NEXT_STEPS.md`, `docs/HANDOFF.md` and the mailbox with the evidence it actually
establishes.

### 2.3 Migration need

None. This slice consumes the merged `0016` tables and `0019` ingress guards.
It must not add, renumber or edit a migration. If implementation discovers a
schema gap, stop this slice and return with the exact gap; do not silently
claim `0020` inside the runtime PR.

Because the new repository is not composed into a channel or scheduled job, the
production Worker can still run before `0016` is applied. Activation belongs
to later reviewed slices after the scratch proof and owner migration apply.

### 2.4 Focused tests and mutations

Use isolated D1 databases migrated through `0019`. While iterating, run only
the two memory repository test files with failures-only output.

The tests must prove:

- root and inbox bootstrap is idempotent and cannot produce a second root or
  duplicate active sibling, including a raced retry;
- an item, version, exact sources, initial transition and primary placement
  either all commit or none do;
- an exact replay is idempotent, while the same id with different operands is
  refused;
- a partial D1 failure cannot leave an item, version, transition or placement
  without the rest of its batch;
- canonical reads reproduce the stored lifecycle, uncertainty, sources and
  current topic path from guarded tables;
- current active paths beat aliases, repeated rename aliases resolve newest
  first, and redirects are bounded;
- row-shape, timestamp, hash and principal mismatches fail closed; and
- repository errors produce stable safe outcomes rather than raw D1 text.

Before the implementation PR is posted ready, plant and restore targeted
faults that remove the principal filter, source-event validation,
current-path-first lookup, retry re-stamping, root/inbox uniqueness handling and
transactional coupling. Each fault must make its named test fail. Record the
faults and restored file identity in `docs/AGENT_LOG.md`.

The final local gate is:

1. focused memory runtime tests;
2. `pnpm.cmd lint`;
3. `pnpm.cmd typecheck`;
4. one fresh full `pnpm.cmd test` run;
5. `git diff --check`; and
6. full review of `origin/main...HEAD`.

The applicable `claude/reviewer-tools` checklist is the memory-contract review
against the R2 design and `DECISIONS.md`, plus the repository fault probes
above. REPLACE/IGNORE sweeps and trigger-removal checks are not applicable
because this slice changes no schema; any migration change makes them mandatory
and is also a scope stop.

### 2.5 Exit criteria

The PR is ready for independent Claude review only when all of these are true:

- one migrated test database can bootstrap its root/inbox, atomically commit a
  memory item and read its canonical state, sources and current topic path;
- fault tests prove no partial item, transition, source or placement survives a
  failed batch;
- principal isolation, source validation, topic resolution and retry timestamps
  are each pinned by a test that fails when its guard is removed;
- no source under `voice/**`, `calls/**`, Telegram, scheduler, provider,
  Vectorize or archive indexing changed;
- no migration, provider call, secret operation, deployment or live database
  action occurred; and
- local pass and independent review are reported separately from later live
  acceptance.

This exit does **not** claim that memory is automatic, that archived history is
searchable, that Telegram or calls understand the intents, or that production
has the schema. Those are explicit later slices.

## 3. Remaining R2 slices in dependency order

Each numbered item is its own PR and stays in the same builder chat through
its review-fix rounds. A fresh chat starts only after the PR merges.

1. **Channel-neutral owner controls and receipts.** Build the service that
   creates exact `memory.owner_command` events and uses the canonical
   repository to remember, explain, forget and lift. Forget appends the item
   transition and every whole-turn suppression atomically, with counts
   recomputed from canonical rows. Explanations are deterministic. Ambiguous
   targets refuse without changing state. This slice still has no Telegram or
   voice adapter.
2. **Archive-complete literal history and coverage.** Build bounded history
   chunks and FTS coverage from live D1 events and every verified R2 archive
   segment. Apply active suppressions before text enters a result. A no-hit
   answer is allowed only with complete coverage; otherwise Jarvis names the
   missing range. Add the checkpointed exhaustive-search job. No Vectorize or
   paid model is required.
3. **Automatic distillation and filing.** Wire the hourly Workflow through the
   tiered reader, existing extraction policy and the canonical repository.
   Validate exact sources, classify evidence in code, file low-confidence
   items into the explicit inbox, advance the cursor only after the item batch,
   and make budget/provider failures visible without blocking raw retention.
   Use a fake provider for implementation. The reviewed paid comparison may run
   as soon as Sid separately approves its bounded spend; it does not wait for
   slice 8.
4. **Unified Telegram text recall and plain-speech controls.** Add a new
   memory-aware retriever and compose it only in the Telegram path in
   `apps/cloud-gateway/src/index.ts`, replacing the historical device projection
   there with eligible `0016` items plus live/R2 history. Add subtree area
   questions and deterministic evidence receipts. Do not change
   `D1ContextRetriever` or the composition in
   `apps/cloud-gateway/src/voice/production-runtime.ts`; calls keep their current
   retrieval behavior until slice 7.

   Only the authenticated owner's own current Telegram turn can trigger a
   control. Forwarded, quoted or pasted content, attachments, retrieved memory,
   model or tool output, and every guest message remain untrusted data and never
   trigger one. Route a clear memory request such as “remember that …”, “why do
   you think that?”, “forget that memory” or “use that memory again” before the
   model. “Forget that” meaning “never mind” remains conversation, not a control.
   Ambiguous memory targets ask a plain-language follow-up and do not mutate.
   Each applied control returns a one-line plain-language receipt that names
   the change, gives the ordinary way to undo it, and contains no hidden text.
   Slash forms remain absent from help and onboarding.

   Focused tests prove that forwarded or quoted control-like wording,
   conversational “forget that”, and guest wording do not mutate; one exact
   current-owner request mutates exactly once and returns a one-line receipt
   with its ordinary undo phrasing and no hidden text.
   Slice exit requires `voice/production-runtime.ts` composition and the shared
   `D1ContextRetriever` behavior to remain unchanged, with their existing tests
   passing unchanged.
5. **Meaning search and rebuild.** Add Workers AI `bge-m3` indexing,
   mutation receipts, D1 state rechecks, model-specific rebuilds and atomic
   index swap after coverage verification. Literal and recent-context fallback
   remains available while vectors lag or fail.
6. **Nightly backup and automatic restore drill.** Implement the custom
   logical export and verified manifest without `wrangler d1 export`. After Sid
   performs the one-time reviewed scratch-target setup, schedule the restore
   drill automatically. Successful drills stay quiet and remain visible in
   status; only failure or required repair alerts Sid. Production restore is a
   separate destructive owner operation.
7. **Voice integration.** Reuse the same recall and ordinary-language control
   services after owner step-up, with the shared 750 ms retrieval timeout and
   no exhaustive archive walk before first audio. The onboarding-call interview
   writes each accepted answer through the same remember path as a `stated`
   item; it does not introduce a voice-specific memory writer. Before any edit
   under
   `apps/cloud-gateway/src/voice/**` or `calls/**`, post the intended files and
   behavior in `docs/AGENT_LOG.md` and wait for the calling lane to coordinate.
8. **Rollout and live acceptance.** Configure a provider only after a reviewed
   comparison result is available and Sid selects its cap; the comparison may
   have run after any earlier slice once Sid approved its bounded spend.
   Complete the scratch remote-D1 proof, and leave migration, deployment and
   secrets to Sid. Then run the all-PCs-off exit test, including automatic
   recall, plain-speech controls, archived small-detail recall, uncertainty,
   hide/lift, backup status and the unchanged voice latency gate.

The optional one-way Obsidian-format export remains outside R2.

## 4. Boundaries for every slice

- Keep accepted conversation history independent of importance; archive
  segments remain part of explicit search coverage.
- Treat all retrieved text as quoted untrusted data, never authority.
- Do not weaken uncertainty labels or let inferred memory authorize actions.
- Do not require Sid to learn commands, curate memory, or perform recurring
  restore chores.
- Never merge, deploy, apply migrations, touch secrets, run paid providers or
  perform live calls from a builder PR.
- Keep `LOCAL PASS`, independent Claude review and `LIVE ACCEPTANCE REQUIRED`
  as separate gates.
