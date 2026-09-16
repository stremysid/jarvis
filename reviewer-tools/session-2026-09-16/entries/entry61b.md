## 2026-09-16 16:47 UTC — Claude Opus 5, PR #61 round-2 max re-review at 4d99d15: changes requested (small)

Big improvement. Both round-1 Highs are closed, and derivation can no longer wedge. One path is left where the digest can still say "no submission" for work Sid handed in on time. It needs a one-line query fix and two tests.

**Gates at `4d99d15`:** lint and typecheck pass. `pnpm test` passed 3,756/3,757; the one failure is in `voice-owner-call-step-up.test.ts`, a calling test this PR does not touch, run while three suites shared the machine. **All four reviewer probes P1–P4 now FAIL**, as required.

**Mutation pass** (`reviewer-tools/pr61/mut61b.json`, `run61b.txt`; BASE survives). 8 of 9 are killed by named tests:
- whole-trigger removal of `school_missing_work_transitions_insert_guard`;
- H2: the trigger's read-after-deadline clause, and the repository's read-after-deadline rule;
- H1: the digest's re-check that the evidence is still unsubmitted;
- M1: replay idempotence, and the 24-hour derivation reset;
- M2: both local-time renderings.

**The survivor is H1's stamp** — see S2.

**Round-1 status** (second reviewer, `reviewer-tools/pr61b-adversarial.md`, executed on the node:sqlite harness with the real migrations):
- **Fixed:** H1, M1 (72/72 hourly runs complete after a lost write plus a due-date edit), M2 (including both DST dates), M3 and L2.
- **Partly fixed:** H2, L1 and L3.

**S1. A deadline moved later can still produce a false "no submission" line.**
- **Where:** the missing-work query in `readDigestSnapshot` checks that the basis observation is still unsubmitted, but never checks `basis.last_seen_at >= d.due_at` against the **current** deadline. Derivation correctly stays silent on a pre-deadline read, but an older `no_submission_seen` then remains the latest transition.
- **Proven:** the teacher extends a deadline and Sid hands in 30 minutes before the new time. 12 of 48 timings printed `[derived: Google Classroom showed no submission as of … 18:00 local] English: Essay (deadline passed … 20:00 local)` for work turned in at 19:30, for up to 9 hourly digests.
- **Fix:** add `AND basis.last_seen_at >= d.due_at` to that query. The second reviewer tried it on a copy: 0 of 48, and nothing else changed.
- **Test:** move the due date later but still in the past, after the read, and assert no line.

**S2. Nothing pins the "as of" time to when Classroom was actually read.** Reverting the query to stamp `sync.last_success_at` survives every test, because every fixture reads and completes the scan at the same instant.
- **Test:** read at T1, complete the scan at T2, and assert the digest line shows T1.

**N1 (L1 remainder).** The capped missing-work list still gives no "+N more". Add it, or record the cap in `KNOWN_ISSUES.md`.
**N2 (L3 remainder).** The rejected count also counts undated coursework, so it is normally above zero and can't flag a submission Classroom recreated under a new id. Count the two separately, and record the permanent-ignore case in `KNOWN_ISSUES.md`.

**Next.** The same school-builder session applies S1 and S2 with their tests and N1–N2, merges `origin/main`, and requests re-review. Expect S1's clause and S2's stamp to be removed again.

— Claude Opus 5
