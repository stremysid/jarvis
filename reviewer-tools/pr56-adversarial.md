# PR #56 — adversarial cross-vendor review (read-only)

**Verdict: changes requested — 1 High, 5 Medium, 9 Low.** The migration is
structurally sound and the suppression boundary is real and provable. Two things
block: the KNOWN_ISSUES entry this slice claims to close is not closed on the
only constructor that exists, and the exhaustive-search completion guard does
not require a walk to have happened.

Scope reviewed: `origin/codex/r2-archive-literal-history` at `7c57d6c`
(implementation `4c2a9ae`), full `origin/main...HEAD` diff.

Method: static reading plus two executable probes. Migration `0025` was applied
with `node:sqlite` (SQLite 3.53.3) over stub parent tables copied from `0001`
and `0016`, and each claim below marked *proved* was produced by running SQL,
not by reading it. Probe scripts:
`scratchpad/pr56/probe.mjs` (14 probes) and `scratchpad/pr56/probe2.mjs`
(6 probes). Anything I could not execute is marked **estimate**.

---

## High

### H1. The archive-history handoff defect is removed from KNOWN_ISSUES but is not fixed on the only wiring that exists

`KNOWN_ISSUES.md:37-42` (deleted lines) removed the "Archive-history handoff"
limit and retitled the section from seven limits to six. The repository change
that is supposed to justify that is real but conditional:

- `apps/cloud-gateway/src/memory/memory-repository.ts:1635-1649` drops the old
  `if (sourceLocation === "live") refuse();`, so a source recorded `live` now
  falls through to the archive lookup.
- `apps/cloud-gateway/src/memory/memory-repository.ts:1692-1710` gives
  `readOwnerTurnText` the same archived fallback.
- Both then call `validateArchivedEventEvidence`, whose **first statement** is
  `apps/cloud-gateway/src/memory/memory-repository.ts:1734`:
  `if (this.archivedEventReader === undefined) refuse();`

The only production constructor never supplies that reader:
`apps/cloud-gateway/src/memory/memory-owner-controls.ts:375` —
`private readonly memory: MemoryRepository = new MemoryRepository(database)`.
`git grep "new MemoryRepository("` over `apps` and `packages` at `7c57d6c`
returns exactly one non-test call site, that one, plus
`createMemoryRepositoryForTest` (`memory-repository.ts:2386`, marked test-only).
Both new tests that prove the fix pass a reader explicitly
(`apps/cloud-gateway/test/memory/memory-repository.test.ts:732` and `:750`).

Scenario: a turn from more than 90 days ago is sealed and purged
(`ArchiveRepository.purgeDelivered` deletes the `events` row,
`apps/cloud-gateway/src/archive/archive-repository.ts:424-429`). Sid then says
"forget that" about the memory built from it. `MemoryOwnerControlsService`,
constructed the only way it can be, reaches `validateReceipt` →
`validateArchivedEventEvidence` → `refuse()`.

Consequence for Sid: old-memory controls still fail. The only change is the
failure code — `memory_refused` instead of `memory_corrupt` — and the record
warning the next slice about it has been deleted, so the Telegram/voice wiring
slice (plan item 4) will inherit a silent refusal with nothing in KNOWN_ISSUES
pointing at it.

Fix: either default `MemoryOwnerControlsService` to a repository built with an
`archivedEventReader` (a `TieredEventReader`/`ArchivalService` over `env.ARCHIVE`,
which this PR already wires in its own tests), or restore the KNOWN_ISSUES entry
narrowed to the truth: the repository supports archived evidence, no composition
supplies the reader yet.

Test that would pin it: construct `new MemoryOwnerControlsService(env.DB)` with
its **default** repository, archive and purge the source event, then assert
`forget` and `lift` succeed. Today that test fails with `memory_refused`.

Partial credit, stated precisely: the *read* half genuinely is fixed and needs
no reader. `canonicalSources` (`memory-repository.ts:2226-2260`) LEFT JOINs
`archive_segment_events` and derives the current location in D1 alone, so
`readCurrentItem` / explain does now report `archived` with the live segment id
after purge. It is the evidence-revalidating paths that still fail closed.

---

## Medium

### M1. The completion guard does not require a walk — only arithmetic consistency

`0025_archive_literal_history.sql:154-180`. The update guard aborts when
`NEW.scanned_event_count <> NEW.checkpoint_event_sequence` (`:168`) and when a
`succeeded` row has `checkpoint <> snapshot` (`:176-177`). It never bounds how
far one statement may move the checkpoint.

Proved (probe 4): with five events and a running job at checkpoint 0, this single
statement is **accepted**:

