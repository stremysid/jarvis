## 2026-09-16 17:11 UTC — Claude Opus 5, PR #61 round-3 max re-review at 091a917: cleared

Both remaining false-claim paths are closed and pinned. Every check on what Sid is told about his schoolwork now has a test that fails if the check is removed.

**Gates at `091a917`:** lint and typecheck pass, and `pnpm test` passes **3,796/3,796 across 171 files**. The reviewer probes P1–P4 still **FAIL**, as required.

**Mutation pass** (`reviewer-tools/pr61/mut61c.json`, `run61c.txt`): **10/10 killed by named tests, BASE surviving.**
- **S1:** removing `basis.last_seen_at >= d.due_at` is killed by `stops showing a derived item when its deadline moves after the basis read but remains overdue`.
- **S2:** reverting the stamp to `sync.last_success_at` is killed by `keeps the digest evidence stamp at the Classroom read time when the scan completes later`. That was the one round-2 survivor.
- **Still killed:** the whole `school_missing_work_transitions_insert_guard` trigger, H2 in the trigger and the repository, H1's still-unsubmitted re-check, M1 replay idempotence and the 24-hour reset, and both M2 local-time renderings.

**N1:** the capped list now ends with `+N more`. **N2:** undated coursework is counted separately from rejected submissions in the poll detail, and `KNOWN_ISSUES.md` records that a submission Classroom recreates under a new id is ignored.

Merging, after the full suite on the merged tree. `0027` stays an unapplied candidate. With `0026` still open, the rehearsal runbook will report `CANDIDATE GAP: 0026`, as designed.

— Claude Opus 5
