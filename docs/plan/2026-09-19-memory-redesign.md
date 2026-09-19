# Memory redesign — execution spec for Phase 2

**Subordinate to [`2026-09-19-jarvis-roadmap.md`](2026-09-19-jarvis-roadmap.md), which is
Sid's own document and wins over this one.** This file is the builder-facing plan for
Phase 2 ("Memory") and nothing else. Where it disagrees with the roadmap, the roadmap is
right and this file is stale.

Written 2026-09-19 by a read-only session (DeepSeek V4.1 Flash) at `origin/main` =
`1b9cec5`, from four independent read-only audits plus first-hand reads. **No test was run
and no mutation was executed by any auditor** — a read-only pass cannot mutate. Every
claim below is therefore *proven-by-reading*, and the places where it is weaker are marked.

`docs/BUILDING.md` assigns **R2 Cloud memory** to a different builder (GPT-5.6 Sol, xhigh)
reviewed by Claude Opus 5. This session is not on that ladder, so it did the reading and
wrote this; it did not change memory code.

---

## 1. The rule, as a review test

> **Code builds tools. Jarvis makes every decision.** Code may do four things only: tools;
> wake-ups that report "something happened" or "it's time"; storage and plumbing; and
> enforcing a decision the model already made. *If you catch yourself writing an `if`
> statement that makes a judgment call, stop.*

Two questions decide every review of this subsystem:

1. **"What does this `if` decide, and who told it to?"** If the answer is "whether this
   matters / is worth keeping / should be shown / what it means" and nobody told it — it is
   a violation.
2. **"Did the model get a chance to decide this?"** Code overriding a model that ran is a
   smaller sin than code deciding *instead of* running one. Section 2's first item is the
   second kind.

**One carve-out the rule needs, stated so it is not over-applied.** Proving *where words
came from* is not a judgment call — it is provenance, and it belongs in code. "This quote
appears verbatim in an owner-authored, unsuppressed event" is a fact. "This fact is worth
remembering and is durable rather than temporary" is a judgment, and belongs to Jarvis.
Confusing the two is how the current code ended up doing both in one function.

---

## 2. Verdict

Memory is not missing. It is **over-built in the wrong place**: the ledger is far richer
than the roadmap's `facts` table, while the decisions live in code and the *abilities*
Jarvis needs (pin, expiry, search, version history, a core profile) do not exist.

The single most important finding: **there is a whole memory path where the model is never
called.** On the control path Jarvis does not participate at all.

### The five worst offenders

1. **`TelegramMemoryControlModelAdapter.streamCaptured`
   (`telegram-memory-controls.ts`) + `parseTelegramMemoryControl` /
   `REMEMBER_PREFIXES` / `rememberWord` (`telegram-memory-language.ts`)** — four regexes and
   a Levenshtein-distance-≤2 match on a `[a-z]{6,10}` word decide that Sid issued a memory
   command; **code then performs the write and authors the reply, and the provider is never
   called.** There is a four-word deny-list (`renumber`, `remembered`, `members`, `member`)
   so that ordinary words cannot be commands. Everything else in this section is code
   overriding a model that ran; this is code *replacing* it.
2. **`commitInput` + `decideAutomaticPromotion` + `isAuthenticatedFirstPersonQuote`
   (`automatic-distillation.ts`, `extraction-policy.ts`)** — evidence class and lifetime are
   decided by `AUTO_PROMOTABLE_ORIGINS`, a hedge/negation regex list
   (`FIRST_PERSON_UNTRUSTED_FRAMING`) and a whole-sentence parser. Only a verbatim,
   single-sentence, unframed, *live* first-person quote may become `active`; everything the
   model infers stays `proposed` forever unless Sid taps Confirm. **This is the mechanism
   behind `STATE.md`'s relayed "0 active facts" (36 runs, 5 items, all `proposed`)** — the
   figure is explained by the code, not merely observed.
