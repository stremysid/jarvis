# Memory redesign: the AI writes, code only stores

**Subordinate to [`2026-09-19-jarvis-roadmap.md`](2026-09-19-jarvis-roadmap.md), which is
Sid's own document and wins over this one.** This is the builder-facing plan for Phase 2
("Memory"). Where the two disagree, the roadmap is right and this file is stale.

**Refreshed 2026-09-24 by Claude (orchestrator agent, Opus 5.5)** against `origin/main` =
`b0cddc5`. The memory code is identical at `a7cd355` and `b0cddc5`: `git diff a7cd355 b0cddc5
-- apps` is empty. Every code citation below is "symbol, as of `b0cddc5`" unless another sha
is named. The first version of this spec (DeepSeek V4.1 Flash, 2026-09-19, at `1b9cec5`) is in
the branch history at `4f570fa`. Its inventory of code that judges now lives, in fuller form,
in `docs/CODE-VS-JUDGMENT.md` on [#187](https://github.com/stremysid/jarvis/pull/187)
(branch `docs/principles-and-removal-list` at `934419c`), cited below as ME-n and AG-n.

**Revised 2026-09-24, 10:35 PM, after the first DeepSeek audit of `e9dfcdf`.** That audit found
three problems, all fixed here: §3.5 deleted only part of ME-16; §3.3's voice half named the
wrong things to change; and §2 described `searchLiteral` as "live D1 only". Re-checked against
`origin/main` = `63eeae3`. `git diff b0cddc5 63eeae3 -- apps/cloud-gateway/src` changes only
`school/collector-repository.ts`, so every `b0cddc5` citation below still holds at `63eeae3`.

**Claude-authored. Needs a DeepSeek re-audit before anyone builds from it.** No test was run and
nothing in production was queried for this refresh. It rests on reading code at the named
shas and on the Hermes research note (Hermes Agent at `3d7fc8f`, cited H@3d7fc8f).

**Memory is priority 1, alongside school and calling.** Sid, 2026-09-24: "Jarvis is utterly
useless without a really really strong memory side." The first things to build are **phase 1**
(memory-fixes: consolidation, newline history indexing, the backup cut) and **`history_search`**
(phase 4a: a search over every stored message, on calls and Telegram). §6 says why these two
can start now.

**Sid's rules this plan touches:** 1 (the AI decides), 2 (receipts, not grading), 3 (calls
and Telegram are the same), 4 (store everything), 7 (cloud, because the PC is off overnight),
8 (focused tests locally, full suites on CI), 9 (never guess).

---

## 1. The rule

> **The AI writes memory. Code stores it, counts it and reports on it.** When code refuses
> something the AI wrote, it says why in the same run and lets the AI try again. Code never
> grades wording, headings or phrasing.

This is Hermes Agent's split (H@3d7fc8f):

- The model writes through a `memory` tool (`tools/memory_tool.py:memory_tool`), in the
  foreground and in a background review (`agent/background_review.py`).
- Code keeps the plumbing: atomic writes, a size budget, duplicate and drift checks.
- A refusal goes straight back to the model with the current entries and "retry … all in
  this turn" (`MemoryStore.add`). After three failures the tool says "Stop retrying"
  (`_MAX_CONSOLIDATION_FAILURES_PER_TURN`).

Jarvis keeps its own storage. The D1 ledger, R2 archive and Vectorize index give cloud access
with every PC off, provenance, append-only versions, and "forget" hiding the evidence too.
Hermes has none of those (its memory is `~/.hermes` on the host). **We copy Hermes's boundary,
not its storage.**

**The provenance carve-out still holds.** "This excerpt appears in a stored message Sid sent" is a
fact code can check, and a receipt. "This is worth remembering", "this paraphrase is faithful"
and "this note has the right headings" are judgments, and they belong to the AI.

---

## 2. What is true at `b0cddc5`

What exists and is shared:

- **Nine memory tools, one definition, both channels.** `memory/memory-tools.ts:MEMORY_TOOL_DEFINITIONS`
  (remember, correct, forget, restore, confirm, explain, search, pin, unpin) is spread into
  `channels/telegram/owner-telegram-agent.ts` and `voice/voice-agent.ts`. Both extend
  `agent/owner-agent-core.ts:OwnerAgentCore`, which dispatches them.
- **Core profile.** `memory/core-profile.ts:readCoreProfile` reads `memory_pinned_item_versions`
  `ORDER BY item_id LIMIT 40` (`MAX_CORE_PROFILE_FACTS`). `OwnerAgentCore.streamCaptured`
  injects it on every turn on both channels.
- **Storage.** D1 ledger, living notes (`0032`), pins and lifetime (`0038`), literal history
  (`memory_history_chunks` and `memory_history_fts`), R2 archive, and Vectorize bge-m3. All of
  it is in the cloud.

What is broken, with the mechanism:

