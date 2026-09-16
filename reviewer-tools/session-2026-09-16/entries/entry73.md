## 2026-09-16 20:08 UTC — Claude Opus 5, PR #73 max review at 3c62b5a: changes requested

**Migration 0030 is sound, and the gates are green. But the check-in would tell Sid things that aren't true, and ordinary phrases retire his study signals.**
- **Gates at `3c62b5a`:** lint 0, typecheck 0, **177 files / 3,926 tests**.
- **0030 whole-trigger removal:** 6/6 killed by named tests, BASE surviving.
- **Adversarial second reviewer:** `reviewer-tools/pr73-adversarial.md`, tests in `reviewer-tools/pr73/agent/`. I re-ran `zz-adversarial-pr73.test.ts` in a Windows Workers-pool checkout at this head, and all 7 defect assertions pass.

**B1 (H1). Work Sid handed in on time is reported as overdue.** Nothing marks a deadline submitted: Classroom assignments stay open after turn-in, and Brightspace has no submission state. So every past-due deadline from the last 14 days scores 92 as "verified overdue".
- **Proven:** a returned 9/10 quiz produced `Source 1 — deadline …: The open deadline was overdue`.
- **Also:** 24 stale past-due rows fill the oldest-first `LIMIT 24`, so a deadline due in 2 hours is dropped (`study-coach-signals.ts:212-247`, `deadline-repository.ts:531-543`).
- **Fix:** drop the overdue-deadline signal (derived missing work already covers missed Classroom work). Use near-due, unfinished deadlines only, read soonest-first from now.

**B2 (H2). Raw Classroom points are treated as percentages.** `maxPoints` is never stored, so 10/10 counts as "low", and 45/50 followed by 9/10 counts as "falling". The date shown is the poll time, not the grade time (`study-coach-signals.ts:140-178`).
- **Fix:** store `maxPoints` and the grade's own timestamp, and compare percentages. Until both exist, derive no grade signals.

**B3 (H3). Everyday phrases retire signals and swallow Sid's reply.** "I finished it", "it is done", "that is wrong" and "I did that" retire the latest check-in of any age, and the normal model is never called.
- "I finished it" 15 days later retired a signal.
- "That is wrong" with no check-in ever made still got a canned study-coach reply.
- **Where:** `study-coach-model.ts:222-230, 482-498`, `study-coach-repository.ts:750-770`.
- **Fix:** act only on a correction that names or clearly replies to **today's** check-in, and pass everything else to the normal model unchanged.

**S1 (M1).** Course-wide signals, such as an unrelated deadline, inflate a one-point tentative topic to "2 evidence points, high confidence", and the "not a fixed judgment" caution disappears (`:280-300`). Count only evidence about the same topic, and keep the caution.

**S2 (M2). Regression against slice 1.** The same weak spot now repeats every morning: 4 days running at head versus day 1 only on main (`study-coach-repository.ts:688-689`). Restore "raise each evidence point once".

**N1 (L1). Unpinned rules.** 23 of 25 mutations survived the relevant tests:
- the correction duplicate check, the only barrier to `INSERT OR REPLACE` rewriting a correction;
- the correction-turn principal check;
- the cited-source check and the cited-record existence checks in 0030;
- the "; stale" label;
- the open-status deadline filter and the missing-work submission filters;
- ambiguous course matching.

Give each a named test.

**N2 (L2).** The 0030 guard accepts a correction turn older than the check-in. Require the turn to be at or after the check-in's creation.

**N3 (L3).** Citations show raw ids. Show the course, the item name as a label (never as instructions) and the date.

**Next.** A fresh code session fixes B1–B3, S1–S2 and N1–N3 with tests. It merges main (which now includes #72 and will include #62), runs lint, typecheck and the full suite, and requests re-review. If 0030 changes, rerun whole-trigger removal for the changed triggers.

— Claude Opus 5
