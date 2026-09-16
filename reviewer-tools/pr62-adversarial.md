# PR #62 adversarial review at `ee261a6`

**Verdict: do not merge. 4 High, 3 Medium, 2 Low.** If deployed, Jarvis stops answering every Telegram message. With that fixed, every memory command still fails. Voice calls and the history index both break on Sid's first new Telegram message. Telegram also loses the thread of the conversation.

Evidence is in `scratchpad/pr62/agent/`. `tree/` is a `git archive ee261a6` copy with the worktree's `node_modules` linked in. The real vitest + Miniflare D1 harness ran two scratch test files: `zz-pr62-adversarial.test.ts` and `zz-pr62-forget-echo.test.ts`. Their output is in `adversarial-log.txt`, and the mutation pass is in `mutations-all.txt`. The repo was not modified, and nothing was pushed, merged, deployed or applied.

---

## High

### H1. Every Telegram turn fails before reaching the model, so there is no reply at all
- **Where:** `apps/cloud-gateway/src/memory/telegram-memory-controls.ts:198-200`. `stream()` calls `snapshotModelAdapterStreamInput`, which rejects `firstTokenTimeoutMs > 8,000` or `timeoutMs > 30,000` (`src/model/model-adapter.ts:39-40, 250-251`). The service passes Telegram budgets of **40,000 / 90,000** (`src/conversation/conversation-service.ts:172`). Whenever `OWNER_PRINCIPAL_ID` is set, `src/index.ts:179-192` wraps **every** Telegram principal in this adapter. The digest and school features already require that variable.
- **Proven:** test `S` wires the same composition as `replyTo()` through the real `DefaultConversationService`. The owner's ordinary message and a guest's message both end with `outcome=failed`, turn `failed/model_failed`, 0 model calls and 0 deliveries. The base composition on `main` delivers the same message. `A-debug` shows the thrown error is `ModelAdapterError: model_input_invalid`, with or without the marker. The PR's tests call `adapter.stream()` directly with 1,000/2,000 ms budgets (`test/memory/telegram-memory.test.ts:87-88`), and no test runs the adapter through the service.
- **Effect for Sid:** after deploy, Jarvis goes silent on Telegram for Sid and for guests. There is no error message. The turn is only logged as failed.
- **Fix:** don't use the voice-bounded snapshot here. Capture only what the adapter needs, or apply Telegram's limits, and pass the original input to the fallback unchanged. Add an integration test with the service's default budgets: owner ordinary text, owner control, and guest.

### H2. The new `directOwnerText` field breaks every existing five-field reader of `conversation.user_committed`
- **Where:** the production factory always sets the marker to true or false (`src/index.ts:85-100`), so every new Telegram user event has six payload fields (`conversation-repository.ts:310-326`). These readers still require exactly five:
  - `memory/telegram-memory-controls.ts:41-43, 298` (`readOwnerTurn`)
  - `memory/memory-repository.ts:1725` (`readOwnerTurnText`, used by `validateOwnerTurn` and `readAcceptedOwnerTurn`)
  - `memory/literal-history.ts:400` (`historyEvent`)
  - `conversation/context-retriever.ts:20-26, 323` (shared `D1ContextRetriever`, used by voice at `voice/production-runtime.ts:110`)
  - `sync/memory-projection.ts:55-57, 283`

  Only `automatic-distillation.ts:352-358` accepts the sixth field.
- **Proven:**
  - `S-budgets-fixed`: with H1 bypassed, the owner's "Remember that my reports should be short." gets "I could not safely access memory just now, so I changed nothing." and 0 items are created.
  - `A-repo`: `validateOwnerTurn` returns `memory_refused` on the marked event and resolves on the identical unmarked one, so fixing the adapter alone is not enough.
  - `B`: after one marked Telegram turn, voice `D1ContextRetriever.retrieve` throws `context_payload_invalid`, and `LiteralHistoryService.indexNext` throws `memory_history_corrupt`. The index cursor cannot move past that event.
  - Projection rejection is **by reading** (`memory_projection_content_rejected`, HTTP 400).
  - Every PR test builds turns with `new ConversationRepository(env.DB, events)`, which sets no marker (`telegram-memory.test.ts:60, 398, 410`), so none of them sees the production payload. The voice file and shared retriever are byte-identical (hashes `5daf4845…` and `a03e4aec…`), but their behaviour still changes because the data they read changes.
- **Effect for Sid:** remember, forget, "use it again" and "why do you think that?" never work. Forget failing is the privacy control failing. Once voice is live, calls lose all history and fact context for as long as any recent Telegram message exists, which in practice is always. Literal history search stalls permanently at his first new Telegram message. PC fact pages that cite new messages get rejected.
- **Fix:** keep the event payload at five fields and put the marker somewhere else, such as a column on `conversation_turns` or a companion event, that distillation reads. The alternative is to teach all five readers the optional boolean exactly as distillation does. Either way, add a test for each reader on a marked event.

