# Known issues

## Several tools per turn: what still allows only one write per turn (2026-09-25)

The owner tool loop now lets Jarvis take several steps in one turn (search, read,
record). Two limits below it were hidden by the old one-call cap and are now reachable:

- **One memory change per turn.** `commandKey` in
  [`memory-owner-controls.ts`](apps/cloud-gateway/src/memory/memory-owner-controls.ts)
  keys every memory mutation's idempotency record as `<owner turn event id>:mutation`.
  A second, different `memory_remember` (or forget, correct, confirm, pin) in the same
  turn meets that key with a different request hash and is refused, so the model is told
  "I could not safely apply that tool call". Proven by a test run on this branch (a
  second remember in one voice turn was refused with `memory_refused` from
  `hasCommand`). The fix is a per-turn ordinal in the key that keeps the first key
  unchanged for replays; it touches replay idempotency, so it is its own change.
- **One school plan save per turn, unverified.** `applyOwnerPlan` records its receipt
  by `turn_id` (`school-catchup-repository.ts`), which looks like the same shape. Not
  tested here.
- **Request size.** Every step's results are sent back to the model, and the provider
  refuses a request over `MAX_MODEL_REQUEST_BYTES` (128 KiB). A long chain of large
  reads can reach it; the turn then ends with its receipts and a fallback line rather
  than an answer. Not observed; unverified in practice.

## Confirmations outside Sid's five that migration 0051 does not remove (2026-09-25)

[#199](https://github.com/stremysid/jarvis/pull/199) makes tier 3 exactly
Sid's five actions (spending money, sending an email, making a call,
submitting school work, texting or calling someone on his behalf). Sid,
2026-09-24: "the only things I'd might want a human to double check with me
is the stuff I mentioned and that's literaly it". Four other asks exist
outside the tier registry and are not changed by it:

- **Forgetting two or more memories at once: RESOLVED 2026-09-25.** This used
  to raise a `telegram-memory-forget` tap because the memory ledger recorded
  one mutation per owner turn (`commandKey`). `OwnerAgentCore.forget` in
  [`owner-agent-core.ts`](apps/cloud-gateway/src/agent/owner-agent-core.ts)
  now forgets every id it was given, and each target carries its own key,
  `<turn event>:forget:<itemId>`. Nothing is queued for a tap. The consumer
  that resolves a decision already in the queue
  (`forgetConfirmedDecision`) is kept, not deleted. See
  [CODE-VS-JUDGMENT](docs/CODE-VS-JUDGMENT.md) rows 6–9 and 13.
- **Changing guest access on a call ends with "Say confirm".**
  `#confirmOwnerAccess` in
  [`call-session-do.ts`](apps/cloud-gateway/src/voice/call-session-do.ts).
  Granting a guest access is Sid's own action, so by his rule it should not
  ask. It stays because the flow starts from a phrase grammar
  (`parseOwnerAccessIntent`), itself on the removal list of Sid's rules
  (code deciding what he meant). Removing only the confirm would let a
  misheard phone number grant a stranger guest access with nothing read back.
  The fix is to replace the grammar with a tool the AI calls. Guest PINs and
  guest isolation are not affected either way.
- **`/call <reason> --confirm` in Telegram, and `jarvis call-me` on the
  PC.** Both place a call to Sid's own verified phone and both need an
  explicit confirm. They are kept as action 3, "making a call". If Sid means
  only calls to other people, both are small removals.
  (`call-me` has no handler registered today.)
- **Tier 2 is withheld while shadow mode is on.** It is not a confirmation:
  `/shadow off` is Sid's own switch and makes every tier-2 action run
  without asking. Whether production is in shadow mode was not queried.
  `delete.data`, `write.production` and `vehicle.unlock` moved to tier 2
  and have no tool yet. Tier 2 therefore no longer means "reversible", as
  `0008` described it. It means "not one of the five". When a tool for
  deleting data or touching production lands, it will run unconfirmed once
  shadow mode is off. That follows Sid's 2026-09-24 rule, and `0051` and
  `autonomy-types.ts` say so.

Not action confirmations, and kept: the tap that confirms a *model-inferred*
memory is true (it records whether the fact holds, not whether to act), the
D2L collector pairing tap (it binds a new device to Sid), and a guest's own
PIN (guest isolation).

After `0051` no tool the agent dispatches today is tier 3, so the tap and the
call PIN cannot be exercised in production until one of the five has a tool.
Read from the restore code, not tested: a memory backup taken before `0051`
would restore the old tiers with it, because `capability_tiers` is a
backed-up table and the restore's `reset_seeded_rows` phase replaces the
seeded rows with the backup's. Such a set has no rows for the three new
capabilities, which would then be refused as unregistered rather than run.

## Literal-history rows that cannot be decoded are skipped, not surfaced to search (2026-09-25)

Since #194 round 2, `indexSequences` in
[`literal-history.ts`](apps/cloud-gateway/src/memory/literal-history.ts) records a
row it cannot decode (an envelope that fails validation, a control character
other than a line break or tab, non-NFC or oversize text, a payload that is not
history-eligible) as a `failed` row in `memory_history_coverage`, with a named
`failure_code` such as `history_row_text_invalid`, and moves the cursor past it.
The hourly job reports the count as "rows skipped". What is not done yet:

- `searchLiteral` does not tell the model that a skipped row exists, so a
  `no_hit` covers every row that was indexed, not literally every row.
- An exhaustive search job still fails as `history_step_corrupt` when its walk
  reaches such a row.
- A skipped archived row settles on its segment id alone, and no test drives a
  skipped row through the archive path.

Line breaks themselves are no longer a problem: the search copy stores them as
spaces (the 0016 and 0025 CHECKs refuse them) and the event keeps the original.

## history_search limits (2026-09-25)

- **The newest messages are never in the index.** The index is built by the
  hourly job, so the current conversation and anything since the last run are
  reported as an unindexed range rather than searched. Scanning that range is
  plan #122 phase 4b.
