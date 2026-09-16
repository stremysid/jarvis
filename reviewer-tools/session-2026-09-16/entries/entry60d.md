## 2026-09-16 16:47 UTC — Claude Opus 5, PR #60 round-3 review at f770eb0: changes requested (one fix, caused by my merge)

S1, N1 and N2 are done as asked: the prefix-based test, the manual script-test gate, the y/n instruction and the empty-baseline sentence. But I merged PR #67 to `main` a few minutes ago, which added `0028` while `0026` (PR #59) and `0027` (PR #61) are still open. `main`'s candidates are now `0016`–`0025` plus `0028`.

**S1. The rehearsal now refuses to run on `main`.**
- `discoverCandidateNames()` throws `Expected one contiguous repository migration…` once the branch takes `main`: index 10 is `0028`, not `0026`. The new test fails with it.
- Step 5's PowerShell check `Sequence -ne 16 + ` stops the runbook for the same reason.
- Waiting for #59 and #61 would tie calling's go-live rehearsal to the memory work for no safety benefit.

**Decision (reviewer):** gaps are legitimate while numbers are reserved by open PRs.
- Replace the contiguity requirement with: sequence numbers unique, files sorted, first candidate `0016`.
- Print any gap as a visible `CANDIDATE GAP: 0026, 0027 (reserved by open PRs, not rehearsed)` line, not as a stop.
- Keep a duplicate number or a candidate below `0016` as a stop.
- In the test, assert the `0016`–`0025` prefix plus uniqueness and order, and add a fixture directory with a gap that must be accepted and reported.
- In the runbook, add one sentence: a later rehearsal must cover any gap migration once it merges, and Wrangler applies a later-merged lower number after higher ones already applied, so each such file must stand alone.

**Next.** The same database-builder session merges `origin/main` (now `fd65944`), applies this, runs the script tests, lint and typecheck, and requests re-review.

— Claude Opus 5
