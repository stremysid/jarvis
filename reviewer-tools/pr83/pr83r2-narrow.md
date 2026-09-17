# PR #83 round 2 narrow review, head `787a1b5`

**Verdict: round 1's H1/H2 are genuinely fixed, but this head is not mergeable: 1 High, 4 Medium, 6 Low. Nothing hidden leaked through any path, and latency is sound; the damage is elsewhere — indexing can never finish, archived history falls out of the index, and the new de-duplication throws away real answers.**

Tests: `C:\Users\Sid\jarvis-pr83-adv\apps\cloud-gateway\test\memory\adversarial-pr83r2.test.ts` (detached at `787a1b5`, frozen install). Final run: **17 tests, 11 failed + 1 deliberate dump, 5 passed**. Every failure below is a proven defect; each test asserts the correct behaviour through the production Telegram service, the production literal indexer and the production `MemoryMeaningService`. No real Workers AI, Vectorize or DeepSeek call, no push, no deploy, no cloud resource. Source mutations used to isolate causes were reverted (`git status` clean apart from the two untracked test files).

---

## High

### H1. The indexer asks bge-m3 for 128 texts; the documented maximum is 100, so a backlog over 100 never drains

- **Where:** `apps/cloud-gateway/src/memory/meaning-search.ts:28-35` (`embeddingInputs: 128`, `mutations: 128`), the single embed call at `:417`, the cap check at `:584`.
- **Proven:** `I3 a backlog above bge-m3's documented text maxItems (100) still makes progress through the real Workers AI adapter` **FAILED**: 150 pending owner turns, the real `WorkersAiMemoryEmbeddingProvider` against an `Ai.run` that enforces the documented schema. Three consecutive runs each sent `text.length === 128`, each returned `retryable_failure (memory_meaning_index_retryable)`, and 0 vectors were stored. The step re-selects the same 128 rows every hour, so it never self-heals.
  - Cloudflare's own schema for this model, `https://developers.cloudflare.com/workers-ai/models/bge-m3/batch-input.json` (title "Input Embedding"), gives `text` as `{"type":"array","items":{"type":"string","minLength":1},"maxItems":100}`. The same `maxItems: 100` appears in `bge-base-en-v1.5/sync-input.json`. `@cloudflare/workers-types` 5.20260830.1 types it only as `string | string[]`, which is why the fakes never catch it.
- **Effect for Sid:** the first hourly run after deploy embeds nothing, logs a retryable failure, and repeats forever. Meaning search stays permanently empty (every question falls back to keyword recall) and `/status` shows a missing count that never drops. His live history is already well past 100 turns, so this fires immediately, not in some edge case.
- **Fix:** cap `embeddingInputs` at 100 (and keep `mutations` independent of it), or split the candidates into chunks of ≤100 per embed call. Add a test that drives ≥101 pending rows through an `Ai.run` fake that rejects >100 inputs. While there, restate the backfill figure: at 100/hour a clean 5,000-event backlog is 50 runs, not 40.

## Medium

### M1. Archival empties the meaning index of history, and back-filling the missing `subject_id` turns that into a permanent stall

Two halves of one design gap: every history join added this round matches archived events on `archive_segment_events.subject_id`, which nothing sets at archive time.

- **Where:** `meaning-search.ts:196-206` (coverage), `:507-519` (stale-delete), `:554-573` (index candidates), `:592-616` (`isOwnerHistoryCandidate`); recall side `telegram-memory-retriever.ts:1201-1207`, `:1260`. `archive-repository.ts:293` inserts archive rows without `subject_id`; only `automatic-distillation.ts:1058` ever fills it, and only when distillation reads an already-archived range.
- **Proven (a):** `I1a production archival (subject_id left NULL) keeps archived owner-history vectors and meaning recall of them` **FAILED**. Four owner turns indexed (4 vectors). After real archival through `ArchivalService` (12 archive rows, `with_subject: 0`), the very next index run reported `deleted: 4, upserted: 0`, leaving **0 vectors**, coverage `eligible 0`, and a meaning question returned no archived history evidence.
- **Proven (b):** `I1b once distillation has back-filled archived subject_id, archived Jarvis replies do not stall indexing of a new memory` **FAILED**. With `subject_id` set exactly as `automatic-distillation.ts:1058` sets it, three consecutive runs all returned `retryable_failure`; a brand-new remembered item was **not** indexed and coverage stayed `missing: 6`. Cause isolated by mutation: making `isOwnerHistoryCandidate` `return false` instead of throwing when `envelope.eventType !== "conversation.user_committed"` (`meaning-search.ts:605-614`) made all three runs `indexed` and the new item indexed — but coverage still reported `missing: 4`, because the coverage query (`:204-206`) counts archived assistant chunks as eligible forever.
- **Effect for Sid:** from roughly 2026-12-01, when his first events pass 90 days, meaning search quietly becomes "the last 90 days only" — the opposite of "remembers everything", and the failure is silent. If the `subject_id` hole is fixed (or distillation ever lags behind archival), the hourly step instead dies on the first archived Jarvis reply and nothing new — items included — is ever indexed again.
- **Fix:** resolve an archived chunk's event through the same receipt path literal history uses (`memory_history_coverage.r2_segment_id` / `archive_segment_events.event_sequence`) instead of `subject_id`, or populate `subject_id` at archive time. Then make a non-owner archived chunk a skip, not a throw, and exclude non-owner archived chunks from `readMemoryMeaningCoverage` so `missing` can reach 0. Pin both with an archived fixture — the builder's suite has none.