1. **Nightly consolidation is refused whole.** `memory/living-notes.ts:parseActions` throws
   `memory_consolidation_provider_output_invalid` for the entire step if:
   - any note lacks the four exact headings (`noteHasRequiredSections`);
   - a supplied `sourceId` is not repeated inside the Markdown;
   - the Markdown contains a ULID that is not in `sourceIds` (`ULID_IN_TEXT`);
   - any requested topic has no note;
   - an extra JSON key appears (`exactRecord`).

   The workflow then calls `finalizeRun(run, "failed", …)` and returns. **The model is never
   told why and never retried.** ME-27 lists this. The production failure code is recorded in
   the Hermes note; that it happened "every night since Sep 18" was not re-queried.
2. **History indexing stops at the first line break.** `literal-history.ts:rowText` treats
   `/[\u0000-\u001f…]/`, which includes `\n`, as `memory_history_corrupt`. `indexSequences`
   calls `historyEvent`, and `historyEvent` calls `rowText`, for every event in the window. So
   one multi-line message throws before the cursor advances, and indexing stops there for
   good.

   The same `historyEvent` also halts the cursor, rather than skipping one row, when:
   - `sensitivityCode !== 1`;
   - `historyEligible !== true`;
   - an `assistant_delivered` event has `channelCode !== 2` (`sourceChannel`);
   - `redactor.redactText(text)` would change the stored text.

   **Hazard, inferred from code and not observed:** any change to redaction rules can make
   older stored rows fail that last check, which would stop indexing. #183 changes redaction
   rules, so this matters. The exhaustive scan (item 3) calls the same `historyEvent`, so the
   same rows fail a scan job too.

   **The code fix alone does not unstick indexing.** `memory_history_chunks.text` has a CHECK in
   `0016_cloud_memory.sql` that refuses characters 1 to 31, which includes `\n`. Even after
   `rowText` allows a newline, the chunk insert fails and the cursor still does not move.
   memory-fixes' own commit (`87df9ce`) says so and leaves it in `KNOWN_ISSUES.md`.
   `memory_literal_search_jobs.query_text` (`0025_archive_literal_history.sql`) has the same
   CHECK.
3. **No tool searches conversation history.** `memory_search`'s own description says
   "conversational history is not searched". The search code exists, but its only caller is
   the automatic Telegram retriever (`telegram-memory-retriever.ts`, one `searchLiteral` call).
   What each piece covers:
   - **`LiteralHistoryService.searchLiteral`** runs an FTS5 `MATCH` on `memory_history_fts`,
     joined to the `memory_retrievable_history_chunks` view, single-event chunks only. It then
     re-reads each candidate from where the event now lives: the live `events` table in D1, or,
     when the sequence is at or below the archive's `sealed_through`, the R2 archive through
     `events.readRange` (`searchCandidateHits`). So it covers **every indexed message, live or
     archived**. It does not cover:
     - events the indexer has not reached yet. It says so, returning `status: "incomplete"` with
       a `missingRange`;
     - Jarvis's own replies. The SQL excludes `assistant_delivered`, and `searchCandidateHits`
       drops `speaker === "assistant"`;
     - suppressed ("forgotten") turns.

     It refuses outright when the archive circuit is not `closed`.
   - **`createExhaustiveSearch`, `runExhaustiveSearchStep` and `readExhaustiveSearchResult`** do
     not use the index. They scan the raw event stream, live and R2 alike through
     `events.readRange`, from a checkpoint up to a snapshot sequence. They run `historyEvent` on
     each event and keep owner messages only (`speaker === "user"`). They cover what the index
     has not reached. **Nothing outside `literal-history.ts` calls them on main**, so nothing
     drives a scan job today.

   So the two paths split into "indexed" and "not yet indexed". They do not split into "D1" and
   "R2".
4. **Extraction is decided by code.** The hourly `POLL_CRON` (`0 * * * *`) runs
   `jobs/job-table.ts:poll`, then `distilMemory`, then `AutomaticMemoryDistillationWorkflow`.
   A model proposes facts, but `automatic-distillation.ts:commitInput` makes an item `active`
   only when `extraction-policy.ts:isAuthenticatedFirstPersonQuote` passes on a live source
   (ME-6, ME-7, ME-30). Everything else stays `proposed`.
5. **Calls and Telegram recall differently.** `voice/production-runtime.ts` composes
   `new D1ContextRetriever(env.DB)`. `index.ts` gives Telegram `TelegramMemoryRetriever`
   (items, living notes, literal history, meaning search). `telegram-memory-retriever.ts:captureInput`
   rejects any channel but `"telegram"` (ME-17).
6. **Profile overflow is silent.** Nothing caps pins: `memory_item_pins` has no count trigger
   in `0038`. The profile shows the first 40 by `item_id`, so pin 41 onward never reaches the
   prompt, and the model is not told.
7. **The foreground cannot retry a refused tool.** `owner-agent-core.ts:MAX_TOOL_CALLS = 1`.
   The second model call runs with `toolChoice: "none"`, so a refused `memory_remember` can be
   explained but not fixed in the same turn (AG-1). The wording graders refuse or downgrade on
   phrasing:
   - `rememberGrounding` and `factVocabularyMatches` (AG-3);
   - `NEGATION` (AG-2);
   - `CONFIRMATION_LANGUAGE` (AG-4);
   - `isAuthorizedRememberText` (ME-12).