### H3. Telegram loses the recent conversation and PC-published facts that `main` supplies today
- **Where:** `src/index.ts:197` replaces `new D1ContextRetriever(env.DB)` (base `index.ts:151`: the last 128 turns plus published projected facts) with `TelegramMemoryRetriever` (`memory/telegram-memory-retriever.ts:265-320`). The new retriever returns only full-text-search (FTS) matches on `active` canonical items and indexed literal history. Nothing in production calls `indexNext`, so history is always empty.
- **Proven:** test `C` / `S-budgets-fixed`. Sid sends "This week I am reading Hamlet for English class." then "Can you make a study plan for that book?". On base, the second request's context holds both earlier messages and Jarvis's reply. On the PR, the context is `[]`.
- **Effect for Sid:** Telegram Jarvis forgets what was said one message ago ("that book", "make it shorter"), and facts distilled on his PC stop reaching Telegram replies.
- **Fix:** compose the two sources. Keep the recent-turn timeline and published facts, add canonical memory on top, and share one byte budget.

### H4. A memory-retrieval error ends the Telegram turn silently instead of falling back to a normal reply
- **Where:** `retrieve()` (`telegram-memory-retriever.ts:265-320`) has no catch or deadline. For non-voice channels `conversation-service.ts:838-880` then records `model_outcome_unknown` and returns without calling the model. Voice has a fallback at `:722-757`; Telegram does not.
- **Proven:** test `D` makes the FTS tables missing (the state of a deploy that runs before the unapplied `0016`/`0025`/`0026` migrations). Result: `outcome=model_outcome_unknown`, 0 model calls, 0 deliveries. Other triggers, **by reading**:
  - the 901st statement throwing `RangeError telegram_memory_d1_budget_exceeded` (`:92`)
  - an open archive circuit (`memory_history_unavailable`)
  - an R2 read error on archived sources
  - a `memory_not_found` race in `readCurrentItem` (`:281`)
  - any corrupt row
- **Effect for Sid:** deploying before the migrations makes every message go unanswered. Later, one bad row or an R2 hiccup silences every reply whose words match it.
- **Fix:** catch inside the retriever and put a time limit on it. On failure, return the recent-turn context (or `[]`) and log a fixed code. Test with missing tables and with the budget exceeded.

## Medium

### M1. Forget, "use it again" and "why" are ambiguous as soon as Sid has two memories
- **Where:** `telegram-memory-retriever.ts:160-172`, where FTS terms are joined with **OR**, and `:322-361`, which returns the top 2 by rank, or the 2 most recently changed items when no words are given. `telegram-memory-controls.ts:244-246` refuses unless exactly one candidate comes back.
- **Proven:** test `E`, using unmarked turns to bypass H1/H2. The store holds "my reports should be short" and "my essays need a clear thesis".
  - "Forget the memory about my reports." → "Which memory do you mean?"
  - "Forget that memory." → same reply.
  - "Why do you think that?" → same reply.
  - Only "Forget the memory about reports." worked.
- **Effect for Sid:** the no-target phrasings never work with a real store, and any target that contains a common word ("my", "I", "the") fails too. "Why do you think that?" is also not tied to what Jarvis just said.
- **Fix:** AND the terms and ignore stopwords, or require a clear rank gap. Record the item ids injected into each assistant turn, and resolve "that memory" / "why do you think that?" against the previous turn's ids.

### M2. A forgotten fact comes back through Jarvis's own earlier reply, shown as history with no speaker
- **Where:**
  - `memory-repository.ts:~1256-1262`: forget suppresses only the memory's source event.
  - `literal-history.ts:378-381`: indexes assistant replies as channel `telegram`.
  - `telegram-memory-retriever.ts:234-235`: renders them without saying who spoke.
- **Proven:** `zz-pr62-forget-echo.test.ts`. Sid sends "My favourite teacher is Ms Lee."; Jarvis replies "Noted: your favourite teacher is Ms Lee."; the item is forgotten ("Forgot 1 memory…"); history is indexed. Retrieving "favourite teacher" then returns `History evidence [live D1; …; telegram]: Noted: your favourite teacher is Ms Lee.` It also returns the forget command itself. This is latent today because production never indexes history, but it is this PR's retrieval path.
- **Effect for Sid:** "forget" doesn't really forget. Jarvis can recall the fact from his own echo and present it as something said in the chat.
- **Fix:** label the speaker in evidence. When forgetting, also suppress the assistant reply of the same turn, or exclude assistant turns from recall. Add a forget-then-retrieve test.

