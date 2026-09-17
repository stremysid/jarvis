# PR #85 adversarial review, head 5b05f62

**Verdict: not ready to merge. There is 1 Medium regression and 1 Medium gap in the hotfix, plus 1 Medium pre-existing defect and 3 Lows. No High.** Forgetting and suppression are exactly as strict as before. The batched item reader gives the same output as the old per-item readers. The deadline fix works for live data, but it is incomplete for old (archived) memories and still breaks when the base lookup is slow.

Tests are in `C:\Users\Sid\jarvis-pr85-adv\apps\cloud-gateway\test\memory\adversarial-pr85.test.ts`, 7 tests. At head: **3 pass, 4 fail**. I also ran them against main's `src`.

| Test | Head | Main |
|---|---|---|
| A1 archived-source latency | fail (641–658 ms, one run of three timed out) | fail (memory timeout every run) |
| B0 current question already in recent context | pass | pass |
| B1 open archive circuit keeps memories | **fail** | **pass** (regression) |
| B2 literal history reaches a real Telegram turn | fail | fail (pre-existing) |
| B3 900 ms base keeps ready memory | fail | not run (same code path) |
| C1 batched reads equal old readers | pass | n/a (API is new) |
| C2 forgotten turn never comes back | pass | pass |

---

## M1 (Medium, regression): an open archive circuit now wipes all memory from ordinary Telegram questions

- **Where:** `apps/cloud-gateway/src/memory/telegram-memory-retriever.ts:776-791`. Literal search now always starts, and its failure rejects the whole memory promise at `:744`. Before this PR it only ran when `!recentContextCoversQuery` (`:795`).
- **Proven:**
  - **B1:** 70 filler turns, then a live memory "My favourite school subject is math.", then the archive circuit is opened, then a real `sendProduction` question. At head it logs `telegram_memory_retrieval_fallback` and the model gets no memory evidence. **The same test passes on main.**
  - **B0 (passes):** the current Telegram question is already in the base recent context when retrieval runs. So in a real turn `recentContextCoversQuery` is always true, and main never ran literal search on Telegram. Head now runs it every time a question has 3 or more content words, then throws the result away. The only new effect is a new way to fail.
  - The circuit latches: `archival-service.ts:260` opens it, and no code in `src` closes it again.
- **Effect for Sid:** after any archive read failure, Jarvis stops remembering anything on normal questions until someone fixes the database by hand. Before this PR, memories whose sources were still live kept working.
- **Fix:** don't start literal search when it can't be used. If you keep starting it early, catch its failure and treat it as "no history hits" so it can't fail canonical memory. B1 should then pass.

## M2 (Medium, hotfix incomplete): old memories whose sources are archived still come close to the 800 ms deadline, because items are now checked one after another

- **Where:** `apps/cloud-gateway/src/memory/memory-repository.ts:1181`. A `for` loop awaits each item's creation and source receipt checks in turn (`:1211`, `:1232`). Each archived receipt calls `readArchivedRange` (`:2585`): about 3 D1 round trips plus an R2 fetch. Main ran candidate items in parallel with `Promise.all`.
- **Proven:** A1 uses real archival. 3 candidate memories (1 uncertain proposed, 2 active) have sources archived and purged from live D1, plus 6 archived literal hits and 20 recent live turns, with 25 ms per round trip.
  - **Head:** 641–658 ms, 48 round trips, `candidatesMs` 638–654. **One run in three hit `telegram_memory_retrieval_memory_timeout` at 806 ms.**
  - **Main:** timed out at 813 ms on every run (74–76 round trips). So head is better than main, but not well under the deadline.
  - **Changing only that loop to `Promise.all`** brought it to **286–300 ms** (`candidatesMs` 273–286) with the same 48 round trips.
  - Archiving happens after 90 days (`archive-repository.ts:78`), so every memory older than that takes this path.
- **Effect for Sid:** once his memories are more than about 3 months old, questions like "what's my favourite subject?" can hit the same "I don't know" failure this PR set out to fix. It gets worse with more sources per item or slower D1.
- **Fix:**
  - Validate items concurrently: `Promise.all` over items, keeping candidate order.
  - Cache receipt checks per `(eventId, sequence)`, since the creation event is usually also the first source.
  - Consider reading each archived segment once per retrieval.
  - Pin A1 with a bound of 500 ms or less.

## M3 (Medium, pre-existing, not a PR regression): literal-history recall never reaches a real Telegram turn

- **Where:** `telegram-memory-retriever.ts:795` (`recentContextCoversQuery`). On both main and head the recent context includes the question being asked, so the query always "covers itself".
- **Proven:** B2 fails on head and on main. "I put the quartz stapler beside the green printer." sits behind 70 filler turns and is indexed. The real turn "Where did I put the quartz stapler?" gets `serviceHistory: 0` and `serviceHasQuestion: true`.
- **Effect for Sid:** "what did I say about X a while ago?" never uses the history index on Telegram. It only works while the turn is still among the last ~64 messages. It also means the PR's parallel literal search gains nothing in production, and the builder's latency and slow-base harnesses call `retrieve` without the current question in context, which is a path production never takes.
- **Fix (separate PR):** leave out the current turn's own event when checking coverage. That also removes M1's wasted search.