### M2. The new history de-duplication drops real answers: any hit containing a short recent turn, and any statement starting with a question word

- **Where:** `telegram-memory-retriever.ts:1044-1051` — `|| hit.excerpt.includes(context.text)` (new this round) and `|| questionOnly(hit.excerpt)` with the word list at `:519-527`.
- **Proven:** both through the production service with meaning search off (so this is the literal path Sid has today).
  - `Q3a …survives a short recent owner turn ok that is a substring of the hit` **FAILED**: identical fixtures, one with a preceding `ok` turn. Control returns `I put the library book on the kitchen shelf.`; with `ok` in the window it returns **nothing**. Removing `|| hit.excerpt.includes(context.text)` makes it pass.
  - `Q3b …keeps statements that begin with have/did/will` **FAILED**: `Have to return the library book to Ms Patel on Friday.`, `Did the chemistry lab write-up already, it is due Monday.`, `Will be at the orthodontist Thursday at four.` — all three are dropped. Removing `|| questionOnly(hit.excerpt)` makes them pass.
- **Effect for Sid:** `ok` is a substring of *book, look, took, broken, okay*; `hi` of *this, his, which, think, history*; `no` of *not, now, know, note, phone*. One acknowledgement in the recent window silently deletes most literal-history recall for that turn. And normal statements that open with have/did/will/is/can are treated as questions and thrown away. Meaning search masks some of this today, but only when it is enabled, warm and inside its deadline.
- **Fix:** only drop a hit whose excerpt is contained in a recent turn (the original direction), and only when the recent turn is long enough to be evidence (say ≥ 24 characters). Replace `questionOnly` with "ends with `?`", or require a question word *and* no declarative content. Pin with Q3a and Q3b.

### M3. Asking the same thing repeatedly still drowns the original — now through the meaning results

- **Where:** `telegram-memory-retriever.ts:1060-1062` — meaning contexts are filtered only against recent event ids. The `sameText` / `questionOnly` / seen-text filters at `:1044-1051` apply to literal hits only, and `MAX_MEANING_RESULTS = 4` (`:63`).
- **Proven:** `Q2 asking the same short question four times does not drown the original statement in meaning results` **FAILED**. Statement `I put my passport in the top drawer of the hallway desk.`, four earlier asks of `Where is my passport?`, all indexed. On the fifth ask the history evidence is four copies of his own question and the statement is gone (5 copies of the question in context overall). The question is two terms, so literal search never runs — meaning search is the only path, and it is full of his own questions.
- **Effect for Sid:** exactly the F2/F3e failure PR #87 fixed for keyword recall, reintroduced for the questions he asks most often. Jarvis answers "I don't know" while quoting the question back.
- **Fix:** apply the same drops to meaning hits before fusion (current-turn text, question-only, already-seen text, base-context ids), or exclude question-shaped owner turns at index time. Pin with Q2.

### M4. Forget then lift permanently removes that turn from meaning search, and the index reports "missing" forever

- **Where:** `meaning-search.ts:547-552` and `:564-570` — the "already indexed" `NOT EXISTS` checks ignore `deleted_at`; the ledger is append-only (`0016_cloud_memory.sql:650` `UNIQUE (principal_id, item_kind, item_id, embedding_model, content_hash)`, update guard `:2685-2700`, delete forbidden `:2703`), and history vector identity is now the stable `event_id` + content hash.
- **Proven:** `F2 a lifted memory's source turn becomes meaning-searchable again and the index reports nothing missing` **FAILED**. Indexed → forget (vector deleted, `deleted_at` set) → "use the memory about … again". The chunk is back in `memory_retrievable_history_chunks` (count 1), but 20 further index runs upserted nothing for it, coverage stayed `missing: 1`, and every run reported `remaining: true`, so the `embeddings` cursor never advances again.
- **Effect for Sid:** he forgets something, changes his mind, Jarvis restores it — and that turn is meaning-invisible from then on, while `/status` shows a missing count that never clears. The canonical item survives (lift makes a new `version_id`), so this is recall loss, not a leak.
- **Fix:** give history vector ids a generation (for example `${eventId}:${liftCount}` or the lift transition id) so a restored turn is a new ledger row, or resurrect the row by tracking re-index state in a column the update guard allows. Pin with F2.

