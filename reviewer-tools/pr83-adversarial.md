# PR #83 adversarial review: meaning search at `0ab3c56`

**Verdict: not mergeable yet.** I found 2 High, 1 Medium and 3 Low problems. A forgotten memory can come back through meaning search. Once the index holds a few vectors, most questions would also lose keyword memory recall they get today.

I tested in `C:\Users\Sid\jarvis-pr83-adv` (detached at `0ab3c56`, frozen install). The tests are in `apps/cloud-gateway/test/memory/adversarial-pr83.test.ts`. Result: **5 tests, 5 failed**, and each failure proves a defect. The builder's `meaning-search.test.ts` passes 13/13 on the same tree. I made no real Workers AI, Vectorize or DeepSeek calls and pushed or deployed nothing.

---

## High

### H1. A forgotten memory comes back through Jarvis's own indexed reply

- **Where:**
  - The indexer embeds every retrievable history chunk, including Jarvis's replies: `apps/cloud-gateway/src/memory/meaning-search.ts:494-502`.
  - The recall side re-reads only the chunk view: `apps/cloud-gateway/src/memory/telegram-memory-retriever.ts:957-1017`.
  - Compare the existing paths:
    - Literal search skips Jarvis's replies (`literal-history.ts:546`).
    - The recent-turn window hides a reply whose owner turn is suppressed, or one that references or restates a forgotten item (`telegram-memory-retriever.ts:1056-1066`, `:1168-1173`).
  - `forgetItem` suppresses only the owner's source event (`memory-repository.ts`, `forgetItem`), so the view still passes the reply chunk.
- **Proven:** `never returns a forgotten memory through Jarvis's own indexed reply that restated it` **FAILED**.
  - **Setup, all with production code:** a real Telegram turn through `ConversationRepository`. Sid says "Remember that my bike lock word is marigold" and `MemoryOwnerControlsService.remember` runs during the turn. Jarvis's reply "Got it. Your bike lock word is marigold." is delivered. The production `LiteralHistoryService.indexNext` builds the chunks and three `runIndexStep` runs follow.
  - **Then:** `forget`, the literal maintenance pass, and three more index runs. The result was 4 upserts and 2 deletes, and two chunk vectors are still live.
  - **Control:** keyword recall plus the real recent-turn window (`D1ContextRetriever` with its forget filter) contains no "marigold".
  - **With meaning search on**, the model context contains `History evidence [live D1; event 01m2…]: Got it. Your bike lock word is marigold.`
- **Effect for Sid:** he says "forget my bike lock word" and gets a receipt. A later related question ("how do I open my bike lock?") quotes the word back from Jarvis's earlier reply. This breaks §8: "Hidden text disappears immediately from … meaning results."
- **Fix:**
  - In `readMeaningHistory`, re-read the exact event through `TieredEventReader`, as literal search does and as §5.2 step 7 requires. Verify the event text hash, then drop assistant-speaker chunks. Alternatively apply the same owner-turn-suppression and forgotten-item reference/restatement filter the recent window uses.
  - Stop indexing assistant chunks, or filter them identically at index time, and delete their existing vectors.
  - While there, the evidence line should carry time, channel and speaker, not the R2 segment hash (§5.3). The current line cannot tell Sid's words from Jarvis's.

### H2. Meaning re-reads run outside the 450 ms cap, so the 800 ms memory timeout drops keyword recall too

- **Where:**
  - `timedOutcome` guards only `search()` (`telegram-memory-retriever.ts:877-884`). The up-to-8 canonical re-reads then run one after another with no deadline (`:895-900`).
  - Keyword candidates wait for them (`:804-807`).
  - When the shared 800 ms timer fires, `retrieve` returns base context only (`:711-738`), which throws away the finished keyword results.
  - Nothing sets a score floor (`:895`), so Vectorize's top 8 nearest are always re-read.
  - The re-reads also draw from the shared 900-statement budget (`:107`), whose documented worst case does not include them.
- **Proven:** `keeps keyword memory when meaning search answers inside 450 ms but D1 re-reads push past 800 ms` **FAILED**. Setup: 8 remembered items, a D1 wrapper adding per-statement latency, and a meaning search returning all 8 inside the cap.

