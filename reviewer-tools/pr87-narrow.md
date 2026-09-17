# PR #87 narrow review, head 5f3c1ce

**Verdict: F1–F6 mostly land. Literal history now works on real Telegram turns, and forgetting still holds. Not clean: 2 Medium, 4 Low, no High. Of the 2 Medium, 1 is a gap in F1/F4 that also exists on main, and 1 is a recall defect that F3 now exposes to Sid.**

Tests are in `C:\Users\Sid\jarvis-pr85-adv\apps\cloud-gateway\test\memory\adversarial-pr87.test.ts`: 16 tests plus a diagnostic dump that is off (`DUMP = false`). **At head: 11 pass, 5 fail.** The same file against main's `src` (743c4e5): 6 pass, 10 fail. F3a, F3c, F1b, F1d and F4a fail on main and pass on head, which confirms those fixes.

| Test | Head | Main |
|---|---|---|
| L1 archived fixture, question in window, ≤500 ms | pass (flaky under load, see Unverified) | fail |
| F2a batched order, mixed archived and live | pass | pass |
| F2b corrupted R2 object after the first retrieval is not served from cache | pass | pass |
| F1c open circuit plus one archived candidate keeps live memory | **fail** | fail |
| F3a old statement recalled; in-window hit and question not duplicated | pass | fail |
| F3b current question already indexed is not its own history evidence | **fail** | pass (path was dead) |
| F3c forgotten statement out of window never returns | pass | fail (no history at all) |
| F3d assistant reply out of window never returned | pass | pass |
| F3e statement still recalled after asking twice before | **fail** | fail |
| F3f memory's own source is not repeated as history | **fail** | pass (path was dead) |
| F1a 900 ms literal FTS keeps ready canonical memory | **fail** | fail |
| F1b literal FTS throws: memory kept, only the history fallback is logged | pass | fail |
| F1d archive_state read throws: memory kept | pass | fail |
| F4a 2,000 ms base keeps memory | pass | fail |
| F4b no unhandled rejections (candidate failure; memory timeout with late rejections) | pass | pass |
| L2 production-shaped fixture, question as newest turn, ≤500 ms | pass | pass |

---

## M1 (Medium; F1/F4 gap, also on main): a slow literal-history search still throws away canonical memory that is ready

- **Where:** `apps/cloud-gateway/src/memory/telegram-memory-retriever.ts:847-850`. `retrieveMemory` awaits `Promise.all([historyPromise, candidateContextsPromise])`, and that whole promise sits under the single 800 ms memory deadline (`:741-745`). History failures are caught (`:843`), but slow history is not.
- **Proven:** F1a. A live memory plus 70 fillers, with a 900 ms delay only on the `memory_history_fts MATCH` batch. Result: `telegram_memory_retrieval_memory_timeout` at 803–814 ms, and 0 memory contexts (base only). Candidates alone take about 10–20 ms (F4a: `candidatesMs` 8, 10 round trips).
- **Why it matters now:** history is the long pole on the live path.
  - L1 (archived): `historyMs` 308–340, `candidatesMs` 160–180.
  - L2 (live): `historyMs` 166–188, `candidatesMs` 64–74.
  - The history stage decides wall time, and archived hits add R2 reads.
- **Effect for Sid:** when literal search is slow (slow D1 FTS, cold R2 segment), Jarvis forgets everything on that question, including memories that were ready long before. The PR fixed failing literal search, but not slow literal search.
- **Fix:**
  - Give history its own sub-deadline inside the memory window, for example race it against the time left before 800 ms.
  - On timeout, treat it like `historyFailure` (log `telegram_memory_retrieval_history_fallback`) and return the candidates.
  - Pin it with F1a.

## M2 (Medium; exposed by F3, root cause pre-existing in literal-history): after Sid asks about something twice, the original statement can no longer be recalled

- **Where:**
  - `apps/cloud-gateway/src/memory/literal-history.ts:578` applies `LIMIT maxResults` in FTS.
  - Assistant hits are dropped only after that limit (`:693`).
  - The retriever asks for `MAX_HISTORY_RESULTS = 4` (`telegram-memory-retriever.ts:47`), and drops in-window hits after the limit too (`:872-875`).