## Low

### L1. A slow canonical candidate query still throws away meaning and history results that were ready

- **Where:** `telegram-memory-retriever.ts:979-981`, `:1009-1013` — candidates have no sub-deadline inside the 800 ms memory window, unlike history (`:983-1000`) and meaning (`:1131-1141`).
- **Proven:** `L3 a slow canonical candidate query does not discard meaning evidence that was ready in time` **FAILED**: 900 ms delay on the `memory_item_fts MATCH` statement only. Meaning answered at 15 ms with the passport statement; the turn logged `telegram_memory_retrieval_memory_timeout` at 849 ms and delivered **0** memory contexts.
- **Fix:** the same treatment history got — a candidate sub-deadline that degrades to "no canonical candidates" and keeps what is ready.

### L2. The acknowledgement skip list covers only the six phrases named in round 1

- **Where:** `telegram-memory-retriever.ts:104-107`, `:515-517`.
- **Proven:** `L2 ordinary acknowledgements make no Workers AI or Vectorize call…` **FAILED**: `thanks jarvis, ok thanks, cool thanks, got it, sounds good, nice, yeah, yep, sure, no, ty, thx, good morning, haha, perfect` each made an embedding call and a Vectorize query. Real short questions (`who is maya?`, `my wifi password?`, `when's my dentist?`, `where's my passport?`) all still search, which is correct.
- **Fix:** skip when the message has no content term after removing a leading/trailing acknowledgement, or gate on a minimum number of non-stopword terms, rather than an exact-phrase list.

### L3. A memory's own source turn comes back twice once meaning search finds it

- **Where:** `telegram-memory-retriever.ts:1036-1040` adds candidate source ids to the *literal* exclusion set only; meaning history hits are not checked against them.
- **Proven:** `Q5 a remembered item found by meaning search is not repeated as its own source turn` **FAILED**: context holds both `Memory evidence [item …]: my favourite class is chemistry.` and `History evidence [live D1; event 01m2r7v5ggh2ka7h5vhwyq1hy4 …]: Remember that my favourite class is chemistry.`, both with the same `sourceEventId`. This is PR #87's F4 finding, reappearing on the meaning path.
- **Fix:** exclude candidate (and item-hit) source event ids from meaning history contexts too, before fusion.

### L4. Repeating a question immediately still yields no literal history (pre-existing)

- **Where:** `telegram-memory-retriever.ts:1032` — `recentContextCoversQuery` is computed over the recent window, which now contains his previous identical question.
- **Proven:** `Q3c …still works when Sid repeats the question right after asking it` **FAILED**: first ask returns the statement, the immediate second ask returns nothing. By reading, main behaves the same, so this is not a regression — but it is the common "ask again because the answer was wrong" case, and the new question-only notion is exactly what coverage should ignore.
- **Fix:** exclude question-only recent turns from `recentContextCoversQuery`.

### L5. The deploy runbook's meaning-search numbers are from round 1

- **Where:** `docs/runbooks/deploy.md:129-136`: "at most eight total Vectorize mutations … one Workers AI embedding request with eight inputs and 65,536 UTF-8 bytes … fewer than 32 D1 statements". The code is 128 mutations, 128 inputs, 4 MiB, 264 statements (`meaning-search.ts:28-35`).
- **Fix:** restate the real caps (and the corrected input cap from H1). The two `wrangler vectorize` commands and the metadata-index-before-insert ordering are correct — see "checked and sound".

### L6. The new de-duplication, grounding and indexing guards have no kill tests

Mutations run against the builder's named suites (`meaning-search`, `telegram-memory`, `literal-history`, `memory-repository`, 129 tests). **These survived, 129/129 green:**

- Retriever de-dup, all new this round: candidate-source id exclusion (`:1038`), `sameText(hit.excerpt, captured.query)`, `questionOnly`, the seen-text set, and the `retained.length >= MAX_HISTORY_RESULTS` trim (`:1045-1051`).
- Meaning grounding: `envelope.eventId`/`subjectId` identity (`:1277-1278`), `payload.sensitivityCode`/`historyEligible` (`:1289`), the chunk `content_hash` and `sha256(chunkText)` checks (`:1267`), the `!visibility.retrievable` item check (`:1250`), the `memory_retrievable_item_versions` join (`:1188-1190`), the item version/hash equality check (`:1248-1249`), the result-count guard (`:1213`), and the "skip a NULL event id" behaviour (`:1260`).
- Indexer: the owner-only `event_type` filter in the candidate SQL (`:572-573`) and in the stale-delete SQL (`:517-518`), the 4 MiB byte cap (`:584-585`), the archived payload-text check (`:611`), the ledger partial-failure acceptance (`:458-460`), the "capacity minus deletes" split (`:413`), and the embedding-count check (`:418`).
- PR #87 follow-ups: the archive-unavailable item skip (`memory-repository.ts:1311`) and both halves of the literal over-fetch fix (`literal-history.ts:577-582` assistant exclusion, `:605` trim to `maxResults`).