In flight, and not on main:

- **[#174](https://github.com/stremysid/jarvis/pull/174)** (`codex/channel-parity` at
  `ca14f01`, open):
  - voice now composes `new TelegramMemoryRetriever({ database, archive, meaningSearch, now })`;
  - `captureInput` accepts `"voice"`;
  - the owner catalogue is shared through `owner-tools.ts`/`owner-pipelines.ts`.

  This is the "one recall path" in item 5. It carries migration `0044_owner_channel_parity.sql`.
  `MAX_TOOL_CALLS = 1` is unchanged on that branch.
- **`codex/memory-fixes`** (`f2f836c`, a local branch in `C:\w\memory-fixes`, **not pushed and
  no PR as of this refresh**):
  - `rowText`/`inputText` allow `\n`, `\r` and `\t` (`FORBIDDEN_TEXT_CONTROL`);
  - `parseActions` and `applyNote` drop the heading check and both in-text id checks;
  - the consolidation prompt stops demanding headings;
  - migration `0047_note_sources_without_markdown_citation.sql` rebuilds
    `memory_topic_note_sources_insert_guard` without the in-Markdown clause;
  - the backup cut fix: a resumed backup run takes its table set from its own stored cuts and
    finds each table by name, not by position in today's list.

  Still unpushed at `63eeae3` time (`git ls-remote` shows no `codex/memory-fixes`).