- **Proven:** F3e, through the production service.
  - Setup: "I put the quartz stapler beside the green printer.", then two earlier asks of "Where did I put the quartz stapler?", each answered "You put the quartz stapler beside the green printer.", then 70 fillers and indexing.
  - On the third ask, history evidence is `["Where did I put the quartz stapler?", "Where did I put the quartz stapler?"]`. The statement is gone.
  - Cause: the 4 FTS slots go to the 2 short past questions plus the 2 assistant echoes (same bm25 score, newer sequence). The echoes are then skipped.
- **Effect for Sid:** "where did I put X?" works the first time or two. After that, Jarvis sees only copies of Sid's own old questions and says it doesn't know. This hits exactly the things Sid asks about repeatedly.
- **Fix:**
  - Exclude assistant chunks in the FTS SQL itself.
  - Over-fetch (for example up to `resultsExamined`), then drop in-window, current-turn, same-text and question-only duplicates before trimming to 4.
  - Pin it with F3e.

## L1 (Low; new with F3): the current question comes back as its own "history evidence" once it is indexed

- **Where:** `telegram-memory-retriever.ts:867` and `:872`. `withoutCurrentTurn` removes the current turn from both the coverage check and the event-id and excerpt de-duplication.
- **Proven:** F3b. The question is the newest event and already indexed, which happens on an indexer race or a re-claimed turn. History evidence then returns `["Where did I put the quartz stapler?", <statement>]`, so the question appears twice in context.
  - F3a (the normal case, question not yet indexed) passes: 1 copy of the question, and the in-window "spare quartz stapler" turn appears once.
- **Effect for Sid:** noise and wasted budget in rare turns. No privacy impact.
- **Fix:** exclude the current turn only from `recentContextCoversQuery`. Keep its event id and text in `recentEventIds` and the excerpt check.

## L2 (Low; new with F3): a canonical memory's own source turn is repeated as history evidence

- **Where:** `telegram-memory-retriever.ts:872-890`. History hits are de-duplicated against recent context, but not against `memory.candidateContexts[].sourceEventId`.
- **Proven:**
  - F3f: "My favourite school subject is math." out of the window, then "Which school subject is my favourite?". The model gets the memory evidence and also `History evidence [live D1; event <same id>]: My favourite school subject is math.`
  - L1 shows the same thing for the archived memory.
- **Effect for Sid:** duplicate lines in Jarvis's context. They use the ¼ memory byte budget and a history slot.
- **Fix:** add the candidate memories' source event ids to the history de-duplication set.

## L3 (Low; pre-existing, F1 not complete for archived memories): an open archive circuit plus any archived-source candidate still wipes all memory

- **Where:**
  - `memory-repository.ts:1187`: `Promise.all` over items, with no per-item isolation.
  - The archived receipt read throws `archive_circuit_open` (`archival-service.ts:235`) and rejects the whole batch.
  - The retriever then falls back (`telegram-memory-retriever.ts:908`).