3. **`expireElapsedFacts` (`living-notes.ts`)** — code expires facts by itself, as
   `actor = 'rules'`, writing its own prose reason (`"The fact's explicit validity end
   passed."`) and capping the batch at 32, **before the model is consulted at all**. It
   cannot currently fire, because no writer ever sets `valid_to` (§5) — so this is a loaded
   gun rather than a live injury.
4. **The same judgment implemented twice, differently.** `rememberGrounding` /
   `factVocabularyMatches` / `CONTENT_STOP_WORDS` / `NORMALISATION_ALLOWLIST` in
   `owner-telegram-agent.ts` **and** `isAuthorizedRememberText` /
   `normalizeRememberComparison` in `memory-owner-controls.ts` both decide whether the
   model's wording is faithful to Sid's, with different normalisation, and either can
   silently rewrite `basis` to `"inferred"`. Two implementations of one judgment is a
   class defect: they will drift, and one of them is already unreachable from the other's
   path.
5. **The retrieval pipeline** — `recallTerms` / `ftsQuery` / `literalHistoryQuery` rewrite
   Sid's sentence into an FTS expression and drop stopwords, `MIN_QUERY_SCORE = 0.45`
   silently discards semantic hits the model is never told existed, `reciprocalRankFusion`
   invents a ranking, and five separate caps (`MAX_MEMORY_CANDIDATES = 3`,
   `MAX_LIVING_TOPIC_NOTES + 1`, `MAX_MEANING_RESULTS = 4`, `MAX_HISTORY_RESULTS = 4`, plus
   a byte budget) decide what reaches the prompt, on an automatic injection the model never
   asked for and cannot decline.

### Also requiring change, by category

**What is worth remembering.** `parseTelegramMemoryControl`'s forget/lift/explain regexes;
`validateStoredEvent`'s "only `conversation.user_committed` may become memory";
`validateProviderProposal`'s closed field set (a valid thought in a new field is silently
discarded); `readCoveredProposalHashes` dedupe; `historyEligible` written as a literal at
ingest. Each becomes: wake Jarvis with the material, and let it decide.

**Durable vs temporary.** `decideAutomaticPromotion`; `lifecycleState: modelInferred ?
"proposed" : "active"` (twice in `memory-owner-controls.ts`); `validFrom: null, validTo:
null` on every writer. The roadmap's `kind` (durable | temporary) has **no column at all**
— `memory_items.kind` is a different axis (fact/preference/plan/decision/relationship).

**Stated vs inferred.** `validateExtractionProposal` **manufactures a confidence of 1.0**
when the model omits one (`confidence === undefined ? 1 : confidence`); `commitInput`
demands the model's `confidence` and then never reads it, defaulting a missing
`filingConfidence` to a failing `0`; `const basis = input.basis ?? "stated"` defaults to the
**strongest** evidence class; `readTelegramMemoryOwnerTurn` asserts
`forwarded/quoted/pasted/hasAttachment/modelGenerated/toolGenerated/guest` are all false and
stamps the turn `authenticated_first_person`. Defaulting to the strongest class is the wrong
failure direction for a memory system.

**Correction.** No supersession decision exists on the automatic path — the prompt shows
topic names but never existing facts, so a restated-but-different fact becomes a second live
item. `memory_correct` **creates a new item** and retires the old one, where the roadmap
says "creates a new version and links the old one to it" — the behaviour does not match the
spec. `memory_correct` also has no `reason` input; reasons are code constants
(`"owner replaced an earlier memory wording"`).

**Surfacing.** `MIN_QUERY_SCORE`; `reciprocalRankFusion` / `RRF_RANK_CONSTANT = 60`;
`recallTier`; the five caps; `literal-history.ts` truncating to 1 024 bytes **with no
`truncated` flag**; `living-notes.ts` showing only the newest 6 facts per area;
`readChangedTopics` choosing the nightly worklist. And **`readTopicSources` /
`readRootSources` fabricate a source** — when an area has no active facts they insert
synthetic text (`"Area X currently has no active atomic facts."`) under a borrowed event id
and present it to the model as evidence. Never synthesise a source; report "no active
facts" as a field.