- **Archived call replies below the cursor are not backfilled.** Call replies
  (`conversation.assistant_sent`) became history in this change; the maintenance
  pass indexes the ones the cursor had already passed, but only while they are
  still live in D1, because an event sealed into R2 carries no type in D1.
- **One call reply cannot be forgotten by its id.** `0016`'s
  `memory_event_suppressions` insert trigger admits only `user_committed` and
  `assistant_delivered` single-event targets. A range forget still hides call
  replies, and every history read honours it. Widening the trigger is a migration.
- **No date, channel or sort filters and no whole-day read** yet; results carry
  the date and channel so the model can judge.
- **Call replies are still written with `historyEligible: false`.** On a call
  reply the flag is legacy: every reader (literal history, recent context and
  the spoken-reply reader) goes through `admitsHistoryEligible` and admits
  either value, so flipping the writer later changes nothing. Pinned by
  `test/conversation/history-eligibility.test.ts`.
- **Backfill waits for the cursor.** Old call replies are backfilled only on
  steps where the cursor has no new events to index, so new messages are never
  held back; with a large backlog the backfill itself can take several hourly
  runs (8 steps each).

## Restoring a set at an older schema version still checks today's seeded rows (2026-09-25)

Since #194 round 2, the restore accepts a set whose table cuts are a subset of
`MEMORY_BACKUP_TABLES`, restores each table it holds by name, and skips backup
tables the target schema does not have. `assertFreshRestoreTarget` still
compares the migration-seeded rows (`capability_tiers` and the singletons) with
the list in the current code. A target migrated only to an older set's schema
version, from before a migration that seeded new capabilities, fails that check
as `memory_backup_restore_target_not_fresh:capability_tiers`. This is older
than #194 and applies to any older-version set.

## Tier-3 confirmations issued before tool binding (2026-09-24)

#182 changes confirmation references from
`capability:argumentsHash` to a JSON tuple of tool name, capability and argument
hash. A previously issued confirmation cannot prove its tool name and deliberately
does not match the new gateway, even if the owner answers its pending button after
deployment. The old answer remains recorded but is not consumed or upgraded.
The owner must ask for the action again and tap the newly issued confirmation.
There is no compatibility fallback or migration in this change.

