# PR #83 round 3 narrow review, head `fb431d3`

**Verdict: B1–B5, S1–S3 and N1–N6 are real fixes in production code, not test-shaped — 12 of 16 mutations were killed by named permanent tests. One new defect: 1 Medium, 3 Low. The Medium is a never-self-healing indexing stall on a narrow input shape; everything the round-2 review proved broken is proven fixed.**

Tests: `C:\Users\Sid\jarvis-pr83-adv\apps\cloud-gateway\test\memory\adversarial-pr83r3.test.ts` (detached at `fb431d3`, frozen install). Final run: **20 tests, 18 passed, 1 failed (G1 — the Medium), 1 skipped (dump)**. Every assertion runs through the production `MemoryMeaningService`, the production `TelegramMemoryRetriever` and the production Telegram conversation service. No real Workers AI, Vectorize, DeepSeek or Telegram call; no push, merge, deploy or cloud resource. All 16 source mutations were reverted; `git status` in the worktree shows only the three untracked reviewer test files.

---

## Medium

### M1. The question-shape filter disagrees between SQL and TypeScript, so a turn ending in `?` plus any non-space whitespace stalls the index forever

- **Where:** `apps/cloud-gateway/src/memory/meaning-search.ts:702` — `if (candidate.text.trim().endsWith("?")) return false;` — against the three SQL sites that decide the same thing: `:227` (`readMemoryMeaningCoverage`), `:584` (`readDeleteCandidates`), `:676` (`readIndexCandidates`), all `AND substr(rtrim(chunk.text), -1, 1) <> '?'`. The stall path is `:741-746` (`hasPendingWork` → `readCoverage`) and `:513-514` (`if (!remaining) await this.advanceCursor(...)`).
- **Why they disagree:** SQLite's one-argument `rtrim(X)` strips **spaces only** (0x20). JavaScript `String.prototype.trim()` strips all Unicode whitespace. So for text ending `"…passport?\u00a0"` (or `"?\n"`, `"?\t"`) the SQL says "not question-shaped → eligible and pending", and the TypeScript says "question-shaped → skip". The row is counted as eligible forever and never indexed. The inclusion is one-directional (SQL-excluded ⊆ JS-excluded), so this is the only shape that can diverge.
- **Proven:** `G1 a turn ending in a question mark plus a non-breaking space does not stall the index` **FAILED**. Three owner turns, one of them `"Where is my spare car key?\u00a0"`. Run 1 upserted the two ordinary turns; runs 2–6 upserted 0 and all reported `remaining: true`; `readMemoryMeaningCoverage` stayed `{ eligible: 3, indexed: 2, missing: 1 }`. Causation isolated by mutation: changing only `:702` to `candidate.text.replace(/ +$/u, "").endsWith("?")` (SQL's rule) makes G1 pass on the first run; the mutation was reverted.
- **Effect for Sid:** the hourly job reports "work remaining" and a non-zero missing count for the rest of the deployment, and `advanceCursor` is never called again for that principal (the `embeddings` cursor is write-only today, so nothing else breaks, but the `/status` signal he is meant to read becomes permanently wrong and the "backfill finished" condition can never be reached). It is also a slow poison: every such turn is re-selected inside the 128-row candidate window on every run forever, so a long enough run of them would crowd out genuinely new chunks. Reachability from a real message is by reading, not by test: `channels/telegram/telegram-webhook.ts:307` passes `message.text` into redaction untrimmed, and nothing between there and `literal-history.ts:1132` (which stores `event.text` verbatim) trims it — so a pasted or iOS-composed message ending `?` + NBSP/newline is enough.
- **Fix:** make the two agree. Either give the SQL the same character set — `rtrim(chunk.text, char(32) || char(9) || char(10) || char(13) || char(160))` at `:227`, `:584` and `:676` — or drop `:702` and let the SQL be the single rule (the JS check is otherwise redundant; see L1). Pin with a chunk whose text ends `"?\u00a0"`, asserting `coverage.missing === 0` **and** `remaining === false`.

---

## Low

### L1. Four new guards have no named permanent test; two of them are exactly the pair that let M1 through

A 16-mutation sweep over the builder's four named suites (`meaning-search.test.ts`, `telegram-memory.test.ts`, `literal-history.test.ts`, `memory-repository.test.ts`; baseline **176/176 green**). Twelve mutations were killed by a named test (listed under "fixed and proven"). These four survived **176/176**:

- **`meaning-search.ts:676`** — deleting the SQL `AND substr(rtrim(chunk.text), -1, 1) <> '?'` from `readIndexCandidates`. Survives because `:702` still skips the row; nothing asserts that a question-shaped chunk is *excluded from coverage*, which is precisely why M1 above is invisible to the suite.
- **`meaning-search.ts:702`** — deleting the TypeScript `candidate.text.trim().endsWith("?")` check. Survives because the SQL still excludes it. `does not index question-shaped owner turns that could crowd out their answer` (`meaning-search.test.ts:1191`) is killed by neither half alone, so it covers the pair, not either guard.
- **`telegram-memory-retriever.ts:69`** — `MIN_RECENT_EVIDENCE_CHARACTERS` 24 → 0. Near-equivalent in behaviour (forward containment by a very short recent turn is still a fair drop), so this is a weak survivor, but the specific threshold is unpinned.
- **`meaning-search.ts:622`/`:673`** — deleting `AND vector.deleted_at IS NULL` from both "already indexed" `NOT EXISTS` checks. Redundant given the lift generation in the item id (that change alone makes a lifted turn a new ledger row), so this is defence in depth with no test behind it.

**Fix:** add one named test asserting coverage convergence with a question-shaped chunk present — that kills the first two and closes M1's blind spot at the same time. The other two are worth a line each or an explicit "redundant" comment.

### L2. The 4 MiB embedding byte cap is now unreachable for ordinary text, but the runbook states it as a live bound

- **Where:** `meaning-search.ts:31` (`embeddingInputBytes: 4_194_304`), `:689-690`; `docs/runbooks/deploy.md:145-147`.
- **Proven by construction:** the input count is now hard-capped at 100 (`:689`) and `indexCandidate` caps each text at 32,768 characters (`:308`, `safeString(row.text, 32_768)`), with `memory_history_chunks.text` checked to 32,768 **bytes** at `0016_cloud_memory.sql:577`. So an all-ASCII batch cannot exceed ~3.2 MB; B1b asserts the observed batch bytes stay under the cap, and with ordinary turn lengths the real batches are a few kilobytes. The cap can still bind on multi-byte text, so it is not dead code — but "100 inputs **and** 4,194,304 UTF-8 bytes" reads as two live limits when in practice only the first ever fires.
- **Fix:** one clause in the runbook noting that the byte bound is the secondary one.

### L3. `memory_history_chunks` still has no index that the meaning canonical read can use

- **Where:** `0016_cloud_memory.sql:566-600` — the table has only `chunk_id` UNIQUE and `(principal_id, chunk_id)` UNIQUE. The meaning recall join is `telegram-memory-retriever.ts:1285-1287`: `JOIN memory_retrievable_history_chunks chunk ON requested.item_kind = 'history_chunk' AND chunk.principal_id = ? AND chunk.content_hash = requested.content_hash`.
- **Effect:** an index on `(principal_id, content_hash)` would be used by that ON clause, turning a scan of the principal's whole chunk table into a lookup, up to four times per meaning-enabled turn. Round 2's N5, unchanged. Fine at today's volumes; see the ruling below.

---

## Fixed and proven

- **B1 — embed call capped at ≤100.** `meaning-search.ts:30` (`embeddingInputs: 100`) is enforced in `readIndexCandidates` at `:689` (`candidates.length >= MEMORY_MEANING_INDEX_LIMITS.embeddingInputs`), so the single embed call at `:464` can never exceed 100, while `mutations` stays 128 and is spent first on deletes (`:460`, `remainingCapacity = mutations - deleted`). Total mutations per run therefore stay ≤128 in every split.
  - `B1a exactly 100 pending rows drain in one run…` **PASS**: one call of 100 inputs, 100 vectors stored, `missing: 0`, `remaining: false`.
  - `B1b exactly 101 pending rows drain across runs…` **PASS**: batch sizes 100 then 1, max bytes 5,858, 101 vectors, every run `upserted + deleted <= 128`, `missing: 0`, `remaining: false`. Driven through the real `WorkersAiMemoryEmbeddingProvider` against an `Ai.run` that throws on >100, exactly as round 2's I3 did.
  - `B1c a run that both deletes and embeds…` **PASS**: 140 chunks indexed, then every chunk's text and hash rewritten so the live vectors go stale and fresh candidates appear in the same run; every run stayed `outcome: "indexed"`, `upserted + deleted <= 128`, inputs ≤100.
  - Mutation: `embeddingInputs` 100 → 128 killed the named `keeps the 100-input bge-m3 request inside the byte ceiling and independent mutation cap`.
- **B2 — archived history through the receipt path.** The three archived joins (`:205-218` coverage, `:551-564` stale delete, `:645-658` candidates, plus `telegram-memory-retriever.ts:1290-1303`) now match on `archived.event_sequence` plus an `EXISTS` over `memory_history_coverage` (principal, range, `source_location = 'archived'`, `r2_segment_id = archived.segment_id`, `indexing_outcome = 'indexed'`, `content_hash = archived.envelope_sha256`); `archive_segment_events.subject_id` is gone. `events.sequence` is a global `INTEGER PRIMARY KEY AUTOINCREMENT` (`0001_foundation.sql:98`), so dropping the `subject_id` predicate cannot match another principal's event, and the `EXISTS` is principal-scoped regardless. `isOwnerHistoryCandidate` (`:718`) now **returns false** rather than throwing for a non-owner event type, while identity mismatches (`:712-714`) still throw.
  - `B2a an archived owner chunk whose archive row has a NULL subject stays indexed, recallable and converges` **PASS**: real `ArchivalService` archival, `with_subject: 0`, 4 vectors retained, `deleted: 0`, `missing: 0`, `remaining: false`, and "Archived owner note …" comes back through meaning recall.
  - `B2b an archived assistant chunk is a skip, not a throw…` **PASS**: all runs `indexed`, a brand-new remembered item indexed, `missing: 0`, `remaining: false` — with `subject_id` left NULL, i.e. the real production shape, not round 2's back-filled one.
  - `B2c a chunk whose archived receipt is missing neither throws nor stalls the cursor` **PASS** and `B2d a chunk whose archived receipt hash does not match the segment neither throws nor stalls` **PASS** (coverage immutability triggers dropped for the injection, restored after): in both cases the chunk simply stops resolving an event id, is excluded from coverage as well as from candidates, and the run reaches `remaining: false` with `missing: 0`.
  - Mutations: reverting the candidate join to `archived.subject_id = chunk.principal_id` killed `keeps receipt-bound archived owner history indexed when archive subject_id is null` and `fails an archived owner candidate whose verified payload text differs from the indexed chunk`; turning the non-owner skip back into a throw killed `skips an archived assistant chunk without stalling a newer canonical item or coverage`.
- **B3 — literal de-dup no longer drops real answers.** `telegram-memory-retriever.ts:1085-1086` now drops a hit only when a recent turn is `>= MIN_RECENT_EVIDENCE_CHARACTERS` (24, `:69`) **and** contains the excerpt; the reverse `hit.excerpt.includes(context.text)` is gone, and `questionOnly` (`:527-529`) is now only `value.trim().endsWith("?")`.
  - `B3a a short genuine answer under 24 characters survives a short recent acknowledgement` **PASS**: the 20-character answer `Bike lock code 8421.` survives an `ok` turn in the recent window (round 2's Q3a shape, at the new threshold).
  - `B3b a hit already present verbatim inside a long recent turn is still dropped` **PASS** — the intended de-duplication is intact.
  - `B3c a recent turn shorter than 24 characters that contains the hit does not duplicate it` **PASS**: `PIN 8421` under a 12-character recent turn `PIN 8421 yes` yields at most one history copy.
  - `B3d a real trailing-question-mark turn is still never returned as history evidence` **PASS**.
  - Mutations: restoring `|| hit.excerpt.includes(context.text)` killed `keeps literal evidence when a short recent acknowledgement is only a substring of the answer`; neutering `questionOnly` killed four named tests including `does not let the previous identical question count as literal query coverage` (N1) and `drops same-query, question-shaped, and normalized seen-text meaning history before fusion`.
- **B4 — repeated identical questions.** Question-shaped owner turns are excluded at index time (`meaning-search.ts:676`, `:702`) and again before fusion (`telegram-memory-retriever.ts:1107-1117`: current-turn text, question shape, normalized seen text, candidate and item source ids).
  - `B4a five identical asks ending in ? never drown the original statement` **PASS**: the passport statement is returned and the question appears exactly once (as the current turn).
  - `B4b five identical asks without a question mark never drown the original statement` **PASS** — the case the index-time `?` filter does *not* cover; the seen-text and same-query filters carry it.
  - Mutations: removing the `sameText`, `questionOnly` or `meaningSeenTexts` clause each killed `drops same-query, question-shaped, and normalized seen-text meaning history before fusion`.
- **B5 — forget then lift, twice.** The history vector id now carries a generation: `event_id || ':' || <newest applicable lift_id>`, computed identically in all four places (`:196-208` coverage, `:569-581` stale delete, `:624-636` candidate select, `:658-670` candidate `NOT EXISTS`), while `metadata_item_id` stays the bare event id so recall still matches (`:290`, `:301-303`, `:481`).
  - `B5a forget then lift twice keeps the turn indexable, leaves no orphan vector and never leaks` **PASS**: two full forget → index → lift → index cycles. After each forget the word appears in **no** context (including while the stale vector is still live, before the delete run); after each lift meaning recall returns it again, `missing: 0` and `remaining: false`; and at every checkpoint the Vectorize store count equals the count of `memory_vectors` rows with `deleted_at IS NULL` — no orphans, no leaked generations. Collision is structurally impossible: the newest lift is selected by `ORDER BY lift.created_at DESC, lift.lift_id DESC LIMIT 1`, so a second lift yields a different id and the previous generation becomes a stale-delete candidate.
  - Mutation: collapsing the generation back to the bare event id killed `re-indexes a lifted history turn under a new ledger generation while keeping its event metadata id`.
- **S1 — candidate sub-deadline.** `:1005-1012` wraps `readCandidateContexts` in `timedOutcome` at `candidateSearchTimeoutMs` (450 ms, validated at `:826-829`) with its own `StatementBudget`; a timeout degrades to no canonical candidates (`:1049-1051`) while an error still fails closed (`:1045-1047`). The meaning window is now split explicitly, 270 ms search + 180 ms canonical reads (`:61`, `:1186-1191`).
  - `S1a a slow canonical candidate query keeps ready meaning evidence (three runs)` **PASS 3/3** (wall-clock, so run three times and reported as such): a 900 ms delay on the `memory_item_fts MATCH` statement alone; every run logged no `telegram_memory_retrieval_memory_timeout` and delivered the passport statement exactly once. This is round 2's L1 closed.
  - `S1b a meaning provider answering inside the reserved search window is still used (three runs)` **PASS 3/3** at a 150 ms provider delay.
  - Mutation: removing the sub-deadline killed `keeps ready meaning evidence when the canonical candidate query exceeds its own deadline`.
- **S2 — term-based acknowledgement skipping.** `shouldSkipMeaningSearch` (`:523-525`) now skips when **every** recall term is an acknowledgement term (`:107-111`), not on an exact-phrase match.
  - `S2a acknowledgement terms make no Workers AI or Vectorize call while real short questions still search` **PASS**: all 20 of round 2's L2 phrases (`thanks jarvis`, `ok thanks`, `cool thanks`, `got it`, `sounds good`, `nice`, `yeah`, `yep`, `sure`, `no`, `ty`, `thx`, `good morning`, `haha`, `perfect`, `ok cool`, `good night`, `what's up`, `lol`, `hey`) made zero embedding calls and zero Vectorize queries; all 7 real short questions still searched, including three built deliberately from acknowledgement words (`what is my morning plan?`, `is the night bus running?`, `how good was my last mark?`).
- **S3 — a memory's own source turn.** `:1098-1105` builds `itemSourceEventIds` from the canonical candidates **and** from `item:`-keyed meaning hits, and `:1112` excludes `history:` meaning hits carrying those ids.
  - `S3a a remembered item found by meaning search is never repeated as its own source turn` **PASS**: one chemistry context, distinct source ids.
  - Mutation: removing the item-source exclusion killed three named tests including `does not repeat a remembered item as meaning history from its own source event`.
- **N1** `withoutCurrentTurn(...).filter((context) => !questionOnly(context.text))` at `:1067-1068`; named test `does not let the previous identical question count as literal query coverage`, killed by the `questionOnly` mutation.
- **N2** `docs/runbooks/deploy.md:145-150` now states 128 mutations, one embedding request with 100 inputs and 4,194,304 bytes, two Vectorize mutation requests, 264 D1 statements, and 50 hourly runs for a clean 5,000-event backlog. Matches the code.
- **N3** Named behavioural tests now exist for the guards: 12 of 16 mutations killed one, listed above. The four survivors are L1.
- **N4** `telegram-memory.test.ts` ran 17 times across the mutation sweep; `resolves that only to the memory injected into the previous reply…` never flaked, and all 17 baseline-equivalent runs of the four suites were deterministic apart from the intended kills.
- **N5** Deferred — ruling below.
- **N6** Still open; see "unverified".

---

## Ruling on the deferred `memory_history_chunks(content_hash)` index

**The outcome is acceptable; the stated reason is not, and should not be repeated.**

- The hazard the builder names is real. `memory-backup-restore.ts:243-270` (`migrationSqlThrough`) selects the inventory prefix up to the backup manifest's `databaseSchemaVersion` and throws `memory_backup_restore_migrations_missing` when that name is absent. So if `0032` were applied to production and a backup taken, that backup would be unrestorable until the inventory listed `0032`. That part is correct and worth having caught.
- But "protected" is the builder's own word, used nowhere else in the repository: there is no protected-domain rule in `docs/BUILDING.md`, `docs/` or `.github/`, and the only occurrences of the phrase in `docs/AGENT_LOG.md` are the builder's own entries. `memory-backup-restore-migrations.ts` is an ordered list of 31 `import` statements and 31 `Object.freeze({ name, sql })` entries. Adding restore support for a `0032` is **two lines**. Nothing prevented it.
- The genuine cost is the ceremony, not the code: a new migration means another scratch-D1 rehearsal and another "Sid applies it to production before the deploy" step, on top of the `0031` he applied today. That is a real reason to defer a performance-only index, and it is the reason that should have been written down.
- On the merits of the index itself: it is not on the correctness path, so deferring is right for this PR, but it is not cosmetic either. The ON clause at `telegram-memory-retriever.ts:1285-1287` filters on exactly `(principal_id, content_hash)` and the table has no index covering it (`0016_cloud_memory.sql:566-600` — only `chunk_id` and `(principal_id, chunk_id)`), so each meaning hit scans the principal's chunks, up to four per turn. Worth pairing with `(principal_id, start_event_sequence)`, which the same joins also need, in whichever migration comes next — with the inventory line added in the same commit.

---

## Unverified

- Whether Workers AI enforces `maxItems: 100` for `@cf/baai/bge-m3` at runtime. B1a–B1c prove the code honours the published schema; no real Workers AI call was made. The cap is right either way.
- Whether Telegram in practice delivers a message ending `?` plus non-space whitespace. M1's stall is proven at the chunk level and the absence of any trim between `telegram-webhook.ts:307` and `literal-history.ts:1132` is by reading, not by an end-to-end send.
- Real production latency for Workers AI embed plus Vectorize query, and therefore whether the new 270 ms search / 180 ms canonical split is the right division. S1b only proves 150 ms works.
- Whether `wrangler deploy --strict` fails when `jarvis-memory-bge-m3` does not exist (N6, open since round 1). The two one-time `wrangler vectorize` commands stay a pre-deploy step.
- D1 query plans. No `EXPLAIN QUERY PLAN` was run; L3's cost claim is from the schema and the ON clause, not from a measurement.
- Lint, typecheck, the round-2 reviewer suite and the full 5,074-test run were not repeated — the main reviewer ran them at this head.
- PR #86 collision surface, by reading only: this diff rewrites `TelegramMemoryRetriever.retrieveMemory`'s signature (three dependency sets plus three budgets), the meaning-hit filter block at `:1096-1117`, and the `readMeaningHits` SQL at `:1250-1305`. Any parallel change to those three regions will conflict textually; I did not read PR #86.