```sql
UPDATE memory_literal_search_jobs
SET status='succeeded', checkpoint_event_sequence=5, scanned_event_count=5,
    matched_event_count=0, updated_at=?, completed_at=?;
```

Resulting row: `{"status":"succeeded","checkpoint_event_sequence":5,"scanned_event_count":5}`.

The migration test named "rejects completion without scanning the snapshot"
(`apps/cloud-gateway/test/persistence/archive-literal-history-migration.test.ts:110-123`)
aborts only because it leaves `scanned_event_count` at 0. Set it to match and the
forgery passes. The test name overstates what is pinned.

Consequence for Sid: `readExhaustiveSearchResult`
(`apps/cloud-gateway/src/memory/literal-history.ts:755-760`) turns a `succeeded`
job with no receipts into a confident `no_hit` — "I searched your entire history
and it isn't there". The D1 boundary cannot tell that apart from "the checkpoint
was moved without reading anything", so the strongest claim this feature makes is
the one the schema does not defend.

Fix: bind progress to the step ceiling, e.g. add
`OR NEW.checkpoint_event_sequence - OLD.checkpoint_event_sequence > 8` to the
guard (8 is the real per-step maximum; see L5), so completing a long range
requires as many statements as it requires events.

Test: the same forged UPDATE, with `scanned_event_count` set to match, must abort
with `memory_literal_search_job_transition_invalid`.

### M2. `matched_event_count` is never reconciled against the stored receipts

`0025_archive_literal_history.sql:154-180` constrains `matched_event_count` only
relative to `scanned_event_count`. Nothing ties it to rows in
`memory_literal_search_hits`.

Proved (probe 8): an update setting `matched_event_count = 3` is accepted while
the hits table holds 0 rows for that job.

Consequence for Sid: `matchedEventCount` is on the public result type
(`literal-history.ts:113-126`, returned by `runExhaustiveSearchStep` and
`createExhaustiveSearch`), so a caller can report "found 3 matches" from a job
whose receipts can produce none. This is the repository-count/trigger-count
divergence class flagged for this builder family.

Fix: add to the update guard
`OR NEW.matched_event_count <> (SELECT count(*) FROM memory_literal_search_hits
hit WHERE hit.principal_id = NEW.principal_id AND hit.job_id = NEW.job_id)`.
Because the service batches hit inserts *before* the job update
(`literal-history.ts:653-684`), a BEFORE UPDATE trigger sees the correct count.

Test: an update whose matched count exceeds the receipt rows must abort.

### M3. PR #50's N7 is still open, and the new test sits exactly on the hole

`packages/contracts/src/calls.ts:112` still reads
`if (LOWERCASE_ULID.test(text)) return issueSanitizedRedaction(text, []);` —
any text that is *entirely* a canonical ULID skips every redactor, on every
channel including voice.

Proved by running the two regexes from that file against the **exact string the
new test uses**:

| input | canonical ULID? | digits redacted? |
|---|---|---|
| `Reference 01abcde123456fghjkmnpqrstv is not…` | no | yes → `01abcde[REDACTED_AUTH_DIGITS]fghjkmnpqrstv` |
| `01abcde123456fghjkmnpqrstv` (alone) | **yes** | **no — returned verbatim** |

`packages/contracts/test/envelope.test.ts:71-79` adds only the first row. It
documents the boundary of the hole rather than closing it.

This slice extends the blast radius: `historyEvent`
(`literal-history.ts:397-398`) accepts a turn only when
`redactor.redactText(text) === text`, which a ULID-shaped string satisfies by
passthrough. Such a turn is therefore chunked, FTS-indexed and later returned
verbatim as a literal excerpt.

Consequence for Sid: a voice or Telegram turn consisting of one Crockford-shaped
token keeps its six authentication digits in the event ledger and now also in
searchable literal history.

Fix: make the passthrough opt-in at the structural call sites that need it (the
same way `fieldMarker` gates the field-marker branch) rather than a global
whole-text shortcut.

Test: `redacted("01abcde123456fghjkmnpqrstv")` must return
`01abcde[REDACTED_AUTH_DIGITS]fghjkmnpqrstv`.

### M4. A wedged exhaustive job is permanent, and it burns its job key forever

`0025_archive_literal_history.sql:182-186` forbids deleting a job; `:172-175`
makes `succeeded` and `failed` terminal. Nothing in `literal-history.ts` ever
writes `failed`, so the only reachable stuck state is `running`.