A changed second autonomy outcome denies that attempt, even when the new outcome
is `permitted`. Its receipt names the change and says the tap was spent. The
claim is not refunded. Migration `0039` and its atomic single-use consumption
remain required; [the existing rollout](docs/reviews/2026-09-23-tier3-tap.md)
still applies. The [#182 review](https://github.com/stremysid/jarvis/pull/182#issuecomment-5822209807)
records the harness's focused set at 472/472 and the independent review's full
suite at 6683/6683 with 5/5 mutants killed. #182 merged at `a20f055` and is not
deployed; what remains is the deploy, plus a fresh tap for any tier-3 confirmation
pending at deploy.

## DeepSeek error response body can outlive its timeout (2026-09-24)

`DeepSeekModelAdapter.stream` in
[`deepseek-provider.ts`](apps/cloud-gateway/src/providers/deepseek-provider.ts)
clears `overall` after receiving non-success response headers, then awaits
`response.text()` for the error detail. A stalled error body therefore has no
request deadline. PR #174 is changing this file; its builder should keep the
deadline armed through that body read and pin the case with an injected fetch.

## Call transcripts are not verbatim: Deepgram strips "um" and "uh" (2026-09-24)

Calls use Deepgram through Twilio ConversationRelay with no `filler_words` option
([twiml.ts](apps/cloud-gateway/src/voice/twiml.ts)), and Deepgram's default is `false`, in
which case "uh" and "um" are stripped from the transcript — "When `filler_words=false` or
the parameter is not set, the two most common fillers, 'uh' and 'um', are stripped out of
the transcript" ([Deepgram docs](https://developers.deepgram.com/docs/filler-words)).
That ConversationRelay leaves `filler_words` unset is inferred from Deepgram's default; no
live call was checked.

`guided_assignment_save` stores `input.userText` as `raw`
([guided-assignment.ts](apps/cloud-gateway/src/school/guided-assignment.ts)), and on a call
`input.userText` is, by that inference, the stripped transcript. So the saved "raw" answer is the transcript
Jarvis received, **not a verbatim record of what Sid said**. Telegram text is unaffected:
it reaches the turn as typed. Nothing in the repository claims a filler-word option;
`git grep -n -i filler origin/main -- apps/cloud-gateway/src/voice` finds no match. This
is recorded as a limit of the "raw" guarantee, not as a defect to fix silently — changing
it means either enabling filler words or narrowing the claim. The standing rule is that the
model cleans up spoken answers and regex-stripping filler words is ruled out; that rule
forbids regex-stripping, not enabling filler words.

## Owner voice streaming acceptance (PR #171, 2026-09-24)

Live DeepSeek tool-call streaming and phone latency remain unverified. The
round-2 model marker protocol checks this-turn receipt/tool provenance for one
declared sentence, with regexes only as an omission backstop. An omitted novel
claim or a semantically wrong description attached to a real receipt is still
a model failure code cannot prove away. Both #171 and #172 are merged on main;
recorded local integration covers the real guided-assignment service with a fake
Telegram provider. Live model compliance and provider delivery remain untested.
See [the design and evidence](docs/voice-streaming.md) and the first live check
in [OWNER-ACTIONS](docs/OWNER-ACTIONS.md). No live check or rollout is implied.

The following low-severity follow-ups from the independent review remain open:

- **L2′:** A literal `[[` in ordinary prose, such as "In Obsidian, write
  `[[Page name]]` to link.", throws `voice_claim_invalid` and aborts the spoken
  reply.
- **L3′:** A held pre-tool refusal is spoken at the end of round 0, out of
  order.

- **L5:** `guardVoiceReplySentence` now exempts only the omission backstop from a
  `[[worked]]` declaration; `FALSE_EXTERNAL_COMPLETIONS`, the passive patterns and
  `VOICE_MEMORY_COMPLETION` always run. #162's `WORKED_APPLIED_FOR_YOU` mask is deleted
  by [#204](https://github.com/stremysid/jarvis/pull/204) (register row 11), so a voice
  sentence phrased as "I applied the X rule for you" is conservatively replaced even when
  the model declares it worked. That is deliberate fail-closed behaviour, not a bug:
  "applied ... for you" is the external-application grammar, and narrowing it would
  reintroduce the deleted worked-object list. `VOICE_MEMORY_COMPLETION` still matches
  "saved" without a worked-object check.
- **L6:** No test pins #162's worked-explanation sentence in
  `OWNER_VOICE_STREAM_PROMPT`. The matching assertion in
  [tutoring-reply-review.test.ts](apps/cloud-gateway/test/school/tutoring-reply-review.test.ts)
  checks `OWNER_AGENT_SYSTEM_PROMPT`; the voice test uses a fixed provider reply.
  The review reports that mutant N27 survived.

Source: [#171's independent review](https://github.com/stremysid/jarvis/pull/171#issuecomment-5817201176).
The guard paths and missing voice-prompt assertion were checked against merged
main on 2026-09-24; the six-case and N27 results are the review's measurements,
not new probes. Both fixes belong to the builder in [QUEUE](docs/QUEUE.md).

Sid's 2026-09-24 report, "ive already done test calling and it works", establishes
his working-call observation, not the specific streaming checks above.

## Guest-call privacy leak — live until #174 deploys

On main and at the observed production revision `0d69556`,
[`OwnerAgentCore.streamCaptured`](apps/cloud-gateway/src/agent/owner-agent-core.ts)
reads the configured owner's pinned core profile unconditionally and builds an
owner-framed system prompt. The
[voice adapter](apps/cloud-gateway/src/voice/voice-agent.ts) also supplies its owner
tool catalogue before `canActOn` refuses guest tool execution. An authorized guest
conversation can therefore send Sid's pinned facts, owner framing and owner
catalogue to the model. The later tool refusal does not protect prompt contents.
The catalogue is model request metadata alongside the system prompt; this finding
does not claim guest tools execute or that a live guest test was performed.

[#174](https://github.com/stremysid/jarvis/pull/174) carries the fix. The defect
remains live until that change merges and deploys; production still runs `0d69556` (#165),
which predates it. See [STATE](docs/STATE.md#production).

## Telegram keyboard payload fields (PR #174 round-3 L2)

The round-3 review records Telegram keyboard payload fields rejecting staged ids.
This is **fail-closed**: affected confirmation delivery can be refused, not granted
extra authority. Keep the fix in a **separate PR**, as the round-4 brief requires.
Trace `assistantStagePayload` and staged-event readback in
[conversation-repository.ts](apps/cloud-gateway/src/conversation/conversation-repository.ts)
through payload-field validation and
[outbox-dispatcher.ts](apps/cloud-gateway/src/conversation/outbox-dispatcher.ts).
Retain the decision/callback grammar and structural-id redaction boundary.
Source: the harness's 2026-09-24 round-3 verdict and round-4 brief; no new failure
probe was run in this docs-only refresh. Tracked in [QUEUE](docs/QUEUE.md).

## Reply-claim tutoring exemptions are deliberately conservative and partial

PR #162 requires a positive worked object of the claim verb and a completely
parsed explanation prefix and tail. Unknown words and clauses remain claims;
destination, recipient and real-world value vetoes also remain. It cannot prove arbitrary
natural-language action claims. The existing advice/draft exceptions remain,
including the `asked about` exception in `allowedFirstPersonActionClaim`.

Eighteen earlier PR tutoring fixtures now deliberately produce a refusal because
their objects fall outside the requested grammar: for example, saving rounding
until later, sharing a denominator, and adding oxygen atoms. They remain named
regression cases in `tutoring-reply-guard.test.ts`. The supported chemistry forms
use worked laws, formulas and examples. Broadening those forms requires new
adversarial and mutation evidence; a marker anywhere in the sentence is not proof
that an unknown recipient or store is part of an explanation.

Round three also refuses bare "the program" and "the helper": those can name
an admissions program or a person. Code examples must identify the function,
compiler, loop, constructor or method. "I added a stronger hook to your opening
paragraph draft below" remains conservatively refused because the possessive
destination is outside the exemption. The review supplied six of its 34 tutoring
sentences; five now survive, but the complete 34-sentence artifact was unavailable.
The lab-report passive submission/upload gap reported in that review is closed.

Round four leaves two measured gaps in this interim backstop:

- **F1:** A claim in the next sentence or on the next line after an exempted
  worked sentence gets no "I can't confirm that action" notice. The veto is
  sentence-scoped. Main at least flagged these.
- **F2:** The held-out corpus has 22 claim shapes missed at both this branch's
  head and main: passive nouns not on the list, contractions, unlisted verbs, a
  subject that is not directly before the verb, and unlisted adverbs.

There will be no further regex or word-list round. The planned replacement is a
model-declared `{ sentence, toolNames }` claim checked against this turn's
receipts. The plumbing from #172 is on main now. When that replacement lands,
CODE-VS-JUDGMENT row 11 is deleted.

Checked on 2026-09-23 against fetched `origin/main` at
`a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`. These are remaining code limits
or explicitly unverified acceptance requirements, not a claim about today's
production. Fixes removed from the old inventory, with fixing commits, are in
the [audit record](docs/DOCS-VERIFY.md).

Deployment evidence is [STATE](docs/STATE.md#production): **as of the 2026-09-24
orchestrator-observed checks**, production runs source `0d69556` (#165), deployed at 03:47 UTC
on 2026-09-24, with D1 at `0039`. The Worker version id is unverified. Everything merged after
`0d69556` — including #171's streaming and #182's confirmation binding — is not deployed.
Database contents below retain their older observation dates.
Production was not queried for this audit. Owner-dependent acceptance belongs
in [OWNER-ACTIONS](docs/OWNER-ACTIONS.md).

## School collector retention and public pairing remain bounded only in part

The session-API collector is approved (Sid, 2026-09-23); older school sections below
describe the separate iCalendar and notification paths. Collector review round 1
keeps its existing public pairing contract. Four starts per ten minutes now apply
per configured principal, so one principal's starts cannot exhaust another's
budget. All unauthenticated requests to Sid's configured endpoint still count
against Sid's budget. Someone can keep that public endpoint exhausted; this is
not an abuse-resistant invitation mechanism.

Expired pending keys and used nonces are not pruned. Key history is included in
backups; nonces are excluded. Both tables grow over time, and the collector list
is not paginated. A retention follow-up must preserve audit references, terminal
revocation and the complete signature/replay window. No cleanup job or live
deletion was added in this fix round. Read aggregates return one row each, and
refusals are a bounded sample of the latest read per reported host, with truncation explicit.

The receiver compatibility follow-up accepts both boards and retries pairing delivery
with the same decision. Delivery remains at-least-once if Telegram accepts a message
and the process fails before recording delivery; repeated taps still bind the same
decision and cannot create a second key. Status covers reported hosts, not boards the
extension has never reported. Host-only failure batches make discovery/session failures
reportable, but #170 must emit them and remove its old compatibility hold after rollout.
The gateway never follows a paging URL. Unknown projections remain raw with explicit
labels; a good receipt does not mean every shape has a deadline adapter. Positive own
submission shapes, Opera GX persistence/federation, live two-board ingestion and the
real database upgrade remain unverified by this builder.

Positive submission detection currently requires an object with `Status: 1`, but
the owner-observed `mysubmissions/` route returns an array. Empty arrays remain
unknown evidence, and no populated-array projection has been observed.

The review also identified an untested enrollment-retirement case: a course
absent from later manifests may leave a stale per-course deadline source, whose
digest label is only "Brightspace". This round does not retire sources or claim
that scenario was verified. A duplicate activation tap still replies "No collector
was activated by this tap" even if the first tap activated it; the signed pairing
status route reports the actual key state. These are separate follow-ups from
the corrected tool gates, normal 403s and undated digest evidence.

## Runtime, tests and local hosting

| Remaining limit | Evidence and boundary |
|---|---|
| Local Workers tests do not prove production runtime compatibility. | [Chained PBKDF2](apps/cloud-gateway/src/security/chained-pbkdf2.ts) uses six 100,000-iteration calls, and [the cap test](apps/cloud-gateway/test/security/pbkdf2-production-cap.test.ts) checks source parameters. The earlier over-cap implementation was fixed by `d839cad`; this remains a test-environment limitation, not an open claim that current PBKDF2 exceeds the cap. |
| Gateway test types are outside the normal gate. | [tsconfig.test.json](apps/cloud-gateway/tsconfig.test.json) includes tests; [tsconfig.json](apps/cloud-gateway/tsconfig.json) does not. **143 as measured on 2026-09-24 by the builders**; this docs builder could not remeasure because `node_modules/.bin/tsc` is absent. [CI](.github/workflows/ci.yml) does not invoke it. No assertion that every newer directory is clean. |
| Local-agent CI typechecks only the Windows target. | Both CI matrix jobs use `mypy --platform win32`. Direct Linux platform branches, including in [unix_socket.py](apps/local-agent/jarvis_local/transport/unix_socket.py), can be excluded by narrowing. Historical mutation/error totals were not remeasured; they are not current gate counts. This does not imply a Linux machine is needed. |
| Hermes coverage is split and some tests were historically slow. | [TESTING](TESTING.md) and the [manual workflow](.github/workflows/hermes-runtime-manual.yml) identify the two extended files excluded from normal CI. No current duration or extended-suite pass is established here. |
| Hermes profile/source lock bindings disagree. | Canonicalizing [hermes-source-lock.json](apps/hermes-runtime/hermes-source-lock.json) with [canonical-json.mjs](apps/hermes-runtime/src/canonical-json.mjs) gives SHA-256 `9dd8a06d7df921dec55652bb0e2c5ab0488702b288abdc2fb505e66271dbb392`; `sourceLockHash` in [hermes-profile-lock.json](apps/hermes-runtime/hermes-profile-lock.json) is `3f3618bb177da35cab360f4e62c059d28f82cebe14fa98f4582a8c1374ded0d3`. `c363631` re-pinned the source lock without regenerating the profile lock. The profile schema retains that older binding too. An integrity-chain update remains separate work. |
| Windows has a foreground host and boot launcher, not a Windows service host. | [cli.py](apps/local-agent/jarvis_local/cli.py) exposes `serve`; [node.py](apps/local-agent/jarvis_local/node.py) composes it; [jarvis-boot.ps1](ops/jarvis-boot.ps1) launches it. There is no `jarvis service` subcommand. The blanket “no bootstrap” claim is fixed by `e3e3527` and `ec5ebb5`; successful sync, reboot recovery and live certification are separate from that code. |
| Local embeddings are lexical, not semantic. | [embeddings.py](apps/local-agent/jarvis_local/memory/embeddings.py) returns `DeterministicHashEmbedder`; [retrieval.py](apps/local-agent/jarvis_local/memory/retrieval.py) uses FTS. This is about the Python store, not the cloud's Workers AI/Vectorize path. |
| Autonomy read-back validation lacks direct invalid-row coverage. | [autonomy-repository.ts](apps/cloud-gateway/src/autonomy/autonomy-repository.ts) checks `isAutonomyTier` and `isAutonomyMode` after reads. [Its tests](apps/cloud-gateway/test/autonomy/autonomy-repository.test.ts) exercise valid storage and invalid write inputs, not corrupt rows bypassing schema constraints. No new mutation result is claimed. |

## Memory and archive

| Remaining limit | Evidence and boundary |
|---|---|
| Voice and Telegram still retrieve different stores. | [production-runtime.ts](apps/cloud-gateway/src/voice/production-runtime.ts) composes `D1ContextRetriever`; [index.ts](apps/cloud-gateway/src/index.ts) composes `TelegramMemoryRetriever`. They share the owner tool loop in `bde0a9b` (#147), **deployed in the observed production revision `0d69556`**. Voice context still reads the projection, recorded empty on 2026-09-21 under `352991e`; its contents were not re-queried. |
| Provenance enforcement depends on the adapter. | [conversation-repository.ts](apps/cloud-gateway/src/conversation/conversation-repository.ts) persists `directOwnerText`; [telegram-memory-controls.ts](apps/cloud-gateway/src/memory/telegram-memory-controls.ts) checks it for direct controls. [validateOwnerTurn](apps/cloud-gateway/src/memory/memory-repository.ts) still takes caller-supplied flags and intent rather than a complete persisted provenance/intent enum. The old claim that no marker exists is false. |
| Moving or merging the bootstrap inbox can break later bootstrap reads. | `readBootstrapState` in [memory-repository.ts](apps/cloud-gateway/src/memory/memory-repository.ts) requires an active inbox directly under the root. Future topic callers must preserve that invariant or support redirects. |
| Accepted commands can finish later; acceptance and application are separate. | [memory-owner-controls.ts](apps/cloud-gateway/src/memory/memory-owner-controls.ts) replays accepted commands without a durable command expiry. A failed forget/lift race can consume that target's command key without applying (forget keys on the target as of 2026-09-25, so one target's failure no longer blocks the turn); correction appends replacement and retirement commands before its atomic memory batch, leaving a partial command pair if interrupted. |
| Targeting has different limits at different layers. | `exactSingleTarget` applies to individual controls, but `forgetItemsFromDecision` already supports a decision-bound set. [memory-control-targets.ts](apps/cloud-gateway/src/memory/memory-control-targets.ts) caps target discovery and narrows correction candidates to active items; [the control service](apps/cloud-gateway/src/memory/memory-owner-controls.ts) also refuses inactive corrections. The old “every request accepts exactly one” statement was too broad. No new coverage claim for the redundant finder check. |
| Restored inferred proposals do not auto-promote merely because they were restored. | [liftItem](apps/cloud-gateway/src/memory/memory-repository.ts) records an owner transition. An explicit confirmation path now exists in [memory-owner-controls.ts](apps/cloud-gateway/src/memory/memory-owner-controls.ts); saying that it must be built before restore can be exposed is obsolete. [voice-agent.ts](apps/cloud-gateway/src/voice/voice-agent.ts) reads the previous assistant turn from the same call in `bde0a9b` (#147), **deployed in the observed production revision `0d69556`**. A tier-3 confirmation on a call is the spoken or keyed PIN once [#196](https://github.com/stremysid/jarvis/pull/196) is deployed with `OWNER_ACTION_PIN` set; on Telegram it stays a tap. |
| Proposed items remain outside meaning recall. | [meaning-search.ts](apps/cloud-gateway/src/memory/meaning-search.ts) selects `memory_retrievable_item_versions`, whose [0016 view](apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql) requires active state. Keyword/area recall can include uncertain proposals. A non-direct turn may yield an uncertain reference; it does not thereby become an authenticated owner fact. |
| Extraction can duplicate a paraphrase after failed finalization. | [automatic-distillation.ts](apps/cloud-gateway/src/memory/automatic-distillation.ts) derives identity from proposal content and sources, commits items, then finalizes the run. Exact proposal replay is stable; different wording is a different hash. Topic creation/refiling and whole-sentence promotion are implemented, so neither is still “waiting for a slice.” Extraction currently assigns durable lifetime. |
| An unreferenced paraphrase can survive previous-reply forgetting. | On both Telegram and voice, previous-reply filtering removes a reply when its durable committed/cited item ids include a forgotten item, its paired owner turn is suppressed, or its text exactly restates the forgotten current version. A paraphrase with no committed/cited item id has the same lexical limit as canonical retrieval and can remain visible. Widening that judgment matcher is deferred rather than adding another rule in code. |
| Initial archive subject attribution is application-enforced. | [0026](apps/cloud-gateway/src/persistence/migrations/0026_memory_distillation.sql) makes the backfilled subject immutable. The [archive reader](apps/cloud-gateway/src/memory/literal-history.ts) validates the envelope; SQL cannot inspect the R2 envelope on the first subject write. |
| Literal-history hit receipts retain metadata; chunks can be deleted. | [literal-history.ts](apps/cloud-gateway/src/memory/literal-history.ts) rechecks suppression on results, but [0016](apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql) retains append-only exhaustive hit receipts and allows derived chunk deletion. A missing chunk can leave coverage marked indexed. The indexer is composed by [job-table.ts](apps/cloud-gateway/src/jobs/job-table.ts); the former “uncomposed” claim is false. |
| Projection validates the same source repeatedly. | `verifyPageSources` in [memory-projection.ts](apps/cloud-gateway/src/sync/memory-projection.ts) caches event rows but revalidates envelopes and source text per fact/source pair. It runs before stage replay checks. Limits are 32 facts and eight sources per fact; historical timing and mutation claims were not remeasured. |
| Suppression filters projection reads but does not scrub or reject every stored copy. | [context-retriever.ts](apps/cloud-gateway/src/conversation/context-retriever.ts) checks all cited source suppressions. [0014](apps/cloud-gateway/src/persistence/migrations/0014_memory_projection.sql) forbids updates and protects the published version, but a later publication prunes older versions; “never deleted” was too broad. Forget does not itself rebuild that projection, and [memory-projection.ts](apps/cloud-gateway/src/sync/memory-projection.ts) does not consult suppression on writes. The Windows agent can publish through signed sync; it is not an unprovisioned Linux-only client. |
| The 2026-09-24 23:30 UTC memory backup failed, and its owner notice is hard-coded. | Sid-reported: the run failed with `memory_consolidation_provider_output_invalid` (raised in [living-notes.ts](apps/cloud-gateway/src/memory/living-notes.ts) when consolidation output fails validation); the cause of that invalid output is not yet found. The notice he received, "Last night's memory backup didn't complete; Jarvis will retry tonight.", is the fixed string `MEMORY_BACKUP_NOTICE` in [memory-backup.ts](apps/cloud-gateway/src/backup/memory-backup.ts): code speaking for Jarvis. It belongs on the [#186](https://github.com/stremysid/jarvis/issues/186) removal list. |
| Tool receipts can reintroduce hidden text. | [owner-agent-core.ts](apps/cloud-gateway/src/agent/owner-agent-core.ts) combines control receipts with text read before the control in forget/restore and uses separately read text for explain. This can defeat the text suppression applied by [memory-owner-controls.ts](apps/cloud-gateway/src/memory/memory-owner-controls.ts). Returning a “withheld” receipt alone is not a guarantee. |

## University tracking

Evidence for these limits is in [university-tracker-model.ts](apps/cloud-gateway/src/university/university-tracker-model.ts),
[university-tracker-repository.ts](apps/cloud-gateway/src/university/university-tracker-repository.ts),
[university-tracker-receipt.ts](apps/cloud-gateway/src/university/university-tracker-receipt.ts)
and [school-catchup-model.ts](apps/cloud-gateway/src/school/school-catchup-model.ts).

- Ingress now identifies forwarded/external text and blocks pipeline mutation
  through `directPipelineText` ([telegram-types.ts](apps/cloud-gateway/src/channels/telegram/telegram-types.ts),
  [index.ts](apps/cloud-gateway/src/index.ts)). It still cannot identify an
  unattributed verbatim paste as somebody else's words. Quote handling is not
  a complete persisted provenance contract.
- Offer status requires the whole-message sentence recognized by
  `supportsOfferStatusEvidence`, naming a tracked university and program.
  Natural variants can save nothing and receive a fixed explanation.
- Save turns use deterministic receipts instead of the model's follow-up.
  No-save/no-offer replies still use the finite `guardSchoolReply` rules;
  they are not a general proof that arbitrary external-action claims are absent.
- Checklist submission evidence still uses the older reported-speech/hedge
  rules; workflow steps use stricter `stepEvidenceRefused` and
  `OWNER_HEDGE`. The checklist's trailing-hedge and unrecognized-reporter
  gaps are not fixed merely because the workflow refuses them.
- There is no exact-source monetary field for fees; numeric monetary details
  are refused. External-party completion reports cannot substitute for Sid's
  direct evidence.
- Workflow history caps each identity at 64 revisions without a rollover
  identity. Evidence excerpts are bounded at 512 UTF-8 bytes; long submission
  reports can fail without an explanation of that byte limit.
- Timed workflow deadlines require an exact UTC instant plus timezone.
  Natural-language local-time conversion is not implemented here.
- HTTPS/cycle syntax does not establish an official source or current cycle.
  Older program verification remains less tightly bound than application
  evidence.
- [Digest application rendering](apps/cloud-gateway/src/digest/digest-composer.ts)
  orders dates but omits an explicit overdue label and admission cycle.
- The repository silently skips an already-active response-local duplicate.
  `applyOwnerPlan` returns no per-update receipt result, while presentation
  uses the requested plan, so a receipt need not disclose that skip.

## School and study coach

[STATE](docs/STATE.md) records that the owner's Classroom API route is unavailable,
no usable Brightspace calendar feed exists, and D2L notification emails lack
deadlines. These are recorded owner/environment facts, not production checks
performed by this audit. The [PC D2L brief](docs/briefs-p2-d2l-read.md) is planned
work, not an implemented reader.

| Remaining limit | Evidence and boundary |
|---|---|
| Classroom deadline precision is lost. | [classroom-client.ts](apps/cloud-gateway/src/deadlines/classroom-client.ts) treats timed due dates as UTC and date-only values as local end-of-day; the [deadline schema](apps/cloud-gateway/src/persistence/migrations/0011_deadlines.sql) stores only an instant. No teacher-UI comparison is established here, and the unavailable route is not an owner consent task to repeat. |
| Grade/submission coverage is narrower than all coursework. | [classroom-observation-sync.ts](apps/cloud-gateway/src/school/classroom-observation-sync.ts) and [school-observation-repository.ts](apps/cloud-gateway/src/school/school-observation-repository.ts) use verified deadline identities, omit undated coursework, and reject a replacement submission id. The digest path does not implement a same-day grade/missing-work alert. No real Classroom grant is presumed. The D2L email handler exists, but is not a grades/submission connector. |
| Deadline closure is not submission evidence and cannot automatically reopen. | [brightspace-ical-client.ts](apps/cloud-gateway/src/deadlines/brightspace-ical-client.ts) maps completed/cancelled feed items to cancellation. [deadline-repository.ts](apps/cloud-gateway/src/deadlines/deadline-repository.ts) preserves status on unchanged/revised content; absence is not cancellation. Passed dates stay open; [0027 observations](apps/cloud-gateway/src/persistence/migrations/0027_school_observations.sql) are separate from that status. |
| Calendar interpretation and first-load lifetime remain unaccepted. | [brightspace-ical-client.ts](apps/cloud-gateway/src/deadlines/brightspace-ical-client.ts) ingests dated events/tasks without a verified due-versus-availability discriminator. The on-demand refresh in [school-catchup-model.ts](apps/cloud-gateway/src/school/school-catchup-model.ts) runs in the reply path with bounded work, not a durable queue. No production lifetime proof or usable feed is established. |
| Study evidence is a separate store. | [study-coach-repository.ts](apps/cloud-gateway/src/school/study-coach-repository.ts) has its own records and controls. General memory controls are now composed into Telegram, but do not automatically forget these study tables. |
| Check-ins are spent before confirmed delivery. | The study repository advances `last_prompted_on` during digest construction via [job-table.ts](apps/cloud-gateway/src/jobs/job-table.ts). A failed send or manual digest can spend the candidate before the scheduled message is delivered. |
| Study retirement/forget is one-way in the operational view. | The study repository supersedes evidence after 30 days or at caps. [study-coach-model.ts](apps/cloud-gateway/src/school/study-coach-model.ts) recognizes a narrow weak-spot/weak-area forget grammar. No undo returns those points to the active view. |

## Voice and delivery

| Remaining limit | Evidence and boundary |
|---|---|
| Guest calls on deployed main receive owner-only prompt material. | Before #174 deploys, `OwnerAgentCore.streamCaptured` reads Sid's pinned core profile and supplies the owner call prompt and full owner tool catalogue even when the active call principal is a guest. #174 gates all three on exact owner-principal equality and adds a guest-prompt regression test. This remains live on main until that reviewed change deploys. |
| #174 deliberately gives authenticated guests zero model tools. | This is a safer interim, not the final guest-capability design. The approved design permits a grant-filtered guest catalogue such as `research.web` and `memory.own`, but the owner catalogue is not a scoped guest catalogue. Until those guest-specific adapters enforce each grant and resource scope, #174 supplies no tools and `toolChoice: "none"`. |
| Guest-grant notices can repeat after a crash. | [guest-grant-notice.ts](apps/cloud-gateway/src/voice/guest-grant-notice.ts) sends before marking delivered; [telegram-provider.ts](apps/cloud-gateway/src/providers/telegram-provider.ts) does not transmit its internal idempotency key to the API. In-memory overlap protection cannot make those effects atomic with D1. The owner-rejection delivery this row also named was removed with the per-call passphrase gate on 2026-09-24. |
| Permanently failing guest notices remain pending. | [guest-grant-notice-drain.ts](apps/cloud-gateway/src/jobs/guest-grant-notice-drain.ts) fairly rotates the queue, fixing oldest-ten starvation. There is no 24-hour-undelivered line in [digest-composer.ts](apps/cloud-gateway/src/digest/digest-composer.ts). |
| Toward readers who are not Sid (guest calls, audit/callback telemetry) only: generic redaction has syntactic limits; spoken PINs need a supported label, delimiter and at least three digit words. | Round 2 of #183 supersedes the [round-1 evidence](docs/reviews/2026-09-24-redaction-gaps.md). The [shared fixtures](tests/fixtures/redaction-gaps.json) pin exact output and Python refusal decisions. `pin`, `passcode` and `code` accept prose `is`, `was`, `'s` or `’s`, optionally after `number`, only before a digit run with a word boundary or three or more consecutive English digit words separated by spaces/hyphens. The whole spoken run is redacted; one/two words, unlabelled PINs and other spoken formats remain outside this rule. Bare four-digit numbers and tested ordinary prose, identifiers, dates and times survive, including `pin is on` and `Code: MHF4U`. Generic labels still accept explicit `:`/`=` assignments; `code` accepts digits only. This is syntax, not semantic disambiguation. Unlabelled passphrases remain uncovered; unquoted `passphrase is` values end at sentence/list punctuation or a line break, while quotes cover interior punctuation. Telegram retains potential credential context through EOF, which can delay its suffix; voice keeps sentence release. This branch has not been deployed. Note: the call PIN gate does **not** rely on this rule. Its utterance is consumed before it can be stored, so this row is about other channels' prose, not about the PIN. |
| Toward readers who are not Sid only: an unquoted multiword password after an explicit colon still leaks its tail. Toward Sid it is his own text and is not redacted at all (`codex/no-redaction-toward-sid`). | The synthetic fixture `password: correct horse battery` becomes `[REDACTED_CREDENTIAL] horse battery`; Python refuses the whole fact because a redaction would occur. Only the first unquoted token is consumed. Quoted password assignments cover multiple words. `my password is correct horse battery` now stays unchanged because `password is` is not a supported prose delimiter. Round 2 deliberately does not widen the password rule; this is a remaining limit next to the spoken-PIN limits above. |
| Some concurrent guest operations can fail closed rather than replay cleanly. | `bind`/`begin` in the removed owner step-up service performed reads before guarded inserts. The owner-call step-up limits that stood here — attempt/verifier timestamp and failure limits, fragment-assembly serialization, retained per-session evidence — were removed with the per-call passphrase gate on 2026-09-24. The new PIN gate's own limits are named in [sensitive-action-pin.ts](apps/cloud-gateway/src/voice/sensitive-action-pin.ts) and proven by the mutation-verified tests listed in PR #196. |
| The outbound slot reservation recognizes exactly two inbound owner pre-auth sessions. | [call-repository.ts](apps/cloud-gateway/src/persistence/call-repository.ts) uses `AND 2 = (SELECT COUNT(*) ... phase = 'pre_auth')` in admission SQL, not a migration trigger as the old entry said. An inconsistent/future state with more than two rows would not match that reservation condition. |
| Live release acceptance is incomplete. | [STATE](docs/STATE.md) retains the 2026-09-21 observation of six inbound owner calls, no outbound call and no completed release gate. The owner step-up implementation `8120d44` was removed from the call path on 2026-09-24 with the per-call passphrase gate; the smoke evidence contract is now schema `1.4` and requires an owner call to reach its first model turn with zero authentication prompts. D1 is at `0039`. Answering-machine behavior and attended smoke remain unverified. |
| Retained voice evidence is narrower than all effects/attempts. | The per-session owner refusal/end receipts this row named were removed with the step-up gate. [Voice smoke code](tests/acceptance/live) now requires five scenarios; its passing-evidence store is not a complete failed-attempt ledger, and the call PIN gate's own ledger (migration `0047`) is not part of that evidence set. |
| Owner-phone begin is an authenticated response oracle. | [owner-phone enrollment](apps/cloud-gateway/src/sync/owner-phone-enrollment.ts) distinguishes active/pending/conflict for supplied numbers; it is device-authorized, not an anonymous oracle. Request salting does not remove response distinguishability. |
| Evidence-store guards overlap. | [Voice smoke files](tests/acceptance/live) check directory/symlink metadata and hash before and after publication. Overlapping checks mean refusal coverage is not proof that each redundant branch has an independently killing mutation. Historical Windows observations were not rerun here. |
| Terminal cleanup retries are bounded. | [twilio-provider.ts](apps/cloud-gateway/src/providers/twilio-provider.ts) and voice TwiML use a retry fragment; a finite callback retry policy cannot establish cleanup after an arbitrary outage. Production callback delivery still requires the [attended runbook](docs/runbooks/voice-smoke.md). |

## Watchdog and operational boundaries

| Remaining limit | Evidence and boundary |
|---|---|
| No external watchdog is recorded. | [STATE's plumbing verdict](docs/STATE.md#where-the-project-actually-stands) says **“No external watchdog”**. [health.ts](apps/watchdog/src/health.ts) needs an outside poller to notice total cron failure. This is the recorded state, not a fresh production query. |
| A configured alert channel may still fail delivery. | `buildHealthReport` checks configuration presence and cycle freshness, not successful Telegram delivery. [alert-channel.ts](apps/watchdog/src/alert-channel.ts) is a separate send path. |
| The heartbeat secret authorizes every component name. | [heartbeat.ts](apps/watchdog/src/heartbeat.ts) validates a shared secret; there is no per-component credential mapping. |
| Startup can alert for a never-reported required component. | [liveness-check.ts](apps/watchdog/src/liveness-check.ts) treats missing required components as down. [index.ts](apps/watchdog/src/index.ts) defaults the required list to the gateway and refuses an explicitly empty list. These are current semantics, not evidence the gateway is still failing to heartbeat. |
| Duplicated watchdog test contracts can drift. | [liveness-schema.ts](apps/watchdog/test/liveness-schema.ts) and [heartbeat.test.ts](apps/watchdog/test/heartbeat.test.ts) are transcribed independently. No gateway import couples them; no automatic cross-package parity guarantee is established. |
| Rate limiter and circuit breaker are per isolate. | `telegramLimiter` and `providerCircuitBreaker` are module-level instances in [index.ts](apps/cloud-gateway/src/index.ts). They do not aggregate across isolates. |
| Status times are unlabeled UTC slices. | [command-handler.ts](apps/cloud-gateway/src/channels/telegram/command-handler.ts) renders job timestamps with `.slice(11, 16)`, not the digest's resolved timezone. |
| R2 bucket-lock protection is unverified. | [memory-backup.ts](apps/cloud-gateway/src/backup/memory-backup.ts) verifies backups and orders retention, but no repository code proves an owner-enabled bucket lock. The old inventory recorded it as not enabled; this audit did not inspect R2. Application guards do not establish storage-level retention. |

## Windows pipe and vault

No Windows ACL, permission, service or boot-chain test was executed in this
audit. Existing test definitions below are not fresh acceptance evidence.

| Remaining limit | Evidence and boundary |
|---|---|
| Named-pipe second-user denial has no acceptance evidence here. | [pipe_server.py](apps/local-agent/jarvis_local/transport/pipe_server.py) builds an explicit descriptor; [transport tests](apps/local-agent/tests/transport) include descriptor and anonymous-access checks. Those are existing test definitions, not fresh observed passes or proof for a second logged-in user. |
| Vault observations lack a redaction pass. | [models.py](apps/local-agent/jarvis_local/vault/models.py) defaults redaction to none; [reconciliation.py](apps/local-agent/jarvis_local/vault/reconciliation.py) records note text. There is a general sync client, but the vault CLI does not upload these observations. Any future vault upload needs redaction first; path-safe labels are not necessarily redacted. |
| Vault create-new writes are not fenced. | [projection.py](apps/local-agent/jarvis_local/vault/projection.py) uses `O_EXCL` and content-hash recovery, without retained directory handles or a no-delete-sharing fence. [reconciliation.py](apps/local-agent/jarvis_local/vault/reconciliation.py) brackets reads with stats. A path swap or a writer preserving compared metadata remains outside the guarantee; no future Rust bridge is promised as built or inevitable. |
| Vault sync has no incremental cursor or USN journal. | Reconciliation walks from the start and caps a slice at 64 examined documents. Unchanged documents count, so later notes may never be reached. [setup.py](apps/local-agent/jarvis_local/vault/setup.py) uses stat identity; detection of a changed root is not prevention. Renames are treated as disappearance plus a new path. |
| Vault projection has no composed authority gate. | `VaultProjector.project` in [projection.py](apps/local-agent/jarvis_local/vault/projection.py) is not called by the production CLI and accepts a projection request without a verified export/capture decision. Wiring it directly would omit that authorization step. |
| Filesystem/cloud-sync detection is incomplete. | [setup.py](apps/local-agent/jarvis_local/vault/setup.py) uses a Windows volume probe and heuristic names/markers/environment checks for sync roots. It does not establish a Cloud Files placeholder or held-handle reparse guarantee. |
| Published notes can return as user-authored observations. | Reconciliation uses the default origin in [models.py](apps/local-agent/jarvis_local/vault/models.py) without consulting projection receipts. The schema's receipt requirement for explicitly labeled projections does not fix that attribution. |