- **Proven:** F1c. 3 archived-source memories plus 1 live memory, circuit open. Logs `telegram_memory_retrieval_fallback` and keeps 0 memories, the live one included. Same on main.
- **Effect for Sid:** the circuit latches (PR #85 M1). Once any matching memory is older than 90 days, an open circuit means no memory on those questions. The PR's B1 fix covers only live-only memories.
- **Fix:** in the retrieval reader, map archive-unavailable (not corruption) for one item to "skip this item", and keep the others.

## L4 (Low; tests): new guards no test pins, and a gate flake

- **Mutations** were run against the builder's `telegram-memory`, `memory-repository` and `archival-service` suites. **These survived:**
  - `validateBatchedReceipt` source checks (`memory-repository.ts:3013-3017`): removing the `r2SegmentId`, `occurredAt`, `channel` or `excerpt` comparison. All 4 survived.
  - The cached-path `validateDecodedManifest` call (`archival-service.ts:310`).
  - The recent-excerpt de-duplication (`telegram-memory-retriever.ts:875`).
  - `A1` (removing the cache objectKey/length mismatch check) was "killed" only by the wall-clock production-shaped test, a latency failure that this mutation cannot cause. Treat it as surviving.
- **Killed properly:**
  - current-turn exclusion: T1 (never exclude) and T2 (always drop the last context)
  - history `.catch` removed
  - circuit pre-check removed
  - history fallback log removed
  - recent event-id de-duplication removed
  - coverage computed on the full base
  - receipt `sourceLocation` check
  - receipt cache
  - topic-walk limit back to 64
  - segment cache
- **Gate flake:** `keeps ready memory when a 900 ms base lookup remains inside its own deadline` (`telegram-memory.test.ts:2334`) timed out at the default 5,000 ms in the main reviewer's full run. It seeds 185 events, indexes, then waits 900 ms. Separately, `seedProductionShapedLatencyFixture` caps indexing at 128 steps × 16 events. In a file with more events it threw `telegram_memory_latency_history_incomplete` for me.
- **Effect for Sid:** red CI for no reason, and a stale segment or a wrong-source receipt check could be deleted without any test noticing.
- **Fix:**
  - Give the 900 ms test `{ timeout: 30_000 }`.
  - Bound the fixture's index loop by completion, not by 128 steps.
  - Add batched-reader tests that tamper each source expectation (segment id, occurredAt, channel, excerpt) and expect `memory_corrupt`.
  - Add one cached-segment test with a manifest whose counts don't match.
  - Add one test where history's excerpt matches recent text under a different event id.

---

## Checked and sound

- **F3 happy path end to end:** F3a passes through `sendProduction`. The old statement is recalled, an in-window FTS hit is not duplicated, the question appears once, and no history fallback is logged.
- **Forgetting (F3c):** "Remember that…", then forget, then 70 fillers, index, and a real Telegram question. The item is `forgotten`, "blue cabinet" appears nowhere, and the only history evidence is the forget command's own text. This proves the path ran.
- **Assistant replies (F3d):** the reply is indexed in FTS (count 1) but never returned, as base or as history.
- **F1b/F1d:** a thrown literal batch or a failed `archive_state` read keeps canonical memory and logs only `telegram_memory_retrieval_history_fallback`. Both fail on main.
- **F4:** base and memory now have separate deadlines and separate statement budgets. A 2,000 ms base keeps memory (F4a, `candidatesMs` 8). The merge runs after both settle. F4b saw no unhandled rejection with fast candidate failure plus slow base, or with a 100 ms memory timeout and late D1 rejections.
- **F2 order and cache scope:**
  - `Promise.all` keeps input order with mixed archived and live items settling at different times (F2a).
  - The receipt cache is per `readCurrentItemsWithVisibility` call and single-principal.
  - The segment cache is per `ArchivalService` instance, and `dependencies()` builds a new one per `retrieve` and per `findTargets` call.
  - F2b: corrupting the R2 object after a successful retrieval makes the next retrieval on the same retriever fail closed (0 memory, 0 history), with no stale reuse.
  - The cache is keyed by compressed sha256 and re-checked against objectKey and length, and `readAndDecode` still verifies the hash.
  - The archived-first receipt order matches `validateSourceRows`, which sets `sourceLocation` from the current `archive_segment_events` row.
- **Latency with literal search live, 25 ms per round trip:**
  - **L1 archived** (3 archived memories, 6 archived hits, 20 recent turns, question in the window): 40 round trips, 65 statements, max in-flight 8. **308–345 ms** in 12 of 15 measured runs.
  - **L2 production-shaped live:** 11 round trips, 28 statements. **167–188 ms** in 5 of 6 runs.
  - Both are inside 800 ms. The builder's own ≤500 ms archived test passed 6/6 run alone.

## Unverified

- **Spikes:** 4 runs (L1 532/726/809 ms, L2 680 ms) had identical round-trip counts and showed a ~400–500 ms jump in one stage. The main reviewer was running full suites on the same PC during this session, so I think this is CPU contention, not the code, but I have not proven it. If it happens on production isolates, an 809 ms stall is at the memory deadline.
- **Production timing:** real D1 round-trip time and R2 segment sizes on the live path.
- **Turn-order edge case (reading only):** if a second Telegram message is admitted before the first turn's retrieval, `contexts.at(-1)` is not the current turn. Exclusion is then skipped, so that turn gets no history. That is safe but loses recall. Not tested.
- **Fixes:** none of the suggested fixes were tried; only the problems are proven.