**Silent failure.** When a memory search times out, errors, is unconfigured, or the archive
circuit is open, the model receives **no memory and is never told** — only telemetry learns.
Jarvis must be told the search failed so it can say so or search itself.

**Hardcoded prose in Jarvis's voice.** `removeUnsupportedSentences`'s `"I did not complete
the unreceipted action."`; ~12 canned sentences (`NOT_SAVED_FALLBACK`, `POST_COMMIT_FALLBACK`,
`DEADLINE_FALLBACK`); every `MemoryOwnerControlsService` receipt, which is displayed
**verbatim**; the ledger `reason` fields; the memory-control refusals; and
`memory-extraction-budget.ts`'s `"I will stop extracting new memories before that limit is
exceeded."` — which asserts a decision the model never made. Return structured facts
(counts, ids, state) and let Jarvis write the sentence.

**`pipelineSaved` is a named anti-pattern.** `owner-telegram-agent.ts` decides whether a
write happened by **regex-matching the sub-pipeline's own prose receipt**
(`/^(?:Saved\b|Updated\b|Recorded\b|Forgot\s+\d+\b|...)/`). Its sibling `poll()` in
`job-table.ts` carries a comment saying that deciding what happened by matching words "would
make this classify its own prose" — and uses the environment instead. `pipelineSaved`
violates the pattern the repo already documented.

**How the model is allowed to work.** `const MAX_TOOL_CALLS = 1` — one tool call per turn
means Jarvis cannot chain a decision ("search, then correct what I found"). Ceilings on time
and output are plumbing; a one-call limit is a "how" decision, and it belongs in the prompt
as guidance rather than in code as a wall.

**Silent loss and false state in the hourly job.** `runNext`'s text-budget branch
permanently drops one oversized turn and then advances the cursor past it; `narrowWindow`
halves the window up to four times, choosing which half the model may see; a provider
response one entry over the cap is discarded whole rather than trimmed;
`AUTOMATIC_TOPIC_CREATION_LIMIT` silently reroutes to Inbox; `readAutomaticTopicPromptTree`
truncates area names in file order by popping children. **The worst of these: when the
topic-tree reader is absent, `runNext` sets `existingTopicTree = []` — it tells the model
there are no existing topics when in truth it cannot read them.** A false statement about
state is worse than an error. Fail loudly, or say the list is unavailable.

**Misreported outcomes.** `failureClassification` relabels a provider **policy denial** as
`budget_blocked`, so the owner reads "out of money" for something else entirely.
`recordProviderProposalRejection` finalises the whole window as `failed` even when other
proposals committed. `refileInboxItems` replaces a caught error with invented counts
(`examinedItemCount: 0`).