Proved: `failed → running` aborts (probe 5a), `succeeded → running` aborts
(probe 5b), `DELETE` aborts and re-inserting the same `job_key` with a new
`job_id` aborts (probe 5c).

Scenario: a step throws before its batch — `events.length === 0 → corrupt()`
(`literal-history.ts:621`), the contiguity check at `:634`, or the text-budget
check at `:639`. The job stays `running`,
`readExhaustiveSearchResult` returns `incomplete` forever (`:703-713`), and
`createExhaustiveSearch` refuses to reissue the key because `existing.jobId !==
jobId` (`:554`).

Consequence for Sid: one bad walk removes that search from his reach permanently,
with no owner path back — the "terminal state with no way out" class.

Fix: let the service record `status='failed'` with a failure code on an
unrecoverable step (the schema already supports it), and let
`createExhaustiveSearch` mint a fresh job for a key whose previous job is
terminal — the unique key needs a generation/attempt column to allow that.

Test: force a corrupt step, assert the job reaches `failed`, then assert a new
search for the same key starts a new job rather than refusing.

### M5. Hit receipts are bound to the principal only while the event is live

`0025_archive_literal_history.sql:204-215`. The live branch requires
`event.subject_id = NEW.principal_id` (`:208`). The archive branch (`:211-214`)
matches on `event_sequence`, `event_id` and `content_hash` only —
`archive_segment_events` carries no subject.

Proved: a hit receipt for an archived event owned by a *different* principal is
**accepted** (probe 6); the same event while still live is rejected with
`memory_literal_search_hit_receipt_invalid` (probe 6b).

The service does re-check `envelope.subjectId !== principalId`
(`literal-history.ts:389-391`), so no text leaks today — this is defence in
depth. But the guard silently loses its principal binding the moment history is
archived, which is precisely when the D1 boundary matters most, and it is the
boundary a future second writer would rely on.

Consequence for Sid: after archival, D1 no longer enforces that literal-history
receipts belong to him.

Fix: carry the subject into the archive tier — an indexed `subject_id` on
`archive_segment_events`, or require a matching
`memory_history_coverage (principal_id, start_event_sequence)` row in the archive
branch of the guard.

Test: pin that the archived cross-principal insert aborts.

---

## Low

### L1. The fast search path has no declared or counted statement budget
`literal-history.ts:481-536`. `searchLiteral` issues roughly
`1 (requirePrincipal) + 1 (FTS) + maxResults × (≤6 tiered read + 1 provenance) +
4 (coverage)` ≈ **62** D1 statements at `maxResults: 8` — **estimate**, arithmetic
from `:492-514`, `:1062-1067`, `:1073-1090`, `:1036-1059`. The exhaustive path
declares and counts 22 (`:34-38`); the interactive path declares nothing.
Fix/test: declare `LITERAL_HISTORY_SEARCH_LIMITS` and count it with the same
`queryCountingDatabase` harness already in the test file.

### L2. A backwards clock wedges indexing
Proved (probe A): `memory_cursors_monotonic_update` rejects an update carrying an
earlier `updated_at`. `indexSequences` takes a bare `nowTimestamp(this.options.now)`
with no floor on the non-refresh path (`literal-history.ts:898`) and uses it for
the cursor write (`:951-955`) — unlike the refresh path and every job write, which
clamp to a floor. Until wall-clock passes the stored cursor time, every
`indexNext` fails as `memory_history_unavailable` and search reports `incomplete`.
Fix: pass `cursor.updatedAt` as the floor. Test: two index steps with a clock that
steps backwards.

### L3. Indexing that races archival aborts the whole batch
Proved (probe B/B2): once `archive_segment_events` holds the sequence, a `'live'`
coverage insert is refused by `memory_history_coverage_insert_guard`; the
`'archived'` row is accepted. `sourceReceipt` (`literal-history.ts:966-985`)
chooses the location before the batch runs, so an event archived inside that
window aborts the batch → `memory_history_unavailable`. Self-healing on retry, so
Low; worth a named test so a later change cannot turn it into a loop.

### L4. Forget cannot remove a hit receipt
Proved (probe 7b): after a suppression lands, the existing receipt survives and
`DELETE` aborts. Reads do filter it (`literal-history.ts:718-726` and
`readProvenance` `:1093`), so no text is returned — but the row permanently
records that a now-forgotten turn matched a query term, keyed by `event_id` and
`content_hash`. Consistent with the append-only suppression ledger; it belongs in
KNOWN_ISSUES rather than being left implicit.

