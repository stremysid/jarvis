# PR #61 round-2 adversarial re-review at 4d99d15 (fix 652bc64)

**Verdict: changes requested (small).** New findings: 0 High, 1 Medium, 1 Low. Of the round-1 items, H1, M1, M2, M3 and L2 are fixed. H2, L1 and L3 are partial.

**How I tested.** I copied the round-2 `school-observation-repository.ts`, `classroom-observation-sync.ts`, `digest-composer.ts`, `digest-types.ts` and `0027` into `scratchpad/pr61b/rt/`. The only edits were import paths. They run on the same node:sqlite D1 stand-in, which has the real `0001`, `0011` and round-2 `0027` applied with every trigger live. Digest lines below are the real composer's output in America/Toronto. I did not touch the repo.

## Round-1 items

| Item | Status | Evidence |
|---|---|---|
| H1: handed-in work still reported missing | **FIXED** | `scenarioA2.ts`: the round-1 false line is gone at 04:05. After a correct claim, Sid turns in late. The line disappears as soon as a scan re-reads the item (07:05, next scan mid-way) and stays gone when derivation then fails (08:05). `scenarioC2.ts`: 100 items turned in, then a digest after derivation page 1 of 2 shows **0** missing lines (round 1 showed 20). The fix is the digest query's check on the current submission state (`school-observation-repository.ts:764`). |
| H2: read before the deadline used as evidence | **PARTIAL** | Derivation and trigger are fixed. `scenarioE.ts`: a read 1 ms before the deadline gives `not_due` or silence. A read exactly at due_at is accepted by both the repository and the trigger, which is sound: `last_seen_at` is the run's start, so the actual fetch happened at or after the deadline. Deadline moved earlier after the read: derived correctly. Moved later: silent. The trigger clause is pinned (`mutclause.ts`: the new migration test's insert is **accepted** once the clause is removed). **But the digest never re-checks read time against the current deadline.** See N1. |
| M1: replay wedge | **FIXED** | `scenarioB2.ts`: a lost `completeDerivation`, or a batch that commits while the Worker sees an error, followed by a due-date edit, gives **72/72 hourly runs complete** with the quiz seen as `turned_in`. `scenarioB2c.ts` (75 deadlines, lost `saveDerivationCheckpoint`, edits on both derivation pages) also finishes 72/72. |
| M1: 24h derivation reset | **FIXED, sound** | `scenarioF.ts`: derivation kept failing. It showed 24 visible `school_observation_sync_failed`, then `classroom_observation_derivation_checkpoint_stale` at 25h, and recovered on the next cycle. No transitions were deleted. Turned-in items never showed during the outage or after the reset. Surviving lines carried their real read time. The reset could only livelock a sweep with more than 1,536 observed deadlines (64/h x 24h), which is not realistic with ACTIVE courses only. |
| M2: raw UTC in digest lines | **FIXED** | `scenarioM2.ts`: `2026-09-16T03:59:59.999Z` gives `2026-09-15 23:59 local`, and midnight gives `00:00` (not `24:00`). Oct 31 23:59 EDT, Nov 1 23:59 EST and 14 Mar 2027 all render correctly. No ISO string remains in the section. Cosmetic only: "local" does not name the zone, and the repeated 01:00–01:59 hour on 1 Nov prints the same both times. |
| M3: rules without tests | **FIXED** (one gap, N2) | By reading, each new test fails if its rule is deleted. Sync `:219` catches a missing resume, a hard-coded null next page or a lost checkpoint (first run becomes `complete`, or the second run becomes `partial`). Sync `:167` catches a scan that completes after one course (pages 1). Digest-job `:468` and `:481` catch the never-scanned and stale gaps. Repository `:322` catches deletion of `d.due_at <= ?`. Repository `:227` catches deletion of the state re-check. Repository `:288` catches deletion of `already_derived` (the trigger throws). Repository `:259` catches deletion of the repository H2 rule (the trigger throws). Sync `:378` catches deletion of the age check. |
| L1: silent 20-item cap | **PARTIAL** | `scenarioC2.ts`: 100 overdue items give exactly 20 lines, newest first, with no "+N more". `KNOWN_ISSUES.md` does not record the cap. |
| L2: derivation walks every deadline | **FIXED** | `scenarioC2.ts`: with 40 extra never-observed deadlines, the 100 observed ones still derive in exactly 64 + 36 (so the 40 were not walked), and all 100 re-derive to `submission_seen`. `scenarioB2c.ts`: all 75 are derived and none is skipped. `already_derived` plus a page that always advances means nothing is re-derived forever. |
| L3: rejected rows invisible | **PARTIAL** | The count is now in the poll detail (`job-table.ts:84`). By reading, it adds routine rejections to the id-change case. Every submission for undated coursework, which has no deadline row, is counted (`school-observation-repository.ts:503-510`). So the number is normally non-zero, and a recreated submission that is ignored forever (`:554-557`) cannot be told apart. The only test (`classroom-poll-job.test.ts:118`) formats a hand-built result. `KNOWN_ISSUES.md` does not record the permanent ignore. |