| injected D1 delay | search | keyword only | with meaning | memory contexts | "blue notebook" kept |
|---|---|---|---|---|---|
| 0 ms | 300 ms | 19 ms / 10 stmts | 468 ms / 90 stmts | 8 | yes |
| 5 ms (≈11–13 ms per statement measured) | 150 ms | 132 ms | 812 ms | **0** | **no** |
| 5 ms | 300 ms | 110 ms | 810 ms | **0** | **no** |
| 8 ms | 150 ms | 127 ms | 806 ms | **0** | **no** |
| 8 ms | 300 ms | 126 ms | 815 ms | **0** | **no** |
| 12 ms | 100 ms | 125 ms | 803 ms | **0** | **no** |

  Eight item hits add about 80 D1 statements to the 10 keyword ones. PR #79's own evidence used 25 ms injected D1 latency.
- **Effect for Sid:** once a few memories are indexed, nearly every message with a content word gets 8 nearest hits, relevant or not. Those turns would lose all memory recall, keyword and meaning, and answer from recent turns only. That is worse than today, with added latency up to the 800 ms bound.
- **Fix:**
  - Put one deadline around search plus re-reads. When it fires, return the keyword results instead of letting the 800 ms timer discard them.
  - Re-read all hits in one or two batched D1 statements, or in parallel, under their own statement budget.
  - Add a score floor or a smaller `topK`.
  - Add a latency test at about 25 ms per D1 statement that asserts keyword recall survives.

## Medium

### M1. New memories wait behind the whole history backfill at about 192 embeddings a day

- **Where:**
  - One queue, `ORDER BY ordered_at ASC, item_kind ASC` (`meaning-search.ts:473-505`). `'history_chunk'` sorts before `'item'`, and existing chunks carry older `created_at` values.
  - 8 mutations per run, one vector per upsert call (`:25-32`, `:385`), on the hourly cron (`wrangler.toml:61`).
  - The 90-day archive maintenance deletes and re-inserts every chunk with a new `chunk_id` (`literal-history.ts:896`, `:970-1003`). That makes each old vector stale and costs a delete plus a re-embed per event.
- **Proven:** `indexes a newly remembered memory in the next run even when older history is still pending` **FAILED**. With 9 older chat chunks and 1 new memory, the run upserted 8 chunks and not the memory. The capacity figures come from reading.
- **Effect for Sid:** every existing message and reply (2 chunks per exchange) must be embedded before anything new, at 8 an hour. For example, 2,000 existing events take about 10 days with no new chatting, and longer while he keeps using Jarvis. A memory he adds tomorrow is not meaning-searchable until that finishes. From day 90, every event is embedded a second time.
- **Fix:**
  - Index items, newest first, ahead of history backfill.
  - Batch vectors per upsert call: Vectorize takes up to 1,000 per call and it counts as one mutation. Send more inputs per embedding call within the byte cap.
  - Key history vectors by stable identity (event sequence plus content hash) so archive re-chunking does not re-embed.

## Low

### L1. Recent turns are repeated as meaning "history evidence"

- **Where:** `telegram-memory-retriever.ts:895-900` has no recent-event check. The literal path has one at `:786-788`.
- **Proven:** `does not repeat recent-window turns as meaning history evidence` **FAILED**: 2 copies of the same message in context.
- **Effect for Sid:** his last few messages appear twice, spending memory budget.
- **Fix:** skip hits whose event id is already in base context.

### L2. The "greetings make no AI call" rule covers only stopwords

- **Where:** `telegram-memory-retriever.ts:865` with `RECALL_STOPWORDS` at `:89-97`.
- **Proven:** `makes no AI or Vectorize call for short no-content replies` **FAILED**. Only "hey" skipped the search. "thanks!", "ok cool", "what's up", "lol", "good night" and "yes" each called search and took about 300 ms longer with a 300 ms search. Under H2 they also pay 8 re-reads.
- **Effect for Sid:** chit-chat replies get slower and each costs one Workers AI call and one Vectorize query for nothing.
- **Fix:** skip meaning search below a small number of content terms or characters, or add common acknowledgements to the skip list.

### L3. The real Workers AI and Vectorize adapters, `search()` and chunk deletion have no tests