**Scope decided in code.** `forget` is scoped to exactly one source turn with 0/1 magics baked
into the command shape (`totalCoveredTurnCount: 1 as const`), and code then decides whether to
disclose the collateral it computed. `confirm` refuses past 7 sources, requires substring
containment of the excerpt in Sid's text, and restricts tap-confirmation to `origin ===
'model' && basis === 'inferred'`. Whether Sid's message confirms something is a judgment.

**Prose sniffing, again.** `referencedItemIds` (`telegram-memory-controls.ts`) regex-parses
**both the injected context and the model's own prose** to decide which memories it
referenced, capped at 8, first-seen. The agent path already has the model name ids
structurally (`claimedActions[].receiptIds`); this path should too.

### What to keep (do not regress these)

- `OWNER_TELEGRAM_TOOL_DEFINITIONS` — the model chooses its tools. This is the shape to copy.
- **`TelegramMemoryControlModelAdapter.streamCaptured`'s fall-through** — anything its regex
  does *not* recognise reaches the model unchanged, token by token, indexes untouched. This
  is the shape the whole adapter should have; only the recognised branch replaces the model.
- `validateExtractionProposal`'s boundary: the model may not set its own `origin` /
  `uncertain` / lifecycle state. Code *refusing to accept* a decision is not code making one.
- The proposal-then-YES flow (`remember` → `proposed`, `confirm` requiring an answered
  decision bound to a verified identity). Exactly rule 4.
- Every suppression row, and `memory-repository.ts`'s append-only correction machinery
  (`supersedeStatements`, `forgetItem`, `liftItem`, `confirmItem`). Owner-written, rule 4.
- Content fidelity: living notes injected byte-for-byte, `applyTopicMerge` recording
  `actor = 'model'`, evidence envelopes passing ids and timestamps unparaphrased.
- The `StatementBudget` / cursor / receipt / telemetry plumbing. It decides nothing.

---

## 3. The structural decision: flat `facts` table, or the existing ledger?

The roadmap specifies a flat `facts` table. The repo has
`memory_items` + `memory_item_versions` + `memory_item_sources` + `memory_item_transitions`
+ `memory_item_state`, all guarded by immutability triggers, a transition state machine and
the `events_memory_owner_command_ingress_guard`.

**Recommendation: keep the ledger, and satisfy the roadmap through views and tools.** The
roadmap's column list maps onto the ledger almost completely, and the ledger is strictly
stronger where it differs:

| Roadmap column | Ledger equivalent | Note |
|---|---|---|
| `id` | `memory_items.item_id` | the id the model passes |
| `text` | `memory_item_versions.text` | per version, append-only |
| `kind` (durable/temporary) | **nothing** | `memory_items.kind` is a subject axis, not lifetime; `valid_to` is the only lifetime signal |
| `confidence` (stated/inferred/confirmed) | `basis` + `uncertain` + `origin`, tied by `CHECK`s | richer superset |
| `source_type` | `memory_item_sources.channel IN ('telegram','voice','system')` | **`email` missing** |
| `source_ref` | `event_id` + `event_sequence` + `source_location` + `r2_segment_id` | pointers into the immutable ledger, stronger |
| `created_at` | present at every layer | |
| `expires_at` | `valid_to` | column exists, **no writer** |
| `superseded_by` | `lifecycle_state='superseded'` + a `supersedes` link (inverse direction) | needs a read path, not a column |
| `hidden` | `lifecycle_state='forgotten'` + `memory_event_suppressions` | different shape, stronger: it hides the evidence too |
| `pinned` | **nothing** | greenfield |

Replacing this with a flat table would be a destructive migration against remote D1 with an
immutability guard standing in the way, and would discard the suppression and provenance
machinery that the "forget" guarantee depends on.

**This is a question for Sid, not for the builder.** A reasonable reading of the roadmap is
literally "build this table". The counter-argument above is why I would not, but the roadmap
is his document and it wins. Ask before writing a migration.

---

## 4. The tool surface

Nine tools are needed. Six exist; three are greenfield. Names follow the roadmap, which
means renaming `memory_remember` → `memory_save` — note that
`tool-classification.test.ts` derives its list from `OWNER_TELEGRAM_TOOL_DEFINITIONS.map(d
=> d.name)`, so a rename is caught there, and `OWNER_TOOL_CAPABILITIES` must be updated in
the same change.

**Today, 0 of 6 memory tools contain an example and 0 explain any individual input**; no
JSON Schema `description` key exists on any parameter anywhere. Descriptions below are
written to the standard the roadmap sets — what it does, when it is useful with a short
example, what each input means.

### `memory_save`
> Save one thing about Sid worth keeping. Use it the moment he says something that would
> still be true and useful next week — "I hate mornings", "my sister's name is Mia", "I'm
> vegetarian now". Do not save one-off states ("I'm tired today"), things he asked you to do
> rather than facts about him, or anything he is quoting from someone else.
>
> - `text`: the fact in Sid's own words, one sentence. Do not summarise or tidy his phrasing.
> - `kind`: `durable` for something with no end date, `temporary` for something that stops
>   being true — pair `temporary` with `expires_at`.
> - `confidence`: `stated` if Sid said it plainly, `inferred` if you worked it out.
> - `source`: leave it out; the turn you are answering is the source.
> - `expires_at`: RFC 3339 UTC, only for `temporary`. "I'm tired today" expires tonight.

### `memory_correct`
> Replace a memory whose wording is now wrong, when Sid says the thing changed — "actually
> my favourite subject is physics". Pass the id of the memory being replaced and the new
> wording from his current message. The old wording stops being current and stays in the
> history; it is never overwritten. Do **not** use `memory_save` for a change like this,
> because that leaves both versions current and neither is trustworthy.
>
> - `itemId`: the memory being replaced, from the ids in your context.
> - `newText`: the new wording, drawn from Sid's current message.
> - `reason`: one short clause saying what changed — "he corrected the subject". Stored with
>   the version and shown by `memory_explain`.

### `memory_forget`
> Stop using a memory and hide the conversation it came from. Use it when Sid says to forget
> something, or says a fact about him is not true any more and he does not want it kept.
> If more than one memory could be meant, pass every candidate id and leave the excerpt out;
> you will be asked to confirm rather than changing anything.
>
> - `itemIds`: one to eight ids from your context.

### `memory_restore`
> Bring back a memory that was forgotten, when Sid says he wants it used again. It returns as
> unconfirmed, so it will not be treated as settled until he agrees to it again.

### `memory_confirm`
> Mark an inferred memory as confirmed once Sid agrees with the exact wording. Confirm
> language must be in his current message ("yes", "that's right", "keep it"). A guess of
> yours is never promoted from your own words alone; you present the stored wording and he
> answers.

### `memory_explain`
> Show Sid where a memory came from and how it has changed: every version of it, each with
> the date and the message it came from. Use it when he asks how you know something, or why
> you believe a thing about him. Read-only — nothing changes.
>
> *(Today this returns only the current wording. The version chain and its dated sources are
> already stored in `memory_item_versions` / `memory_item_sources`; only the read path and
> the tool are missing.)*

### `memory_search` *(new)*
> Search everything you know about Sid by meaning, not by wording. Use it when his question
> is about something you were not already given — "what did I say about the car", "anything
> about my sister". Search before saying you do not know. Hidden and expired memories are
> never returned.
>
> - `query`: what to look for, in ordinary words.
> - `limit`: how many to return. Ask for more rather than repeating a search.

### `memory_pin` / `memory_unpin` *(new, greenfield)*
> Pin a memory that is part of who Sid is — his name, his timezone, how he likes to be
> spoken to, the things that are true of him in every conversation. Pinned memories are
> given to you at the start of every conversation, so pin sparingly: a handful, not a
> hundred. Unpin when it stops being that.
>
> *(Requires a `pinned` concept that does not exist — no column, table, state, tool or recall
> rule. See §5.)*

Also required by Phase 1 and absent from the prompt today: current **date**, **time**,
**timezone**, **channel**, and **shadow-mode state** (§7).

---

## 5. Gaps — abilities the model does not have

1. **Pinning and the core profile do not exist.** No `pinned` column, no tools, no recall
   rule, and memory never enters the system prompt. The nearest analogue is the
   model-written *"Living profile"* root-topic note, which arrives as **untrusted reference
   context** and can be redacted — that is not a core profile.
2. **Expiry is unreachable.** `memory_item_versions.valid_from/valid_to`, the nightly
   `expireElapsedFacts`, and the `(valid_to IS NULL OR valid_to > now)` filter in every recall
   path all exist — but **no caller ever sets `valid_to`**: both production writers pass
   `null` and no tool takes an expiry. **No memory can be temporary today.**
3. **`memory_search` does not exist.** Recall is automatic and non-addressable; Jarvis cannot
   ask for more, and cannot tell that a search silently failed.
4. **`memory_explain` returns only the current version**, not every version with its dated
   source. The data is stored; the read path is not written.
5. **No `reason` on correction**; reasons are code constants.
6. **`source_type = email` has no value and no writer.** Only `telegram | voice | system`, and
   the only two `memory_items` writers are the owner controls and nightly distillation.
7. **`memory_reprocess_jobs` is a zero-caller table** — created by `0016` with three triggers,
   and no production reader or writer. The same defect class the repo has hit before.
8. **The voice channel has no tool dispatch at all** (`0` matches for
   `tool|function_call|functionCall` under `src/voice`), so a phone call cannot use any of
   this. The roadmap's one-brain requirement is not met.
9. **The hourly wake-up exists but decides.** `poll` → `distilMemory` runs on `0 * * * *` and
   calls a model, but it never says "here is the last hour, decide": code picks the cursor
   window, the eligibility filter, the prompt, the cap (`proposalCap` from a D1 statement
   budget), the 8 oldest-first eligible turns, halving the window up to four times, and the
   filing.
10. **The "conversation went quiet" alarm does not exist.** `setAlarm`/`deleteAlarm` appear in
    `src/` only in `voice/call-session-do.ts` for the step-up window. Nothing in
    `conversation/` watches for inactivity.
11. **`schedule_wakeup` / `list_wakeups` / `cancel_wakeup` do not exist** (zero repo-wide
    matches), and nothing keeps a wake-up list to set the DO's single alarm from — the
    roadmap's own note about one-alarm-per-DO is unaddressed.

---

## 6. Wake-ups

The roadmap's two are both mis-shaped or absent, and one is *nearly* right:

- **Hourly review — exists as a mechanism, wrong as a decision.** Keep the `0 * * * *` cron as
  the wake-up; change its payload from "run the distillation pipeline" to "here is the last
  hour of activity", and move the window/filter/cap/filing decisions into the model.
- **"Conversation went quiet" — build it.** Needs a DO alarm or a scheduled scan plus a
  quiet-period definition. Note the DO holds **one** alarm at a time, currently used by the
  voice step-up window, so this needs either a separate DO or the wake-up-list design the
  roadmap describes.
- **Cron/DST is already correct and must not be broken.** `localHour`, `localDate`,
  `localWeekday` all go through `Intl.DateTimeFormat` with an IANA zone; the daily and night
  crons are deliberately two UTC hours an hour apart so exactly one lands on the target
  local hour on either side of the DST boundary, and `cron-router.test.ts` asserts **which**
  firing, not a count. Two hardcoded `America/Toronto` constants (`living-notes.ts`'s
  `TORONTO`, `memory-extraction-budget.ts`'s `torontoBillingMonth`) bypass `DIGEST_TIMEZONE`
  and would silently disagree if it were ever set to another zone.

---

## 7. The prompt

`OWNER_TELEGRAM_AGENT_SYSTEM_PROMPT` is a frozen two-paragraph literal whose only
interpolation is a compile-time example. It carries **none** of: the core profile, the job,
tier guidance, date, time, timezone, channel, shadow mode, or per-channel behaviour. Its only
memory-adjacent sentence is a *prohibition* (`Do not call a school, university, study, or
memory tool merely because a related word appears`). There is no instruction to notice
anything and no proactive-remembering duty.

Sections to add, in this order:

1. **Who Jarvis is** — beyond one sentence: Sid's assistant, how it speaks, that it is his
   and not a command system.
2. **Core profile** — the pinned facts, injected automatically (needs §5.1).
3. **The job** — notice and remember without being asked; keep school on track; act like a
   thoughtful person. This is the section whose absence is why nothing is proactive.
4. **Tier guidance** — what to do freely vs what to ask about first. Tiers are enforced in
   code (`ToolAutonomyGate` → `decideOutcome`) but the model currently learns its tier only
   from the refusal receipt *after* guessing.
5. **Right now** — date, time, timezone, channel, shadow-mode state.
6. **How to behave on this channel** — shorter and spoken on a call, no lists.

Memory currently reaches the model only as a second `system` message labelled *"untrusted
reference data"*. That is the right treatment for retrieved evidence; it is the wrong place
for a core profile, which is why §5.1 matters.

---

## 8. Guard strategy — the prompt is currently unpinned

**No test pins the owner-agent system prompt, and no test pins any production tool
description.** Verified by search, not by mutation: repo-wide `grep systemPrompt` finds 7 hits
in 4 files, none in a test; `grep '\.requests'` in `test/channels/` finds 59 hits and every
one reads `timeoutMs`, `toolChoice`, `toolResults[].content` or the Telegram payload — **none
reads `.systemPrompt` or `.tools`**.

What *is* pinned nearby, and will break if touched: `tool-classification.test.ts` (the tool
**name set**, not descriptions); `deepseek-provider.test.ts`'s exact-body assertions (against
a test-local duplicate of a *different* prompt); `telegram-memory.test.ts` (the recalled
context envelope prefixes).

Because prompt quality is where the roadmap says most of the "feels like a person" comes
from, and it is the thing nothing guards, the builder should add mechanical guards and
**mutation-verify each one**:

- every tool in `OWNER_TELEGRAM_TOOL_DEFINITIONS` has a non-empty description, and every
  property in its `parameters` has a `description` — neuter by removing one description and
  confirm a **named** test fails;
- the composed prompt contains each of the six sections of §7 — neuter by deleting a section
  and confirm the named test fails;
- the pinned-fact block actually reaches the prompt (this is the guard that would catch a
  core profile silently rendering empty).

Two further gaps worth closing: `memory_correct` is absent from
`OWNER_TELEGRAM_ROUTING_EVAL`, from its `ExpectedOwnerTelegramTool` union and from
`scripts/evaluate-owner-telegram-agent.ts`'s tool array — so the best-described memory tool
is the one the routing corpus never exercises. And `scripts/evaluate-owner-telegram-agent.ts`
carries its **own divergent copies** of the prompt and every tool description, so a routing
score read from it is not a score for the production prompt.

---

## 9. Sequencing

1. **Delete the code-replacement path** (§2.1). Route memory control through the model's
   tools; the agent path already works this way. Highest ratio of rule-compliance to effort,
   and it removes the only place Jarvis is not consulted at all.
2. **Turn the hourly job into a wake-up** (§6) and add the two tools it needs to act on what
   it finds: `memory_search` and a working `memory_save` with `kind` / `expires_at`.
3. **Give durability a writer** (§5.2) — the column, the nightly expiry and the filters all
   exist; write the value and let the model choose it.
4. **Pinning and the core profile** (§5.1) — greenfield; needs a migration and the two tools.
5. **Stop the code deciding evidence class and lifetime** (§2.2) — the change that makes
   production publish active facts. Expect this one to be contentious: the regexes exist to
   stop a model certifying its own provenance, so separate *provenance* (keep) from
   *judgment* (move).
6. **Retrieval**: add `memory_search`, un-hide the dropped hits, report failures, mark
   truncation, remove the fabricated sources and the term-overlap suppression.
7. **Prose**: return structured outcomes and let Jarvis write the sentences; delete
   `pipelineSaved`'s prose sniffing.

---

## 10. Migration and numbering hazard

The ceiling on `main` is `0035_autonomy_tool_capabilities.sql`, with no gaps. **Two different
files claim `0036`** across the refs in this clone
(`0036_email_read_everything.sql` and `0036_owner_sensitive_action_pin.sql`), and `0037` is
also claimed. `0038` is *documented* as next free but no `0038` file exists anywhere in this
clone — treat that as a claim, not a fact, and check the refs before choosing a number.

Any migration here is remote-D1 and must be **additive only, with no CASE-wrapped RAISE**,
and **no semicolons inside SQL comments** (the test splitter divides on `;`). A comment
directly above a `CREATE TRIGGER` is lifted with the trigger, deliberately.

Production's applied ceiling is unreadable from the repo and was not queried. Whether `0035`
is applied is an owner-only check.

---

## 11. Questions this spec cannot answer

1. **Flat `facts` table, or the existing ledger mapped to it?** (§3) The roadmap reads as the
   former; the recommendation is the latter. This decides whether the work is a migration or
   a rebuild.
2. **The roadmap says Jarvis is Claude with tools and names the Claude API. The code calls
   DeepSeek** (`deepseek-provider.ts`, `DEEPSEEK_API_KEY`, and a hardcoded
   `deepseek:deepseek-flash` as the only permitted consolidation model). If the roadmap is
   literal, the provider changes — a much larger piece of work than Phase 2.
3. **Does Phase 2 include the one-brain DO?** The roadmap puts conversation state and the
   model loop in a Durable Object; today conversation state lives in D1
   (`conversation_turns`) and the only DO is `CallSession` for voice.
4. **Renaming the tools to the roadmap's names** (`memory_remember` → `memory_save`) touches
   the capability map and two test files. Confirm before doing it.

---

## 12. What this spec did not do

- **No test was run and no mutation was executed**, by any of the four audits or by me:
  the pass was read-only by instruction, and a mutation requires editing. Every claim is
  proven-by-reading at `1b9cec5` / its parent `6c64312`, and the memory subsystem is
  byte-identical across the two. Nothing here is observed runtime behaviour.
- **No production state was read.** Whether `0035` is applied, whether the Vectorize index is
  populated, and the live migration ceiling are all unverified.
- **Not audited**: `memory-backup*`, `sync/memory-distill.ts`, `sync/memory-projection.ts`,
  `security/redaction.ts`, most of `memory-repository.ts`'s visibility internals, and the
  voice channel beyond confirming it has no tool dispatch.
- **Things found and deliberately not chased**, named so they are not lost: `mergeMemory`
  compares a **byte** budget against a **token** count; `withoutForgottenTurns` bounds its
  forgotten set by ULID order (`LIMIT 129`); `citedMemoryItemIds` requires the literal
  English `"item <ULID>"` in the model's own prose; `plainCurrentTurn` demotes any multi-line
  owner message to non-control; `literal-history.ts` has `MAX_SEARCH_RESULTS = 8` beside a
  `?? 5` default in the same file; `living-notes.ts` `finalizeRun` appears to bind
  `input_event_count` / `created_item_count` to swapped counts;
  `automatic-distillation.ts` `continuationRequired` is never true while `job-table.ts`
  branches on it; `memory-owner-controls.ts` `redactPayload` refuses outright when the
  Redactor would alter the text, so a memory containing a secret-looking string is dropped
  rather than re-worded; `readTelegramMemoryOwnerTurn` requires `payload.sensitivityCode ===
  1`, silently excluding sensitive turns from the control path; and `PROVIDER_MODEL`'s vendor
  allowlist (`/^(?:deepseek|anthropic|openai):…/`) is hardcoded inside memory code.
- **Two `docs/STATE.md` claims are stale and the code wins**: "Live defects" #2 (the
  distillation suppression predicate) was fixed by `da723ec`, 35 minutes *after* `STATE.md`
  was regenerated; and CI is described as dead since 2026-09-12 while CI runs today. Both
  belong to the PR that regenerates the carriers, not to this one.

Reported by **DeepSeek V4.1 Flash**. Reasoning-effort level was not exposed to the session
and is not claimed.
