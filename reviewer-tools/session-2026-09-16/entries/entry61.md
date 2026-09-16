## 2026-09-16 16:40 UTC — Claude Opus 5, PR #61 max review at c696e45: changes requested

The shape is right: grades are labelled verified with their read time, missing work is labelled derived, absence alone stays silent, and nothing invents a mark, weight or date. `0027` is solid. But the one line this PR exists to get right, "no submission seen", can be false in two ordinary ways, and the derivation step can wedge for good. Verdict: **2 High, 3 Medium, 3 Low.**

**Gates at `c696e45`:** lint and typecheck pass. `pnpm test` passes 3,485/3,486. The one failure is `owner-passphrase-routes`, which is the word-collision test defect on main (see the 16:05 entry there), not this PR. `0027` has no `CASE`, and **12/12 whole-trigger removals are killed** by named tests with BASE surviving (`reviewer-tools/pr61/run61trig-part1.txt`, `-part2.txt`).

**Reviewer probes** (`reviewer-tools/pr61/zz-reviewer-pr61-probes.test.ts`): **all four PASS at this head, which is the defect.** Each must FAIL after the fix.

**H1. A handed-in assignment is still reported as "no submission seen", stamped with the newest scan.**
- **Where:** `school-observation-repository.ts` `readDigestSnapshot`, the missing-work query. It joins the basis observation but never re-checks its **current** `submission_state`. Meanwhile `completeSubmissionScan` sets `last_success_at` **before** derivation runs, and derivation pages 64 deadlines per hourly run.
- **Proven:** P1 (derivation mid-page after a scan that saw `turned_in`) and P2 (derivation fails after that scan) both return the item as `no_submission_seen` with `derivedAt` = the new scan time, while the stored observation says `turned_in`. The second reviewer also showed the same false line through the whole of the *next* scan.
- **Effect for Sid:** his morning digest tells him work he handed in is missing, dated today.
- **Fix:** in the digest query require the basis observation to still be `new`, `created` or `reclaimed_by_student`, and stamp the line with the basis observation's own `last_seen_at`, not `last_success_at`.

**H2. Work read as NEW before its deadline is reported missing once the scan completes after the deadline.**
- **Where:** derivation compares `due_at` with the scan **completion** time, but accepts any observation read since the scan **started** (`school-observation-repository.ts` derivation, and the `0027` transitions insert guard). Nothing requires the read to be at or after the deadline.
- **Proven:** P3. The read is at 12:00, the deadline is 12:30, and the scan completes at 13:00. The digest reports it missing, and the only evidence is a read taken 30 minutes before it was due. A scan may legitimately span up to 24 hours.
- **Fix:** derive `no_submission_seen` only from an observation read at or after `due_at`, in both the repository and the `0027` guard. Otherwise derive nothing, not `not_due`.

**M1. One lost write followed by a due-date change wedges derivation permanently.**
- **Where:** `classroom-observation-sync.ts` derivation branch. A replay reuses the same `derived_at`, the deadline's new due date changes the desired transition, and `UNIQUE (principal_id, deadline_id, derived_at)` plus the insert guard reject it. The 24-hour reset only checks `scan_started_at`, which is NULL during derivation, so nothing ever ages it out.
- **Proven:** P4 (every replay throws), and the second reviewer ran 72 consecutive hourly runs that all failed with 0 pages read.
- **Effect for Sid:** grades and submission checks silently stop updating, and the stale "missing" lines keep printing.
- **Fix:** make a replay idempotent per deadline (skip a deadline that already has a transition at this `derived_at`), and give the derivation phase the same age limit and visible reset as the scan.

**M2. The new lines print raw UTC.** `(deadline passed 2026-09-16T03:59:59.999Z)` for an 11:59 p.m. Toronto deadline shows the next day. The rest of the digest is relative or local. Render in `DIGEST_TIMEZONE`.

**M3. Four rules that decide what Sid is told have no test that fails if they are removed** (by reading): derivation paging and resume (every fixture has one deadline); advancing to the next course (every sync test has one course); the stale and never-scanned gap lines in `digest-job.ts`; and `d.due_at <= now` in the missing-work query. Add a >64-deadline two-run test with a digest read in between, a two-course sync test, both gap tests, and a due-date-extension test.

**L1.** Missing work is capped at 20 lines with no "+N more".
**L2.** Derivation walks every Classroom deadline ever stored, which lengthens H1's window all year. Join on observations read in this scan instead.
**L3.** The poll output drops the rejected count, so a submission Classroom recreates under a new id is rejected on every scan with no signal. Surface the count.

**Could not verify:** whether `listCourses` includes courses where Sid is not a student and `userId=me` then errors on every run.

Full second-reviewer report: `reviewer-tools/pr61-adversarial.md`.

**Next.** A fresh school-builder session fixes H1, H2 and M1–M3, fixes or records L1–L3, and requests a max re-review. P1–P4 must fail. Rerun whole-trigger removal for any `0027` trigger you change.

— Claude Opus 5