Killed properly: the meaning 450 ms deadline, the recent-turn filter, the assistant-reply rejection, the event text/hash check, the acknowledgement list, items-first ordering, the search-result principal/score/metadata validation, and the coverage owner-only condition.

**Gate flake worth fixing:** 1 of 3 unmutated baseline runs of those four suites failed `Telegram memory target selection and replay guards > resolves that only to the memory injected into the previous reply…`. Unrelated single-test "kills" during the sweep matched this pattern, so treat wall-clock-sensitive tests in that file as flaky, not as coverage.

---

## Checked and sound

- **Forgetting across all three paths (F1, passes).** Real turn → `remember` → Jarvis restates it in a reply → forget → index → lift → forget again, with 70 filler turns and a second principal holding a similar secret. After each forget the word appears in **no** context: not canonical, not literal, not meaning, not through Jarvis's own restatement, and not while the stale vector is still live (73 vectors present at that moment). The other principal's secret never appears. Round 1's H1 is genuinely closed: meaning history is re-read through `TieredEventReader`, and speaker, provenance, event identity and text hash are all verified before admission.
- **Latency, round 1's H2 closed (L1, passes).** 18 runs through the production service at 25 ms per D1 round trip with injected AI/Vectorize latency 50–400 ms: keyword memory survived every run, no `telegram_memory_retrieval_memory_timeout`, 12 round trips, total 252–483 ms — well inside the 800 ms bound. Meaning results that arrive by ~250 ms are used, not discarded. A failing provider falls back in 86 ms with `memory_meaning_search_provider_error`; a hanging provider is cut off at ~455 ms with `memory_meaning_search_timeout`, keyword memory intact in both.
- **Paraphrase end to end (Q1, passes).** "How do I open my bicycle padlock?" returns `My bike lock combination is 4417.`, and "Which subject do I like best?" returns the chemistry item — both only with meaning search on, both absent with it off.
- **Fusion (Q4, passes).** A statement found by both literal and meaning search appears exactly once in context.
- **Indexer batching, order, idempotency (I2, passes).** One embedding call and one upsert per run; the two newest items are embedded before 130 older history chunks; a failed upsert leaves 0 ledger rows and the retry is clean; 134 ledger rows, all distinct; 131 D1 statements in the largest run (≤264); `remaining` reaches false.
- **Cloudflare API shapes and the deploy note.** `@cf/baai/bge-m3` `{text: string[]}` → `{data: number[][]}` with 1,024 dimensions matches the model page and workers-types 5.20260830.1; `upsert`, `deleteByIds` and `query` match the `Vectorize` types; `topK` 4 with `returnMetadata: "all"` is inside the documented 50; vector ids are 64 hex characters (limit 64 bytes); upsert batches of ≤128 are inside the 1,000-per-batch Workers limit. The runbook's two commands are right, including `--property-name=principal --type=string`, and the ordering matters exactly as stated: "Vectors upserted before a metadata index was created won't have their metadata contained in that index" (developers.cloudflare.com/vectorize/reference/metadata-filtering/).
- **Scope.** No migration; `voice/**`, `calls/**`, `school/**`, `university/**`, `backup/**` untouched.

## Unverified

- Whether Workers AI enforces `maxItems: 100` at runtime for `@cf/baai/bge-m3`. H1's proof is the published schema plus a fake that honours it; I made no real Workers AI call. If the runtime is lenient, H1 drops to "undocumented reliance", but the 60,000-token context window still bounds a 4 MiB batch and is untested.
- Real production latency for Workers AI embed + Vectorize query. At 25 ms per D1 round trip the canonical re-reads cost ~180 ms of the 450 ms meaning window, so a search slower than ~270 ms loses its results (seen at 300 ms and 400 ms in L1). Harmless for keyword recall, but it sets the real budget.
- Whether `wrangler deploy --strict` fails when `jarvis-memory-bge-m3` does not exist (round 1 left the same question open). Keep the two commands as a pre-deploy step.
- Sid's real pending count at deploy time, which decides whether H1 bites on the first run or after a few days.
- Q3c's "also on main" claim is by reading only; I did not run it against main's retriever.
- D1 read cost of the new meaning recall SQL: `memory_history_chunks` has no index on `content_hash`, so each hit scans the principal's chunks. Fine at today's volumes, untested at 5,000+.