- **Proven by mutation:** each of these 4 edits left `meaning-search.test.ts` plus `automatic-distillation.test.ts` at **56/56 passing**:
  1. Disable the history-chunk stale-delete branch (`meaning-search.ts:456`).
  2. Remove the returned-metadata principal check (`:335`).
  3. Send `{contexts:[…]}` instead of `{text:[…]}` to Workers AI (`:244`).
  4. Remove the chunk text hash check (`telegram-memory-retriever.ts:984`).
- **Effect for Sid:** a wrong request or response shape, or a dropped guard, would ship with green CI. The fakes never go through `WorkersAiMemoryEmbeddingProvider`, `VectorizeMemoryVectorStore` or `MemoryMeaningService.search`.
- **Fix:** add adapter tests against the documented shapes and `search()` result-validation tests. Add a test that a suppressed chunk's vector is deleted.

---

## Checked and sound

- **Workers AI shape:** `@cf/baai/bge-m3` with `{ text: string[] }` returns `{ shape, data: number[][], pooling }`. The code reads `data` and checks 1,024 values. Sources: the `Ai_Cf_Baai_Bge_M3_Input_Embedding` / `Output_Embedding` types in workers-types 5.20260830.1, and https://developers.cloudflare.com/workers-ai/models/bge-m3/. The model's context window is 60,000 tokens and chunks are at most 32,768 bytes, so `truncate_inputs` (default false) cannot trip.
- **Vectorize limits:**
  - A metadata filter needs its index created before vectors are inserted, and the runbook orders `create-metadata-index` before the first deploy (https://developers.cloudflare.com/vectorize/get-started/intro/).
  - `topK` 8 with `returnMetadata: "all"` is within the limit of 50 (changelog 2026-03-16).
  - Vector ids are 64 hex characters, which fits the 64-byte limit (https://developers.cloudflare.com/vectorize/platform/limits/).
  - `upsert`, `deleteByIds` and `query` signatures and `{mutationId}` match workers-types.
  - `--property-name` is accepted; wrangler 4.127.1 lists `--propertyName`.
- **Item recall and eventual consistency:** forgotten, superseded, expired and proposed items, suppressed owner chunks, and other principals' vectors are all rejected by the D1 re-read. A just-deleted vector that Vectorize still returns maps to nothing.
- **Lift paths:** an item lift creates a new `version_id`, which gets re-embedded. A history lift makes literal maintenance insert a new `chunk_id`. Neither leaves a permanent dead ledger row in current flows.
- **Ledger:**
  - The UNIQUE key and insert/update/delete guards are respected, and retry in both orders (Vectorize accepted but ledger failed, and the reverse) is idempotent.
  - `deleted_at` uses the run timestamp, so it is never before `upserted_at`.
  - The D1 worst case is 7 + deletes + 2×upserts ≤ 23, under the 32 claimed.
  - There are at most 8 Vectorize mutations, exactly one AI call when there are candidates and none otherwise, and the cursor advances only when nothing is pending.
- **The 450 ms cap:** it does stop waiting on `search()`, a late rejection is handled, and recent context keeps its own 2,500 ms bound. The problem is H2, not the cap itself.
- **Scope:** no migration, and `voice/**`, `calls/**`, `school/**`, `university/**` and `backup/**` are untouched.

## Unverified

- **Deploy without the index:** does `wrangler deploy --strict` fail when `jarvis-memory-bge-m3` does not exist? I expect it does and found no docs statement. If so, main cannot be deployed after merge until Sid runs the two `vectorize` commands, so they must stay a pre-deploy step.
- **Production latency:** real D1 per-statement latency and Workers AI plus Vectorize query latency. The harness measured about 11–13 ms per statement.
- **Backfill length:** Sid's real event and chunk counts.
- **Archived chunks:** by reading only. Rows sealed before `0026`, whose live event was already purged, keep `archive_segment_events.subject_id` NULL. That gives a NULL `event_id` and throws away the whole meaning result set for the turn. There is no archived data in production yet.
- **Returned metadata:** whether real Vectorize metadata with `returnMetadata: "all"` has exactly the 4 stored keys that `search()` requires.