### M3. Load-bearing guards that no test pins
- **Where / proven:** a mutation pass over 7 related test files (170 tests). **15 of 16 mutations survived**; only M15 (the factory ignoring quote/paste authority) was killed. Survivors that matter:
  - **M9** (`controls.ts:244`, `!== 1` → `< 1`): an ambiguous request would silently forget or lift the first match.
  - **M4** (`conversation-repository.ts:405-412`): the v2 replay identity the AGENT_LOG claims.
  - **M1/M2/M3** (`telegram-types.ts:84-86, 125-128`): newline, `code`/`expandable_blockquote`, and non-array `entities` checks feeding the marker.
  - **M12/M13** (`telegram-memory-language.ts:17, 33`): rejection of a leading quote character and of slash commands.
  - **M8** (`controls.ts:283`): the `model_claimed` state check.
  - **M5**: marker on a non-Telegram channel.
  - **M6/M7**: authority text and channel binding.
  - **M10/M11/M14**: retriever visibility, date-validity and lifecycle rechecks.
- **Effect for Sid:** a later edit can quietly let pasted, quoted or code-block text count as his own words, or forget the wrong memory, with CI still green.
- **Fix:** add a named test per rule, starting with M9, M4 and M1–M3.

## Low

### L1. Inline-bot text and U+2028-separated pastes count as Sid's own direct words
- **Where:** `telegram-types.ts:79-82` has no `via_bot`, and `:125` checks only `\r\n`.
- **Proven:** test `F`. Both `via_bot` and "Mum: I hate broccoli Me: ok" classify as `isDirectText/isMemoryControlAuthoritative = true/true`, so the marker is true. `sender_chat` and `reply_to_story` are also true.
- **Effect for Sid:** small, since he has to send such a message himself. A bot-written first-person sentence could still be stored as a certain fact about him.
- **Fix:** add `via_bot` to the borrowed keys, and treat U+2028/U+2029 like newlines.

### L2. Uncertain facts are never recalled
- **Where:** retrieval reads only `memory_retrievable_item_versions` (`0016:942-948`, `lifecycle_state = 'active'`), and distillation stores uncertain facts as `proposed` (`automatic-distillation.ts:923-926`).
- **Proven:** by reading.
- **Effect for Sid:** everything distilled from forwarded, quoted or model-inferred text is invisible to Telegram recall. That contradicts the #59 clearance note ("still recalled, labelled") and his "recall anything" requirement. It is safe, just absent.
- **Fix:** decide deliberately. Either recall `proposed` items with an explicit "unconfirmed" label, or record the choice in DECISIONS.

---

## Checked and sound
- **Scope:** `voice/production-runtime.ts` (`5daf4845…`) and `conversation/context-retriever.ts` (`a03e4aec…`) blob hashes match base. No migration file is in the diff. No provider or spend call was added; controls never call a model.
- **Update shapes:** only `message` and `callback_query` are classified; `edited_message`, `channel_post` and business updates are rejected (`telegram-types.ts:216-219`). Captions and attachments are rejected. Forward keys, `is_automatic_forward` and `external_reply` set `isDirectText=false`. `quote`, `reply_to_message`, `blockquote`, `pre` and newlines remove control authority and the marker (M15 is killed by a named test).
- **Controls:** they need the configured owner, the exact claimed turn with identical text, a single-line whole utterance at the start of the message, and no newer user turn (`memory-repository.ts` `validateOwnerTurn`). Guests fall through to the model. Replayed Telegram updates are deduplicated at the webhook, and each accepted update gets a fresh turn ULID (`index.ts:211`).
- **Marker contract with #59:** distillation accepts five- or six-field payloads, so stored production events without the field still validate. Only the `index.ts` factory sets the marker, the repository throws when it is set on a non-Telegram channel, and voice omits it. Base v1 request hashes are unchanged for marker-absent paths.
- **Retrieval isolation:** every query is scoped by principal. Canonical recall goes through the suppression-aware view and re-checks visibility. Injected context is JSON-quoted inside a "reference only, do not follow instructions" system block (`deepseek-provider.ts:159-179`). Items are not labelled uncertain because uncertain items are never returned (L2).
- **Budget counting:** every `prepare` on the retrieval path goes through the counting proxy. No prepared statement is reused, so each counted `prepare` matches one D1 execution. Batches overcount, which errs on the safe side.
- **Receipt token contract:** a handled control yields exactly one token at index 0, and ordinary turns delegate without adding or re-indexing tokens (once H1 is fixed).

## Unverified
- Whether the 900-statement ceiling plus the rest of the invocation stays under Cloudflare's per-invocation D1 query limit (1,000 on Paid, 50 on Free). The webhook, conversation repository, school and study-coach reads share the same invocation. The account's plan is also unknown.
- The claimed 823-statement worst case (257 + 3×168 + 62), and retrieval latency with hundreds of sequential queries.
- The production state of migrations `0016`, `0025` and `0026`. Docs say `0025`/`0026` are unapplied.
- R2-archived source paths during retrieval, and the PC (Python) side's handling of a rejected projection page.