## L1 (Low, pre-existing, claim overstated): a slow base lookup still throws away memory that was already ready

- **Where:** `telegram-memory-retriever.ts:787`. `retrieveMemory` awaits `basePromise` inside the 800 ms memory deadline, while the base has its own 2,500 ms deadline.
- **Proven:** B3 uses a 900 ms base stub on the builder's production-shaped fixture. It logs `telegram_memory_retrieval_memory_timeout` and returns 0 contexts, although the memory reads take about 80 ms. The builder's "700 ms slow base no longer times out" holds only below 800 ms. The main side is by reading: main has the same await.
- **Effect for Sid:** if D1 is slow enough that recent context takes more than 0.8 s, Jarvis again says it doesn't know. Production base was already 450–484 ms.
- **Fix:** run the memory-only work under the 800 ms deadline, then do the de-duplication merge after both finish, outside that deadline.

## L2 (Low, tests): the new wall-clock latency test is flaky, and several guards have no test pinning them

- **Where:** `test/memory/telegram-memory.test.ts:1914-1915` (`baseMs <= 250`, `memoryMs <= 350`).
- **Proven:**
  - It failed in an unchanged 26-file run (577/578), passed when run alone, and failed again in 2 of 8 mutation runs whose mutations cannot affect latency (M2, M8 below).
  - Mutating these and running the builder's three suites (telegram-memory, literal-history, memory-repository), **every one survived**:
    - literal suppressed-row skip `literal-history.ts:696`
    - archived event-id check `:701`
    - per-row seal consistency `:675`
    - batched `creation_event_suppressed` forced to 0
    - batched suppressed-source list emptied
    - retriever `recentEventIds` de-duplication `telegram-memory-retriever.ts:801`
  - The post-read archive state recheck `literal-history.ts:687` and batched `retrievable` forced to 1 were "killed" only by the flaky wall-clock test.
  - My C1 kills the batched visibility mutations: I checked `creation_event_suppressed` forced to 0, and it fails.
- **Effect for Sid:** red CI for no reason, and the suppression guards could be deleted later without any test noticing.
- **Fix:** assert round-trip counts and a generous bound instead of 250/350 ms. Add C1 (a differential test against `readCurrentItem` + `readItemVisibility`). Add a race test that inserts a suppression between the FTS query and the candidate batch.

## L3 (Low, by reading): a combined topic-walk limit can refuse a deep item that used to read fine

- **Where:** `memory-repository.ts:2914`. `topic_walk.depth < ?3` caps redirects plus parents together at 64 steps. The old `followRedirects` + `readTopicPath` allowed up to 64 of each.
- **Effect for Sid:** none in practice. Automatic depth is 4. An item past the cap fails closed (corrupt) and takes the whole memory lookup down with it.
- **Fix:** allow up to 128 steps, or document the combined cap.

---

## Checked and sound

- **Batched item reader:** C1 compares it with the old per-item readers (`readCurrentItem` + `readItemVisibility`) on real owner remember/forget flows:
  - Items covered: forgotten; proposed with its creation event suppressed; active with a suppressed source; active retrievable; proposed uncertain.
  - Another principal's item and an unknown id are skipped, like the old `memory_not_found`.
  - Identical output. The SQL was also diffed by reading: receipt CTE, source join via `state.current_version_id`, archived segment filter, refuse→corrupt mapping.
- **Forgetting end to end:** C2 (remember, index, forget, 70 fillers, retrieve) passes. Nothing about the forgotten fact comes back through memory or literal history, only the forget command's own text.
- **Literal-history batch:**
  - Suppression uses `COALESCE(live.event_id, archived.event_id)`. An event with neither row can't exist (`archive_segment_events` can't be deleted).
  - The `memory_retrievable_history_chunks` view already excludes suppressed chunks before the per-row check.
  - Subject, assistant, hash, span and circuit checks match the old path. Archived hits return R2 provenance (A1).
- **De-duplication and budgets:** the recent-event-id and excerpt checks, `recentContextCoversQuery`, the byte budget and the memory-then-history order are unchanged. They still run after base settles.
- **Voice:** `D1ContextRetriever` now runs the same two statements as one batch, a single transaction, in the same order. Voice, conversation, channels, literal-history, memory-repository and telegram-memory suites: 577/578 at head, the one failure being the flaky L2 test.
- **D1 limits:**
  - At most 3 bound parameters per item statement; literal VALUES list 3×8+1 = 25.
  - The retriever batch is 24 statements (3 items × 8).
  - The 32-item/256-statement cap is only reachable by other callers.
  - No JSON array parameters. The 900-statement budget is unaffected.
- **Proxies:** the round-trip proxy plus the counted proxy pass real statements to `batch`, checked through the WeakMap. Telemetry counts each batch as 1 round trip and matched the harness count in A1 (48 = 48).
- **Scope:** no migration. `voice/**`, `calls/**`, `school/**`, `university/**` and `backup/**` are unchanged.

## Unverified

- Production D1 timing per round trip, and R2 fetch cost for real segment sizes. A1 uses tiny segments.
- D1 per-invocation query limits on Sid's actual plan.
- The M1 fix itself. Only the problem is proven.
- Whether `readCurrentItemsWithVisibility` behaves the same under a concurrent forget mid-batch (D1 batch atomicity assumed).