### L5. `MAX_JOB_EVENTS = 16` is unreachable, and nothing drives the walk
`readLimit = min(maxEvents, floor(maxTextBytes / 32768), remaining)`
(`literal-history.ts:614-618`) with `MAX_JOB_TEXT_BYTES / MAX_EVENT_TEXT_BYTES = 8`
(`:28-29`), so a step never advances more than 8 events — which is also what
`LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.eventsExamined` computes (`:36`). A walk
over a long history needs thousands of steps and no scheduler exists. Correct for
an uncomposed slice; say so in NEXT_STEPS so slices 3/4 budget for the driver.

### L6. `memory_history_chunks` has no delete guard
Proved (probe E): a chunk row deletes cleanly. Required by re-index, but it means
chunks can vanish while the immutable coverage row still reads `indexed`, after
which `searchLiteral` returns `no_hit` with "complete" coverage. No other writer
exists today (`git grep memory_history_chunks` over `src` at `7c57d6c` hits only
`0016` and `literal-history.ts`).

### L7. The two source-read paths now mean different things by `sourceLocation`
`canonicalSources` derives the *current* location from the archive catalog
(`memory-repository.ts:2246-2257`); `inspectReplay` hard-codes
`NULL AS current_r2_segment_id` (`:1874-1878`) and compares the *stored* value.
Both are correct for their purpose — replay identity must compare stored bytes —
but the divergence is unmarked and invites a later "consistency fix" that breaks
replay detection. Add a comment.

### L8. `KNOWN_ISSUES.md` lost a blank line
The deletion left `## PR #46 notification delivery retains three bounded
at-least-once limits` directly abutting the preceding list item.

### L9. Job progress does not re-check the principal
Proved (probe 12): after the owner principal is set to `disabled`, the job still
transitions `pending → running` and hit receipts still insert. Only the insert
guard checks `principal_type='human' AND status='active'`
(`0025_archive_literal_history.sql:144-149`). The service re-checks via
`requirePrincipal` on every entry point (`literal-history.ts:778-785`), so this is
defence in depth only.

---

## Checked and sound

Everything here was verified, most of it by execution.

**Migration form.** Every trigger in `0025` is
`WHEN … BEGIN SELECT RAISE(ABORT, …) END` — no `CASE … RAISE` anywhere. The file
applies cleanly in SQLite 3.53.3 and installs exactly the six named triggers plus
the replaced chunk guard. `remote-d1-migration-syntax.test.ts:49` adds `0025` to
the discovery list, so the repo-wide CASE-RAISE assertion now covers it.

**Foreign keys.** `PRAGMA foreign_key_check` returns `[]` after applying `0025`
over stub parents with `foreign_keys = ON` (probe 14). The composite FK
`memory_literal_search_hits(principal_id, job_id) → memory_literal_search_jobs`
has the `UNIQUE (principal_id, job_id)` parent index SQLite requires, and both
new FKs are `ON DELETE RESTRICT`, consistent with the archival tables.

**Unique-key coverage on both WITHOUT ROWID tables.** Jobs: PK `job_id` and
`UNIQUE (principal_id, job_key)` are both covered by the insert guard (`:129-133`);
`UNIQUE (principal_id, job_id)` is implied by the PK. Hits: both
`PRIMARY KEY (principal_id, job_id, event_sequence)` and
`UNIQUE (principal_id, job_id, event_id)` are covered (`:190-195`).
`INSERT OR REPLACE` and `OR IGNORE` abort rather than delete — proved for hits
(probe 10, row count unchanged at 1) and by the PR's own tests for jobs and for
every `memory_history_chunks` rowid alias.

**Receipt integrity.** A hit is accepted only while its job is `running`, only for
`checkpoint < sequence ≤ snapshot` (probe 11 rejects both `pending` and
`succeeded` jobs), and only with a `content_hash` matching a live or archived tier
(probe D rejects a wrong hash). Hits are immutable and undeletable (the PR's
tests, plus probe 7b).

**Suppression really is a storage boundary, not just a filter.** Target-based
(probe 7) and range-based (probe C) active suppressions both abort hit inserts; a
lift re-enables the insert (probe 7). The rewritten
`memory_history_chunks_insert_guard` (`:85-125`) blocks a chunk whose range covers
a suppressed event that now exists *only* in `archive_segment_events` (probe 9) —
the case the `0016` guard could not see at all, since it had no suppression clause.
Operator precedence in the range/target clause (`:111-121`) parses as
`(overlap AND overlap) OR target IN (...)`, which is what is intended.

**Snapshot ceiling.** `snapshot_event_sequence` is capped at
`MAX(sealed_through, max(events.sequence))` (`:140-143`), so a job cannot claim a
range past the ledger (probe 2a rejects), can claim exactly the tip (2b), and
still works when every event has been purged and only `sealed_through` remains
(2c). Jobs for non-human or inactive principals are refused (probe 3).

