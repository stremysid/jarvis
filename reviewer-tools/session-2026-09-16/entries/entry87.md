## 2026-09-17 04:40 UTC — Claude Opus 5, PR #87 max review at 5f3c1ce: cleared with follow-ups (folded into PR #83 round 2)

**Cleared.** Literal-history recall now actually reaches real Telegram turns; on main it never did. Memory also survives a failing literal search or a slow base lookup. It is better than main on every measured case, with no regression in forgetting.
- **Gates at `5f3c1ce`**, in a Windows Workers-pool checkout: lint 0, typecheck 0. The suite ran **4,903/4,906**; the 3 load timeouts (`archival-service`, `telegram-memory` 900 ms test, `call-session-do`) pass **232/232** alone.
- **PR #85 adversarial suite:** **7/7 pass** (A1, B0–B3, C1, C2).
- **Narrow second reviewer:** `reviewer-tools/pr87-narrow.md`, 16 tests in `reviewer-tools/pr87/agent/adversarial-pr87.test.ts`.
  - At head: 11 pass. At main: 6 pass. F3a, F3c, F1b, F1d and F4a fail on main and pass here.
  - I re-ran the file with three other reviewers' test runs going on the same PC. F1a, F1c, F3b, F3e and F3f fail as reported. L1, F1b and F1d also timed out under that load, and the reviewer had them passing alone.
- **Checked and sound:**
  - F3 end to end: an old statement is recalled, with no duplicate of the question or of in-window hits.
  - A forgotten statement pushed out of the window never returns (F3c).
  - Assistant replies are never history evidence (F3d).
  - Separate base and memory deadlines and statement budgets; no unhandled rejections (F4b).
  - Concurrent validation keeps order; caches are per retrieval and per principal, and are re-verified (F2a, F2b).
  - Latency at 25 ms per round trip: live production-shaped 167–188 ms (11 round trips), archived 308–345 ms (40 round trips).

**Follow-ups, required in PR #83 round 2** (same pipeline; its prompt is updated):
- **F1 (M1; gap, also on main).** A slow literal-history search still discards ready canonical memory. `Promise.all([history, candidates])` sits under one 800 ms deadline (`telegram-memory-retriever.ts:847-850`). F1a: a 900 ms FTS query leaves 0 memory, though candidates were ready in about 10 ms. History is the long pole at 166–340 ms.
  - **Fix:** a history sub-deadline that falls back to candidates only, with the history-fallback log.
- **F2 (M2; exposed by the now-live path).** Asking about something twice drowns the original statement. FTS `LIMIT 4` is applied before assistant and in-window hits are dropped (`literal-history.ts:578`, `:693`; retriever `:47`, `:872-875`). F3e: on the third ask, only copies of Sid's old questions come back.
  - **Fix:** exclude assistant chunks in SQL, over-fetch, and drop in-window, current-turn, same-text and question-only duplicates before trimming.
- **F3 (Low).** An already-indexed current question comes back as its own history (F3b). Exclude the current turn only from coverage, not from dedup.
- **F4 (Low).** A memory's own source turn is repeated as history (F3f). Add candidate source event ids to history dedup.
- **F5 (Low).** An open archive circuit plus any archived-source candidate still wipes all memory (F1c, `memory-repository.ts:1187`). Skip that item on archive-unavailable, keep the others, and still fail closed on corruption.
- **F6 (Low, tests).**
  - Surviving mutations: the batched receipt source checks (`r2SegmentId`, `occurredAt`, `channel`, `excerpt` at `memory-repository.ts:3013-3017`), the cached-manifest validation (`archival-service.ts:310`), and the recent-excerpt dedup (`:875`). Pin each.
  - Give the 900 ms base test a 30 s timeout, and bound the latency fixture's index loop by completion.

— Claude Opus 5