**Migration numbers depend on merge order.** At `63eeae3` main's highest is `0045`. Open
branches claim three more:
- `0044` on #174;
- `0046` on [#190](https://github.com/stremysid/jarvis/pull/190) (head `8e097f2`);
- `0047` on memory-fixes.

A migration written from this plan takes the next number above the highest one on main **at the
time it merges**. Re-check that number at merge time. If all three branches have landed first, it
is `0048`. Only memory-fixes' `0047` is needed for phases 1 to 4a. Every migration here is remote
D1: additive only, no CASE-wrapped RAISE, and no semicolons in SQL comments.

---

## 3. The five changes

### 3.1 A refusal goes back to the AI in the same run, and it retries

Code checks only facts it owns: the JSON parses, ids exist in what was supplied, sizes fit,
the excerpt appears in a stored owner message. It returns each failure as a short structured
reason, such as `{ field: "sourceIds[2]", code: "not_supplied" }`, and the AI tries again. No
check reads the prose.

**Nightly consolidation** (`memory/living-notes.ts`):
- `parseActions` accepts or rejects **each action on its own**, and returns
  `{ accepted, rejected: [{ index, field, code }] }` instead of throwing for the whole step.
- Then in `LivingMemoryConsolidationWorkflow`, when anything was rejected, send the model one
  follow-up in the same step. It contains the reasons and the actions that failed, and asks
  for corrected versions. Allow at most 2 retries, then record what failed and move on. That
  is Hermes's three-attempt cap.
  - A topic with no note is **not** an error. It stays on the worklist for the next run, and
    the run receipt says so.
  - An unknown JSON key is reported back to the model, not fatal.
- Delete `noteHasRequiredSections`, the `markdown.includes(sourceId)` checks in `parseActions`
  and `applyNote`, and `ULID_IN_TEXT`. **memory-fixes already does this part.**
- `recordStep` already writes each step to `memory_consolidation_model_steps`, so
  each retry gets its own receipt. `finalizeRun` records `failed` only when nothing was
  accepted.

**Foreground tools** (`agent/owner-agent-core.ts`, `memory/memory-owner-controls.ts`):
- Replace the fixed two rounds (round 1 is `toolChoice: "none"`) with a tool loop. It is
  bounded by the turn deadline and stops after 3 refusals in one turn (AG-1).
- Refusals return a code plus the offending field, not a fixed sentence. The AI writes the
  sentence Sid hears.
- Remove the wording graders: AG-2 (`NEGATION`), AG-3 (`rememberGrounding`,
  `factVocabularyMatches`), AG-4 (`CONFIRMATION_LANGUAGE`), AG-5 and AG-6 (question-shape
  grammar), and ME-12 (`isAuthorizedRememberText`).
- Keep the provenance check: the excerpt must appear in a stored owner message. It is a fact,
  and a failure goes back to the AI like any other.

**Test ideas:**
- `test/memory/living-notes.test.ts`:
  - a fake provider returns one good and one bad note. The good note commits, the bad one is
    re-requested with its reason in the follow-up prompt, and the corrected note commits;
  - a provider that fails three times ends with `failed` and three step receipts;
  - a note with no headings commits.
- `test/channels/owner-telegram-agent.test.ts` and `test/voice/voice-agent.test.ts`: a
  `memory_remember` refused for an excerpt that is not in Sid's message gets a second tool
  round, and the corrected call commits. Mutation: restore `toolChoice: "none"` on round 1 and
  the named test fails.

### 3.2 Newlines are text

Take memory-fixes as it stands (`rowText`/`inputText` → `FORBIDDEN_TEXT_CONTROL`). Then fix the
storage half, which memory-fixes leaves open (§2 item 2). This goes in the **phase 1** PR,
because without it production indexing stays stuck.

- **`memory_history_chunks.text` (the `0016` CHECK).** Decision: store a search form of the text
  in the chunk, and leave the table alone. `indexSequences` writes `chunk.text` with each `\n`,
  `\r` and `\t` replaced by a space. FTS5's `unicode61` tokenizer already splits on both, so the
  same queries match. Nothing else changes:
  - `content_hash` stays the hash of the original event text;
  - excerpts are still cut from the original event (`hit` works on the decoded event, not the
    chunk);
  - no migration.

  Code that compares `chunk.text` with the event must compare the search form instead. That is
  `meaning-search.ts:isOwnerHistoryCandidate`, both `envelope.payload.text !== candidate.text`
  and `sha256Hex(candidate.text) !== candidate.contentHash`. Grep on `63eeae3` finds the other
  readers of the chunk text: three SQL reads in `meaning-search.ts` and the canonical history
  read in `telegram-memory-retriever.ts`. The builder checks each one.

  The rejected route is rebuilding `memory_history_chunks` without the CHECK. That rebuild on
  remote D1 would touch an FTS5 external-content table, two immutable triggers, the
  `memory_retrievable_history_chunks` view and the backup table list. It is the cleaner end
  state, and it can follow later as its own migration, numbered as in §2.
- **`memory_literal_search_jobs.query_text` (the `0025` CHECK).** Before storing a query, code
  replaces `\n`, `\r` and `\t` with a space. The query's words do not change.

Then close the rest of the halting class in `literal-history.ts:historyEvent`/`indexSequences`
(phase 2). **A row that cannot be decoded is recorded and skipped; it never halts the cursor.**

- `memory_history_coverage` already allows `indexing_outcome = 'failed'` with a non-null
  `failure_code` (`0016_cloud_memory.sql`). Write that row, advance the cursor, and report the
  count in the job outcome. No migration is needed.
- The redaction re-check (`checked.text !== text`) should store what the redactor returns and
  note it. A changed redaction rule must never freeze history. **Land this before #183, or in
  the same deploy.**

**Test ideas** (`test/memory/literal-history.test.ts`; memory-fixes adds the first, skipped):
- a two-line owner message is indexed and found by `searchLiteral`, **against the real
  migrations**, so that the `0016` CHECK is in force. Un-skip memory-fixes' end-to-end test;
- the hit's excerpt keeps the original line break, and meaning backfill does not throw on that
  chunk (`test/memory/meaning-search.test.ts`);
- a row that fails the redaction re-check is coverage-`failed`, and the next row is indexed;
- mutation: put `\n` back in the forbidden range and the named test fails.

### 3.3 `history_search`: a search over every stored message, on both channels

This is Hermes's `session_search` (`tools/session_search_tool.py` at H@3d7fc8f): full-text
search over every stored message, returning the real messages, **with no LLM in the search**.
It is what makes Sid's requirement "recall anything, even unimportant" something the AI can
actually do.

- **Tool.** Add `history_search` to `memory/memory-tools.ts`, so both channels get it from the
  one definition. It has three shapes:
  - **find:** `query`, `after`, `before`, `channel`, `speaker` (`user`, `assistant` or both;
    the default is both), `sort`. The AI writes the query. Code only quotes each term for FTS5
    syntax safety and turns line breaks into spaces (§3.2). It drops no stopwords.
  - **around:** `eventId`, `window` up to ±20.
  - **read:** a whole conversation day.

  Results carry event id, date, channel, speaker, the text, and a `truncated` flag.
- **Source.** Two existing paths, split into indexed and not-yet-indexed messages (§2 item 3):
  - **Phase 4a: the index.** `LiteralHistoryService.searchLiteral` answers at once, from the
    FTS index, for every indexed message, whether its event is still live in D1 or already
    sealed into R2. When it returns `incomplete` with a `missingRange`, the tool result says so
    and gives the range. It never presents a partial list as everything.
  - **Phase 4b: the scan.** For the missing range, start `createExhaustiveSearch`, which scans
    the raw event stream. Nothing drives a scan job on main, so 4b adds the driver: one
    `runExhaustiveSearchStep` per `DRAIN_CRON` (`*/5`) run until the job is done. The tool
    result says "still searching older messages" and gives the job id. A later call reads the
    answer with `readExhaustiveSearchResult`.
  - On main a turn allows one tool call (`MAX_TOOL_CALLS = 1`), so that means one search per
    turn until phase 5.
- **Suppressions still apply.** Forgotten turns stay hidden: reuse `readSuppressions`.
  Failures are returned as failures, never as an empty list. An archive circuit that is not
  `closed` is a failure the AI is told about.
- **Both sides of both channels: one searchable history.** Voice replies are written by
  `conversation-repository.ts:recordVoiceSent` as `conversation.assistant_sent`, with
  `historyPayload("voice", text, false)`. Telegram replies are `conversation.assistant_delivered`
  with `channelCode 2`. Every history reader admits only `user_committed` and
  `assistant_delivered`, so today what Jarvis said on a call is not history (ME-25, VC-11).
  Flipping `historyEligible` and `sourceChannel` alone would still leave `assistant_sent`
  unread. The audit caught that gap in the previous version of this section.

  **Decision: admit `conversation.assistant_sent` as a third history event type. Voice replies
  are not re-typed as `assistant_delivered`.** Re-typing is blocked in the database:
  `0005_conversation.sql:events_conversation_transition_guard` accepts `assistant_delivered`
  only against a claimed `conversation_deliveries` row with `history_mode = 'assistant'`, and a
  call has no delivery row. `assistant_sent` already passes that trigger for calls.
  - `recordVoiceSent` writes `historyEligible: true` from now on.
  - Call replies already stored carry `historyEligible: false`. That flag recorded the old
    policy; it says nothing about the text. For `assistant_sent` only, the admission checks
    accept either value, so past call replies become searchable too. Every other event type
    keeps the strict `historyEligible === true` check.

  **Admission lists that change** (symbols as of `63eeae3`):
  1. `memory/literal-history.ts:historyEvent`: the event-type test that returns `null` for
     anything but `user_committed`/`assistant_delivered`, and its `historyEligible !== true`
     check, per the rule above. The `speaker` line maps `assistant_sent` to `"assistant"`.
  2. `literal-history.ts:sourceChannel`: accept `assistant_sent` with `channelCode 1` as
     `"voice"`. Any other `channelCode` on it stays corrupt.
  3. `literal-history.ts`'s owner-only filters become a `speaker` option:
     - `searchLiteral`'s SQL clause `NOT EXISTS (… event_type = 'conversation.assistant_delivered')`;
     - `searchCandidateHits`'s `if (event.speaker === "assistant") continue`;
     - `runExhaustiveSearchStep`'s `event.speaker === "user"`.

     The scan job stores matches from both speakers. `readExhaustiveSearchResult`, which
     re-reads each event, filters by speaker when it reads, so the job table needs no new
     column. `history_search` passes the AI's choice. The automatic retriever keeps passing
     `"user"`: widening automatic recall to Jarvis's own words is ME-24 ("UNSURE — needs
     Sid"), outside this plan.
  4. `conversation/context-retriever.ts` (`D1ContextRetriever`, the recent-turns window both
     channels use). Three places change:
     - the row check (`row.event_type !== "conversation.user_committed" && … !== "conversation.assistant_delivered"`);
     - `historyText` (`channelCode` per event type, plus the `historyEligible` rule above);
     - the `event_type IN (…)` list in the history SQL.

     Without this, a call's replies are missing from its own recent context, both later in
     the call and on Telegram (VC-11).

  **Admission lists that stay, and why:**
  - `0016_cloud_memory.sql:memory_visible_recent_events` (a view). Nothing in `src` reads it on
    `63eeae3` (grep).
  - The `memory_event_suppressions` insert trigger in `0016`. A single-event forget must target
    `user_committed` or `assistant_delivered`, and the covered-turn counts use the same pair.
    Consequences:
    - `memory_forget` of one call reply by its id is refused by the database;
    - a range forget still hides call replies, because every search checks the suppression's
      sequence range;
    - code that computes those counts must **not** start counting `assistant_sent`, or the
      trigger refuses the forget.

    Widening the trigger needs a migration. It is a follow-up, numbered as in §2.
  - `sync/memory-projection.ts:projectionSourceText`. It validates the source event of a
    memory fact projected to the PC. It is not a history reader. Nothing in this plan makes a
    call reply the source of a fact, since facts cite Sid's messages (§3.1).
  - The owner-only filters in `meaning-search.ts`. Meaning search over Jarvis's replies is
    ME-24, out of scope. `history_search` is literal.
  - The staged/delivered pairing in `telegram-memory-retriever.ts`, `memory-control-targets.ts`
    and `owner-telegram-agent.ts`. It is about Telegram delivery, not about what counts as
    history.

  **Past call replies in the index.** The indexer's cursor has already passed them, because it
  returned `null` for them. The scan (4b) reads the raw stream, so it finds them as soon as
  `historyEvent` admits the type. The index (4a) needs a one-time pass over `assistant_sent`
  rows below the cursor. **Unverified:** whether the maintenance path
  (`indexSequences(…, refresh = true)`) can do that. If it cannot, 4a adds a small backfill
  step.
- **Prompt line** (shared core): "Before asking Sid to repeat something, search history."

**Files:**
- `memory/memory-tools.ts`, `memory/literal-history.ts` and a new `memory/history-search.ts`;
- `agent/owner-agent-core.ts` (dispatch), `conversation/conversation-repository.ts`
  (`recordVoiceSent`), `conversation/context-retriever.ts` (recent-turns admission), and
  `autonomy/tool-capabilities.ts` (read-only tier);
- 4b only: `jobs/job-table.ts` (the scan driver on the `*/5` handler).

**Test ideas:**
- a fixture has a Telegram message, a call utterance and a call reply. `history_search` finds
  all three from **both** `OwnerTelegramAgent` and `VoiceAgent`, and the same query returns
  identical results;
- a call reply stored before this change, with `historyEligible: false`, is found;
- `speaker: "user"` leaves out both channels' replies, and the automatic retriever's results
  are unchanged;
- `D1ContextRetriever` puts a call reply into the next turn's recent context
  (`test/conversation/context-retriever.test.ts`);
- mutation: take `assistant_sent` out of `historyEvent`'s list and the call-reply test fails;
- `incomplete` names its `missingRange`, and a suppressed turn is never returned;
- an archive circuit that is not `closed` is reported as a failure;
- `tool-classification.test.ts` picks up the new name automatically.

### 3.4 The AI decides what to remember, in a quiet-conversation review

This replaces the hourly code-driven extraction. It follows Hermes's background review
(`agent/background_review.py`, "consider saving to memory if appropriate … If nothing is worth
saving, just say 'Nothing to save.'"), fired by quiet time rather than by a turn count.

- **Wake-up.** The existing `DRAIN_CRON` (`*/5 * * * *`) finds owner conversations whose last
  turn is at least 20 minutes old and has not yet been reviewed. The cursor is the last
  reviewed event sequence. 20 minutes is a timer, not a judgment. It runs in the cloud, so it
  works overnight.
- **Review.** The same shared core and model, given the unreviewed turns from both channels,
  and one instruction: "Review these turns. Save, correct, pin or unpin anything worth
  keeping, using your tools. If nothing is worth keeping, say so."
  - **Tools:** `memory_remember`, `memory_correct`, `memory_pin`, `memory_unpin`,
    `memory_search` and `history_search`.
  - **`memory_forget` is left out.** It is Sid's "hide this conversation" command, not
    housekeeping.
  - **Nothing waits for Sid's approval.** The ledger is append-only, so a wrong correction is
    one `memory_explain` away from being undone. That is why Jarvis, unlike Hermes, needs no
    approval queue.
- **Authority.** The review has no live owner turn, so it cannot use `directOwnerText`.
  - Its write authority is the reviewed window. `supportingExcerpt` must appear in an owner
    event inside that window, and the source is that event (provenance, a fact).
  - `memory-repository.ts:validateOwnerTurn`'s newer-turn refusal (ME-33) must not apply to a
    review.
  - On each write the AI says whether Sid stated the fact or the AI inferred it
    (`basis: stated` or `basis: inferred`). That is the AI's decision. Code stores the value as
    given, and recall shows the stored `basis` next to the fact, the same way it shows the
    source and date. Code never decides which facts are inferred. It does not hold inferred
    facts `proposed` for a tap either (requirement 4, no homework).
  - **Unverified:** whether the `0016` state-machine triggers allow `active` with
    `basis='inferred'` from this actor. Check before writing code. If a migration is needed,
    number it as in §2.
- **Delete when it is live:**
  - `distilMemory` from `poll`;
  - `AutomaticMemoryDistillationWorkflow`'s `commitInput` gates (ME-6, ME-7, ME-8, ME-9);
  - `extraction-policy.ts:decideAutomaticPromotion` (ME-30).

  Keep the extraction budget (`memory-extraction-budget.ts`) as the money cap.
- **Receipts.** Each review records its window, the tool calls it made and their results. "I
  reviewed and saved nothing" is a receipt, too.

**Files:**
- a new `memory/quiet-review.ts`;
- `jobs/job-table.ts` (the `*/5` handler, and removing `distilMemory`);
- `agent/owner-agent-core.ts` (a review port with its own authority);
- `memory/memory-owner-controls.ts` and `memory/memory-repository.ts` (window authority);
- a migration for the review cursor, only if an existing cursor table cannot hold it.

**Test ideas:**
- a quiet window where Sid said "I switched to physics" produces a `memory_correct` receipt
  with the source event in the window;
- a window with only "ok thanks" produces a "nothing saved" receipt **and still calls the
  model** (no keyword skip);
- a window that is not yet quiet is not reviewed;
- a turn from each channel in one window is reviewed once.

### 3.5 Show the AI its profile usage; one recall path

- **Usage in the header.** `composeCoreProfile` renders `Core profile [31 of 40 shown; 31
  pinned; …]`. When pins exceed 40 it says `[40 of 47 shown; 47 pinned]` and lists which were
  left out by id. `memory_pin`/`memory_unpin` results return the new count. **The AI trims its
  own profile, as Hermes does with `[67% — 1,474/2,200 chars]` (`_render_block`). No code
  decides what to unpin.** Files: `memory/core-profile.ts` (a count query beside
  `readCoreProfile`) and `memory/memory-owner-controls.ts` (pin results).
- **Re-read every turn.** It already is (`OwnerAgentCore.streamCaptured`). Do **not** copy
  Hermes's frozen per-session snapshot: Hermes's own docs name the stale snapshot as a failure,
  and Jarvis has no `/new` habit.
- **One recall path.** Land #174, which composes `TelegramMemoryRetriever` for voice. Then:
  - rename it to `OwnerMemoryRetriever`, since it is channel-neutral;
  - remove `D1ContextRetriever`'s own fact and history reads, keeping only its recent-turns
    base context (`TelegramMemoryRetriever` still wraps it on #174);
  - delete **all of ME-16**, not just its first symbol. The row is in `docs/CODE-VS-JUDGMENT.md`
    on #187 at `934419c`. Every part is in `telegram-memory-retriever.ts` at `63eeae3`, and each
    part reads Sid's message to decide whether to search, or which evidence to drop:
    - `shouldSkipMeaningSearch` and `MEANING_ACKNOWLEDGEMENT_TERMS`. Meaning search always runs.
    - The `terms.length <= 2 ? null` gate in `literalHistoryQuery`. Literal history is searched
      whenever the query has any term. The function's 1,024-byte cutoff stays: it is the FTS
      input size limit (`memory_literal_search_jobs.query_text` allows 1 to 1,024 bytes), not a
      reading.
    - `recentContextCoversQuery` and the `coverageContexts` filter in `mergeMemory`. History is
      searched even when recent turns seem to contain the same words.
    - `questionOnly`, in all three places it is used. A past message that ends in "?" is
      evidence like any other.
    - `sameText`, in both places, and the drop of a hit contained in a recent turn of at least
      `MIN_RECENT_EVIDENCE_CHARACTERS` (24) characters (`context.text.includes(hit.excerpt)`).
  - **Parts of that merge that stay, and why:**
    - `excludedEventIds`, `recentEventIds` and `withoutCurrentTurn` drop an item by **event
      id**, when the same event is already in the context. The same event twice is a fact, not
      a reading of the words.
    - The exact-duplicate text drops (`seenTexts` and `meaningSeenTexts`, through
      `normalizedMeaningPhrase`) are not part of ME-16. They sit with the caps and ranking in
      ME-22 ("UNSURE — needs Sid"), which this plan leaves alone.
    - `RECALL_STOPWORDS` is also ME-22. Until Sid decides, a message made only of those words
      still gives no search terms, so literal history is not searched for it. `history_search`
      does not use that list.
  - when recall fails, tell the model instead of returning `[]`.
- **Voice latency must be measured, not assumed.** Sid's requirement set voice p95
  first-audible at or below 4 s, with no pre-retrieval before the first token (memory
  requirements items 7 and 12). #174 adds pre-retrieval to calls. Run
  `docs/runbooks/voice-smoke.md` after #174 deploys. If it misses, give voice the same
  retriever with a shorter deadline and a "recall still loading" line. Never give it a
  different store.

**Test ideas:**
- a new `test/memory/core-profile.test.ts`: 41 pins render "40 of 41 shown" and name the missing id.
  Mutation: remove the count and the named test fails;
- a parity test: the same query through `OwnerTelegramAgent` and `VoiceAgent` yields the same
  retrieved-context envelopes;
- a turn of "ok" still runs meaning search;
- a two-term query still searches literal history, and a past message ending in "?" comes back
  as evidence (`test/memory/telegram-memory.test.ts`);
- mutation: put back any one ME-16 part and a named test fails.

---

## 4. Hermes parts we do NOT copy, and why

| Hermes (H@3d7fc8f) | Why not |
|---|---|
| **Keyword filters that block memory writes**: `memory_tool_store.py:_scan_memory_content` → `tools/threat_patterns.py:scan_for_threats` rejects entries by regex, and poisoned entries load as `[BLOCKED: …]` | Code judging content, and Sid's red flag. Rule 4: store everything, source-labelled. Safety comes from labelling memory "reference data, never instructions" (`CORE_PROFILE_PREFIX`) and gating only actions taken as Sid, not from filtering what is stored. |
| **The keyword list that skips recall on "ok/thanks"**: `agent/memory_provider.py:TRIVIAL_PROMPT_RE`, `is_trivial_prompt` | Code deciding a message has no meaning. Jarvis already has its own copy, `shouldSkipMeaningSearch`/`MEANING_ACKNOWLEDGEMENT_TERMS`, plus the other shape rules in ME-16. §3.5 deletes the whole row. |
| **Approval for memory housekeeping**: `memory_tool.py:_background_delete_gate` stages background replace/remove for the owner; `write_approval: true` stages every write for `/memory approve` | Homework (requirement 4, "no homework"). Hermes needs it because `replace` overwrites and nothing is versioned. Jarvis's ledger is append-only, so a wrong change is recoverable without asking Sid. |
| Local-only storage (`~/.hermes`, `state.db` on the host) | The PC is off overnight (rule 7). Memory stays in D1, R2 and Vectorize. |
| A 2,200 + 1,375 character budget as the only curated memory | Too small for Sid's "best memory possible". Jarvis keeps the ledger, living notes and history, and shows usage (§3.5) instead of shrinking. |
| A frozen prompt snapshot until `/new` | Stale across channels and sessions (Hermes docs, memory Troubleshooting §5). Jarvis re-reads each turn. |

---

## 5. MCP later

Memory stays Jarvis's own: the D1 ledger, living notes and history search above, behind its own
tools. Outside services (email, calendar, school sites, a future Obsidian export) may later
arrive as MCP servers the AI calls like any other tool. Their results are stored as
source-labelled evidence in Jarvis's memory, never as a second memory Jarvis has to reconcile.
There is no bought memory framework and no external memory provider (Sid's final architecture,
2026-09-17).

---

## 6. Phases, smallest safe step first

Each phase is one PR: a focused local test run, then a full suite on CI.

> **First build targets, for this weekend: phase 1 and phase 4a.** Both can start now.
> - **Phase 1** makes the stored memory work: nightly notes commit again, history indexing gets
>   past multi-line messages, and backups resume with the right tables.
> - **Phase 4a** is `history_search` over the index, on calls and Telegram, with call replies
>   admitted as history. It needs phase 1 deployed, or the index it searches is still stuck. It
>   does **not** wait for #174 or phase 3. The tool is defined once in `memory-tools.ts`, which
>   both agents already load on main, and the shared `OwnerAgentCore` dispatches it.
>
> The numbered order below is unchanged. The only change is that 4a may be built alongside
> phases 2 and 3 instead of after them.

1. **Land memory-fixes, plus the storage half of the newline fix.** Push `codex/memory-fixes`
   (`f2f836c`) and open its PR. It is already built. It covers three things:
   - the prose checks in consolidation (§3.1);
   - `rowText`'s newline refusal (§3.2);
   - the backup cut.

   Add the search-form chunk text and the query-text line breaks (§3.2) to the same PR. Without
   them, the `0016` CHECK keeps indexing stuck.
   - **Deploy order:** migration `0047` before the code, because the old trigger refuses a
     note whose Markdown lacks its ids. The §3.2 addition needs no migration.
   - Deploys and migrations are Sid's.
2. **Consolidation feedback and retry, and skip-don't-halt indexing.** This is the rest of
   §3.1 (the nightly part only) and §3.2. It touches only `living-notes.ts` and
   `literal-history.ts` and needs no migration. Land it before #183 deploys.
3. **One recall path and the profile gauge (§3.5).** Merge #174 first. Then the gauge (a
   read-only count), removing the ack skip, the failure-is-said change, and the voice-smoke
   run.
4. **`history_search` on both channels (§3.3).** It is read-only, so its autonomy tier is
   "free". It comes in two parts:
   - **4a:** the tool over the index, the `speaker` option, call replies admitted in the four
     lists §3.3 names, the backfill of past call replies, and an honest `incomplete`. No
     migration.
   - **4b:** the scan driver for ranges the index has not reached yet.
5. **Foreground retry and removing the wording graders (§3.1, foreground):** the tool loop in
   `OwnerAgentCore`, AG-1 to AG-6 and ME-12. It changes both channels' turn shape, so it needs
   voice-smoke again.
6. **Quiet-conversation review replaces hourly extraction (§3.4).** It is last because it
   relies on 3–5: the AI must be able to retry refusals and search history before it runs
   unattended. It deletes `distilMemory` and ME-6 to ME-9 and ME-30 in the same PR.

Not in this plan: the ME, AG and VC rows outside memory writes and recall (for example ME-18
`MIN_QUERY_SCORE`, ME-22 retrieval caps, ME-28 note paging). They follow #187's removal list
in their own PRs.

---

## 7. What this refresh did not do

- **No test was run and nothing was mutated.** Every claim is from reading code at `b0cddc5`
  and `63eeae3` (the memory code is the same in both), `ca14f01` (#174), `f2f836c`/`87df9ce`
  (memory-fixes) and `934419c` (#187).
- **No production state was read.** The nightly failure history, the stuck history cursor,
  the migrations applied, and how many pins exist in production are all unverified here.
- **Unverified and named where used:**
  - whether the `0016` triggers allow active inferred facts from a review actor (§3.4);
  - voice latency after #174 (§3.5);
  - the #183 redaction hazard, which is inferred from code (§2.2);
  - whether any reader of `chunk.text`, beyond the ones named in §3.2, breaks on the search form;
  - whether the maintenance re-index can backfill past call replies (§3.3).
- **Resolved without asking Sid**, per "decide design yourself":
  - keep the ledger rather than a flat `facts` table (the old §3/§11.1). Hermes's lesson is
    the write boundary, not the file format;
  - keep the tool names, with no `memory_save` rename (the old §11.4).

  The old §11.2 and §11.3 (provider choice, a one-brain Durable Object) are outside Phase 2.