**State machine.** Checkpoints and counts are monotonic; `succeeded` and `failed`
are genuinely terminal (probes 5a, 5b); the PR's backwards-checkpoint test is
correct. Aside from M1, the transition set is right.

**Archive-completeness mechanics.** Coverage is re-derived from stored rows rather
than asserted: `readMaintenance` (`literal-history.ts:803-856`) rebuilds the work
list by joining `memory_history_coverage` against the suppression ledger and the
archive catalog, and `coverageStatus` (`:1032-1060`) names an exact missing range
instead of returning a bare no-hit. Gaps at archive boundaries are detected:
`indexSequences` clamps each step to one manifest and aborts if the next manifest
does not start at `afterSequence + 1` (`:870-876`), and `TieredEventReader`
enforces contiguity across the tier join. Concurrent archival is caught by reading
`archive_state` before and after and refusing if `sealedThrough` moved
(`:866`, `:879-880`). Corrupt R2 bytes fail the walk without advancing the cursor
(the PR's garnet test). The maintenance loop terminates rather than spinning:
the refresh writes `indexed_at = max(now, changedAt)`, which makes the
`HAVING indexed_at < changed_at` clause false on the next pass.

**Untrusted input.** Archived and live content is treated as data throughout:
`historyEvent` (`:381-409`) re-validates the envelope, its sequence, subject,
source, producer version, exact payload key set, and requires the stored text to
be redaction-clean before it is indexed. No archived text can authorize anything;
only `principals` rows and the suppression ledger gate writes.

**Bounded excerpts.** `exactExcerpt` (`:348-368`) caps at 1,024 bytes, keeps the
matched token inside the window, and handles surrogate pairs on both edges — the
shrink loops terminate at the matched token, which cannot itself split a pair
because the match comes from a `\p{L}\p{N}` code-point scan. The PR's multibyte
test covers it.

**Error surface.** `safely()` (`:769-776`) normalizes every non-`LiteralHistoryError`
into `memory_history_unavailable`, so no raw D1 or archive exception escapes, and
no error message carries event text. `TIERED_READ_D1_STATEMENT_CEILING = 6` is a
sound upper bound for a tiered read: `readArchivedRange` issues at most
`readState + listManifests + readCoverageRange` D1 statements regardless of how
many segments the range spans (segment bytes come from R2, not D1), plus the live
read and the bracketing state read. The uncounted R2 GETs (up to two per step) are
outside every declared budget — worth noting when this is scheduled.

**No composition, so nothing can break an ordinary reply today.**
`LiteralHistoryService` has no caller anywhere in `apps` or `packages`;
`MemoryOwnerControlsService` has no caller; `apps/cloud-gateway/src/index.ts`
imports nothing from `memory/`. No change under `voice/**`, `calls/**`, no
Vectorize, no `D1ContextRetriever`, no paid-model path.

**Migration numbering and open PRs.** No collision: `0023_study_coach.sql` is on
PR #53's branch, `0024_university_application_workflow.sql` is on PR #52's, and
`0025` is free on both. All three branches touch
`apps/cloud-gateway/test/persistence/migration.ts` and
`remote-d1-migration-syntax.test.ts`, each adding one import, one helper and one
list entry. Textual merge conflicts are near-certain for whichever merges second;
semantic conflicts are not — the helpers chain off different bases
(`applyMemoryIngressMigration` here, the school chain there) and touch disjoint
tables. `NEXT_STEPS.md` and `docs/HANDOFF.md` are updated correctly and now name
all three reservations.

**Scope matches the plan.** `docs/plan/2026-09-15-r2-memory-runtime-slices.md`
section 3 item 2 asks for exactly this: bounded chunks and FTS coverage over live
D1 plus every verified R2 segment, suppression applied before text enters a
result, a no-hit answer only with complete coverage, an exact missing range
otherwise, and a checkpointed exhaustive job — with no Vectorize and no paid
model. All present.

**F1 (PR #50 follow-up) is partly addressed.**
`apps/cloud-gateway/test/memory/memory-owner-controls.test.ts:262-279` now pins
that `readAcceptedOwnerTurn` refuses a genuinely valid owner command whose
`causationId` names a different turn, and asserts no item was created. It does not
pin the `operation = 'item.transition'` clause or `memory_valid_owner_commands`
membership (`memory-repository.ts:1091-1099`), so one more case would finish it —
but the follow-up is no longer unpinned.