## New findings

### N1 (Medium). Moving a deadline later still lets the digest say "no submission" based on a read taken before the new deadline
**Where:**
- `school-observation-repository.ts:745-775`: the missing-work query checks `d.due_at <= now` and the current state, but never checks `basis.last_seen_at >= d.due_at`.
- `:681-692`: when a pre-deadline read makes `desired` null, derivation `continue`s. An older `no_submission_seen` then stays the latest transition, with the old `basis_due_at`.

**Proven:** `scenarioD.ts`, real code, 8 courses x 50 items (a scan cycle of about 11h). A correct "no submission" claim exists for an essay. The teacher then extends the deadline to a time that passes before the next read of that course, and Sid submits 30 minutes before the new deadline.
- **12 of 48** extension timings printed a false line, for up to **9 consecutive hourly digests**. Example at 20:05 local: `[derived: Google Classroom showed no submission as of 2026-09-16 18:00 local] English: Essay (deadline passed 2026-09-16 20:00 local)`, while Sid turned it in at 19:30.
- `scenarioD-small.ts` (4 courses x 25): **10 of 60** timings, up to 2 digests.
- Candidate fix checked in `scratchpad/pr61b/fixcheck/`: adding `AND basis.last_seen_at >= d.due_at` to the digest query gives **0/48**, and `scenarioC2` output is unchanged.

**Effect for Sid:** a teacher gives the class a same-day extension, Sid hands in on time, and Jarvis tells him Classroom showed no submission for a deadline that had not yet passed when Classroom was checked. It lasts until that course is read again.

**Fix:**
- Add `AND basis.last_seen_at >= d.due_at` to the missing-work query.
- Add a repository test: derive `no_submission_seen`, move the due date later but still before `now` and after the read, expect `[]`.

### N2 (Low). No test pins the new "as of" stamp to the read time
**Where:** every missing-work `lastSeenAt` assertion uses a read time equal to the scan completion time: repository test `:190` and `:460`, sync test `:275`.
**Proven:** by reading. Reverting `basis.last_seen_at` to round 1's `sync.last_success_at` would pass every test.
**Effect for Sid:** if it regressed, the line would again look up to 24 hours fresher than the evidence behind it.
**Fix:** one repository test where the observation is read at T1 and the scan completes at T2 > T1, expecting `lastSeenAt = T1`.

## Checked and sound
- **Repository and trigger agree** on `no_submission_seen` and `not_due` (same state set, `>=` on both sides, same `derivation_started_at`, current `due_at`), so the fix adds no persistent insert rejection (by reading; E1–E7 all `complete`).
- **D1 budget:** worst run used 280 of 320 statements (`scenarioC2`). The derivation query gained one bind parameter and no statement.
- **Remote-D1 form:** `0027` has 0 `CASE`, and the changed trigger still ends `SELECT RAISE(ABORT, ...)` with the new clause inside `WHEN`. No `OR REPLACE`, `OR IGNORE` or `ON CONFLICT` in `0027`, the repository or the sync. The `CASE WHEN ? = 1` uses in `recordFailure` are value expressions in an UPDATE.
- **Scope:** fix commit `652bc64` touches 14 files, none under `voice/**`, `calls/**`, the retriever or `production-runtime.ts`. The application-items and #52 `KNOWN_ISSUES` hunks in `fix.diff` come from main merge `067959f`, not the fix. No other consumer of the renamed `derivedAt` exists.
- **Nothing invented:** lines carry only the stored `due_at`, `assigned_grade`, course, title and read time.

## Unverified
- **Test suites:** vitest was not run here. I relied on the builder's 3,757 pass and my node:sqlite harness, not Miniflare or remote D1 (`EXISTS` returning a JS number is reasoned).
- **Workers time zones:** Workers `Intl` time-zone data versus Node ICU for `localTimestamp`.
- **Teacher courses (carried over from round 1):** whether `userId=me` errors on courses where Sid is a teacher.
- **Shared page tokens (pre-existing, not in the fix diff):** `seenPageTokens` is shared across all courses in one run (`classroom-observation-sync.ts:192-193`). Two courses returning the same token would fail the run as `classroom_pagination_unbounded`. My first scenarioD draft hit this with synthetic tokens. Real Google tokens are opaque and probably unique.

## Scratch files (`scratchpad/pr61b/rt/`)
- **H1:** `scenarioA2.ts`, `scenarioC2.ts` (also L1, L2, budget).
- **M1 and the reset:** `scenarioB2.ts`, `scenarioB2c.ts`, `scenarioF.ts`.
- **H2 edges and trigger pin:** `scenarioE.ts`, `mutclause.ts` (with `pr61b/0027-noclause.sql`).
- **N1:** `scenarioD.ts`, `scenarioD-small.ts`, and `pr61b/fixcheck/` (the candidate fix).
- **M2:** `scenarioM2.ts`.
- **Shared:** `helpers.ts` (real composer), `d1shim.ts`.
