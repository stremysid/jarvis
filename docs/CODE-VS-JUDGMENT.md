# Code versus judgment — the decisions currently written in code

The roadmap's core rule, the one this file exists to make workable:

> **Code builds tools. Jarvis makes every decision.**

The test, in one question: **am I writing code that decides, or code that enables?**

An `if` that makes a judgment call — how many results, what counts as relevant, whether to
act at all — is a decision, and decisions belong in a tool description or the system prompt.
Code has exactly four jobs and no others: **hands** (tools), **senses** (wake-ups and
provenance), **memory** (storage), **proof** (receipts and enforced taps). Everything else is
judgment, and judgment is Jarvis's.

A decision written in code is not a style problem. It is a piece of Jarvis's brain expressed
in the wrong language, and it is invisible to Jarvis, so Jarvis cannot reason about it,
report it, or be corrected about it.

**This page is a removal list, not a list of accepted exceptions** (Sid, 2026-09-25: "any
judgment and decisions and thought should be the ai brain"). Code never decides meaning,
relevance, how many, which, how long, or whether to act; the model does, through tool
arguments and its prompt, and asks Sid when unsure. Code may keep only permissions (guest
isolation, Sid's five confirmed actions), validation that an id exists and is Sid's, and
system-protection limits (sizes, timeouts, runaway caps), each named as such.

- **A pull request that adds a code-side judgment does not merge.** It is a blocking review
  finding. Adding a row here is not a substitute for removing it.
- **A judgment found in existing code** is removed in that pull request if it is small;
  otherwise it gets a row here **and** a removal item in [QUEUE](QUEUE.md), in the same PR.

**Every current row is queued for removal** in [QUEUE](QUEUE.md#work-with-no-pull-request-yet),
in three batches: voice (rows 1, 3, 4, 5), memory (rows 6–9 and 13) and school (rows 10–12,
plus the two school collector rows at the end of this file). Two DeepSeek builders started
the memory and school batches on 2026-09-25. **Row 2 is a permission, not a judgment**: the
tier gate on placing a call stays; what is missing is a `call_place` hand.

---

## Read this before treating the list as the population

**This is a partial set found by a real method, not the population of violations.**

The list came from a full-coverage audit that was killed mid-run. It completed **two of about
seven planned batches**:

| Batch | Area | Status |
|---|---|---|
| W1 | `memory` + `persistence` | **complete** |
| W2 | `voice` + `channels` + `conversation` + `autonomy` + `security` + `sync` + `http` | **complete** |
| W3 | `school`/`university`/`jobs`/`archive`/`backup`/`model`/`providers`/`index` | **never ran** |
| W4 | `local-agent`, `contracts`, `scripts`, watchdog, hermes | **never ran** |

So: the whole Python local agent, the contracts package, `scripts/`, and the watchdog have
**never been looked at for this class**. There are more. **Do not read "nine" as "nine
exist", and do not treat a tenth as the first new one — it is the tenth *found*.**

A source list from that audit survives at `C:\w\audit\SALVAGED\` and a backup at
`C:\w\p5b-salvage\`, both scratch paths outside the repository. It is a candidate set, not
authority. Every entry below was re-verified against the code by the session that wrote this
file, and the citations were corrected where the audit's had moved.

---

## Owner memory judgments: removed, 2026-09-25 (rows 6–9, 13)

Removed by the PR titled "Memory: the AI decides, not code (register rows 6-9, 13)"
(branch `codex/memory-judgment-to-ai`). Sid, 2026-09-25: "any judgment and decisions and
thought should be the ai brain remember". These rows had each written a memory decision in
code that the model could neither see nor correct. The table gives the symbol as it was and
what replaced it; the full diff is in the PR.

| Symbol (as of `e2af1aa2`) | What it decided | Now |
|---|---|---|
| `captureInput`'s `input.lifetime === undefined ? …` (`memory-repository.ts`), `memory_remember`'s optional lifetime pair, and the copies in `owner-agent-core.ts` and `MemoryOwnerControlsService.remember` | How long a fact lasts, when the caller said nothing. The tool description even invited the omission: *"Leave it out and the fact is durable."* The register said the same default lived in `owner-telegram-agent.ts`; that citation was stale — the third live copy was the tool dispatch in `owner-agent-core.ts`, and `telegram-memory-controls.ts` (a deterministic, test-only adapter) was a fourth | **Removed.** `lifetime` and `expiresAt` are required in `CommitInitialMemoryInput`, in `memory_remember` and `memory_correct`, and in `RememberMemoryInput`/`CorrectMemoryInput`; every defaulting branch is deleted, so an omission is refused rather than assumed. `memory_correct` no longer inherits the replaced wording's end in code — the model states the replacement's lifetime and end, and the tool description tells it to pass the old pair when only the wording changed |
| `MemoryRepository.liftItem`'s `restoredBasis` | Whether a restored memory's evidence counted as confirmed. It set `confirmed` by itself whenever the version's origin was `authenticated_first_person` and every source was archive-only — a silent basis change with no receipt, invisible to the model | **Removed, with one written blocker.** `LiftMemoryItemInput.basis` is required and `memory_restore` carries a required `basis` enum, so the model decides what the restored evidence counts as. Code keeps only the coupling checks, so a basis the ledger would reject is refused by name. **Blocker:** a `0016` transition trigger still requires `confirmed` when a first-person version's every source is archive-only, because restoring text whose original live turn is gone is the owner's confirmation of it. A different basis for that case is now refused by name (not silently rewritten), but handing that case fully to the model needs a migration to relax the trigger; the tool description tells the model to pass `confirmed` there. No migration was added in this PR |
| `MemoryRepository.findActiveItemByNormalizedText` / `normalizedRememberText` | Whether two statements were the same memory. It normalised both, compared strings, and on a match **silently merged** the new wording into the old item as an extra source — the stored wording never changed, the receipt implied Sid's new words were recorded, and the model never saw the item it was folded into | **Replaced by a hint.** The method is now `findSimilarActiveItems`, which returns up to three candidates and writes nothing. `remember` always stores the new statement as its own memory and appends a receipt line naming the similar stored wording and its id, telling the model to call `memory_correct` if the new statement replaces one. The string normalisation is unchanged; it is mechanical comparison, not a duplicate decision |
| `MemoryRepository.refileAutomaticInboxItems`'s duplicated confidence floors | The register listed the `>= 0.6` floor as hard-coded four times. Two of those copies were the retry queries inside this method, where every retryable reason (`inbox_cap`, `inbox_filing_failure`) can only have been written by a filing that already passed the floor, so re-checking it re-decided a settled question | **Partly removed, and the remainder is named rather than hidden.** The two redundant floors are deleted, and the one floor that remains (a model-proposed topic path is filed only at or above the model's own confidence) is exported once as `MEMORY_FILING_CONFIDENCE_THRESHOLD` and used by both `memory-repository.ts` and `automatic-distillation.ts`. **Not removed:** which inbox items are retried, how many (10), and in what order. Handing those to the model needs a wake-up that tells Jarvis "N inbox items have unresolved topic decisions" and a refile tool; no such model-facing wake-up exists in this codebase, and adding one is a new surface rather than a removal. The batch size and the rotation are also the Worker/D1 throughput bound. This is a written blocker, not a claim the row is closed |
| `OwnerAgentCore.forget`'s `itemIds.length !== 1` branch (`owner-agent-core.ts`) | Whether to act at all when Sid asked to forget several memories. It raised a `telegram-memory-forget` decision — "Nothing changes unless Sid taps Confirm forget" — and forgot nothing, because `commandKey` allowed one ledger mutation per owner turn | **Removed.** The tap is gone: one `memory_forget` call forgets every id it was given. Each target now has its own idempotency key, `<turn event>:forget:<itemId>`, its own command and its own receipt, and every target is validated before any command is written, so a batch naming a bad id changes nothing. `supportingExcerpt` is now required, matching single-target forget, so the model must quote Sid's words. `MemoryOwnerControlsService.forgetConfirmedDecision` is **kept**, not deleted: it resolves a `telegram-memory-forget` decision already in the queue, and no longer raising new ones is a separate cleanup |

Rows 6–9 and 13 have left the list below.

## Owner deadline proof contract: removed

Removed by the PR titled "fix(deadlines): let the AI decide deadlines; remove the code
proof grammar and status keyword list" (branch `codex/deadline-judgment-removal`). Sid,
2026-09-24: "code should never make a decision or restrict jarvis". This section used to
record these rows as reviewed exceptions. That was wrong: they were code judging Sid's
wording, and writing them down did not make them right.

| Symbol (as of `a7cd355`) | What it decided | Now |
|---|---|---|
| `proveDeadlineDue` / `DUE_PHRASE` / `resolveDate` (`deadline-date-proof.ts`) | A date and clock grammar that refused due phrases it could not parse, refused "next Friday" and a same-day weekday as ambiguous, rolled missing years forward, refused passed clocks, and prepared a small-hours rule | File deleted. The model supplies `dueAt` as an ISO instant or a `YYYY-MM-DD` date and asks Sid when unsure. Code checks only that the date or instant is real and the zone is a real IANA zone |
| `statusOf` / `STATUS_WORDS` (`deadline-tool.ts`) | Only "submitted", "handed in" or "turned in" in Sid's words counted as a submission; "finished" did not | Deleted. `status` is one of the four stored values, chosen by the model |
| Course/title/due ordering and gap checks (`assignmentGapBreaksTie`, `evidenceExcerpt`, `dueExcerpt`) | Course, title and due phrase had to be copied verbatim, in order, with no sentence break or other date in between | Deleted, along with both excerpt arguments. Sid's raw message stays in the durable owner turn the core re-reads before the tool runs |
| `matchingDeadline` uncertain-prefix refusal | "Chem" beside a stored "Chemistry" refused the save | Now a hint: the save goes ahead and the receipt names the similar stored rows for the model to raise with Sid. Exact normalised course/title still updates one row; two stored rows that already share one identity still refuse, since there is no single row to update |

## Project attention judgment: removed (batch 13, 2026-09-25)

Removed by the PR titled "Projects: the AI decides what needs attention, not code"
([#209](https://github.com/stremysid/jarvis/pull/209), branch `codex/projects-judgment-to-ai`,
2026-09-25). The stalled-project detector
was eleven decisions about when a project was late; each is now a fact the model
reads and judges. No migration: the `stale_after_days` column and its `DEFAULT 7`
are left inert rather than rebuilt.

| Item | Symbol (as of `679d2b95`) | What it decided | Now |
|---|---|---|---|
| B153, B155 | `attentionChanges` / `ATTENTION_DOCUMENT_PATHS` (`project-poller.ts`, `project-types.ts`) | That only a change to `KNOWN_ISSUES.md` or `DECISIONS.md` was worth pinging about. | Deleted. `diffDocuments` already reports every document change; which one matters is the model's judgment. |
| B157 | `DEFAULT_APPROACHING_WITHIN_DAYS` (`stalled-detector.ts`) | That a deadline within 14 days counted as approaching. | Deleted with the module. There is no horizon constant anywhere. |
| B161 | `DeadlineReading.nearest` | That the earliest parsed date is the commitment that matters. | Deleted. `readProjectDates` returns every ISO day it reads, in the order the document wrote them. |
| B162 | `readDeadlines` sort and slice | Sorted the days and kept the first ten. | Deleted. The days are deduplicated (identical strings only) and left in document order; the 4096-character excerpt bound already bounds the list. |
| B163 | `DeadlineReading.approaching` / `overdue` and `deadlineInstant` | Compared a parsed day against "now" to label it approaching or overdue. | Deleted. The model compares the days with the commit age and decides. |
| B164 | `report.stale` (`daysSinceLastCommit > status.project.staleAfterDays`) | Whether the gap since the last commit made a project stale. | Deleted. `projectFacts` reports `daysSinceLastCommit` as arithmetic and no verdict. |
| B165 | `ProjectStalenessReport.escalate` | Whether a project should be raised to Sid. | Deleted. `project_facts` hands the model the excerpts, commit ages, dates and poll health, and its description tells it to decide. |
| B166 | `detectStalledProjects` filtering on `escalate` | Which projects reached the owner and which were dropped. | Deleted with the module. `projectFacts` returns one entry per project; the digest states the facts and attaches no verdict. |
| B170 | `stale_after_days INTEGER NOT NULL DEFAULT 7` (`0010_projects.sql:22`) | A stored staleness threshold. | Left inert. The column and default stay because dropping them would need a table rebuild; no code reads them for a verdict, and `ProjectRepository.trackProject` still supplies the value, so nothing in the schema changed. |

`projects/stalled-detector.ts` is renamed `projects/project-facts.ts`, because a
detector that no longer detects is a misleading name. The new `project_facts` tool
is a tier-1 read under the already-seeded `read.repository` capability.

## Effort, lead time and the deadline warning schedule: removed

Removed by the PR titled "Deadlines: the AI decides when to warn Sid"
(branch `codex/effort-by-ai`). Sid, 2026-09-25, 6:00 PM: "or hear me out, you
let ai DECIDE".

The first round deleted the title keyword table. This round removed the rest of
the machinery: `effort`, `lead_minutes`, `effort_judged`,
`DEFAULT_LEAD_MINUTES`, `leadMinutesForWrite`, the `deadline_judge` tool and the
effort-derived exam quiet window are all gone. Code stores what a source states
-- title, course, due date or none, source, status -- and delivers what the
model schedules. The model decides whether and when Sid is warned through the
owner reminder tools, and a scheduled review pass shows it collected deadlines
so nothing waits for Sid to ask.

| Symbol (as of `f43fcf42`) | What it decided | Now |
|---|---|---|
| `classifyEffort` / `EFFORT_KEYWORDS` / `titleTokens` | Whether a deadline was a quiz, test, exam, essay or project, from words in its title | Deleted. Nothing stores or infers an effort category |
| `DeadlineIngestionOptions.courseEffort` | A caller's per-course rules imposing an effort | Deleted. It had no production caller, no store and no tool |
| `DEFAULT_LEAD_MINUTES` / `leadMinutesForWrite` / `lead_minutes` | How long before a due time Sid is warned | Deleted. The model chooses warning times through `reminder_schedule`, and reads `reminder_list` to avoid duplicates |
| `effort_judged` and the re-judgment marker | Which rows still needed a model judgment | Deleted. There is no category left to judge |
| `QuietWindowService.deriveExamWindows` / `EXAM_WINDOW_*` | A window that held messages around an `exam`-tagged deadline | Deleted from the service. Quiet windows remain only when created directly through `/quiet` |

### What still decides, and what was left outside this PR

- **Legacy placeholder columns.** `0011` declares `deadlines.due_at`, `effort`
  and `lead_minutes` NOT NULL. Relaxing or dropping them needs a table rebuild,
  and triggers created in `0027` reference `deadlines`, so a `DROP TABLE` fails
  in the full migration order (measured in `collector-migration`).
  `0053_deadlines_store_facts.sql` therefore adds the real nullable `due_date`
  column, and the writer fills the legacy columns with placeholders
  (`effort = 'other'`, `lead_minutes = 0`, `due_at = ''`). Nothing reads them.
  Removing them is a QUEUE item.
- **Missing-due-date derivations outside this PR's area** (named, not changed):
  `SchoolObservationRepository.deriveMissingWorkPage` in
  `school-observation-repository.ts` still chooses `closed`, `submission_seen`,
  `not_due` or `no_submission_seen` from deadline status and dates, and the
  triggers in `0027_school_observations.sql` still compare
  `deadlines.due_at` (now the placeholder) with `basis_due_at`. The collector's
  `staleAfterMs` default and the empty-sweep flag are also code judgments.
  They are follow-ups, listed here rather than silently kept.

## Owner-requested redaction grammar, 2026-09-24

`sanitizeRedaction` and Python's `redaction_would_change` classify credential
assignments, bearer pairs and specified phone shapes under Sid's explicit
`codex/redaction-gaps` brief. Bare four-digit values remain ordinary text.
This is an owner-requested privacy boundary rather than a model relevance rule.
Its remaining judgment is syntactic: `pin is on` treats `on` as a value, and
`code is` cannot distinguish a credential from an ordinary identifier.
That ambiguity is now a [known limit](../KNOWN_ISSUES.md), with exact fixtures;
semantic disambiguation would need a separately agreed policy surface rather
than an undisclosed list of prose exceptions. Streaming retention only holds
potentially unfinished credential context within the existing size limits.
This register remains partial; this change is not a fresh audit of other rules.

**Scope narrowed, 2026-09-24 (`codex/no-redaction-toward-sid`).** Sid: "there
should be nothing between Jarvis and I interms of what he knows and I know".
The grammar above now runs only for a reader who is not Sid (`RedactionAudience`
`external`: guest call sessions, policy audit, provider callback telemetry).
Toward Sid the boundary is not a word list at all: it asks who receives the
text, and removes only machine-credential shapes (Jarvis's infrastructure
secrets). A separate reply grader remains and is not removed here:
`SECRET_REQUESTS`/`SECRET_REPLACEMENT` in `school/school-catchup-model.ts` rewrites
a school reply that asks Sid for a password or MFA code into "I can't accept
passwords...". It judges the model's wording and contradicts "Jarvis can say
email codes and store them"; it is listed here for a follow-up.

## The list

Severity is a label for ordering, not a priority ruling. `violation` = code holds a decision
the roadmap gives to Jarvis. `silent` = the same, made worse because nothing tells Jarvis or
Sid that the decision happened.

### Voice

| # | Symbol | The decision code is making | Surface it should move to |
|---|---|---|---|
| 1 | `CallSessionCore.#guardOwnerRepeat` (`src/voice/call-session-do.ts`) | Which of the owner's spoken words Jarvis is allowed to hear. For 2 s after the passphrase match it drops **any** owner utterance outright, without consulting the text; for 1.5 s after that it swallows an utterance built from 1–2 passphrase-list words. No reply, no transcript row. | A prompt statement that a repeated passphrase will not arrive, so Jarvis's judgment is informed rather than bypassed — plus a spoken neutral line whenever anything is dropped, so silence is never unexplained. **`silent` penalty: it is invisible to the model.** |
| 2 | `dispatchOutboundCall` (`src/voice/outbound.ts`) | Whether a call may be placed, by whom. `OutboundCallCommand.issuedBy` is `"telegram_call_command" \| "local_cli"` (`packages/contracts/src/calls.ts`) and `PolicyEngine.hasTrustedOrigin` admits only those, so **Jarvis can never place a call**: every outbound call needs Sid to type `/call <reason> --confirm`. | A `call_place(reason)` tool, with a Jarvis-side origin provider minting `issuedBy: "model"`. This is a hand that doesn't exist, plus a provenance value — not a removal of the tier gate, which stays. |
| 3 | `parseOwnerAccessIntent` (`src/voice/owner-access-intent.ts`) | What an access instruction **means**: a hand-written regex grammar with four fixed shapes decides whether the owner's utterance is an access command and which operation, target and permissions it names. | Jarvis calls the owner-access operations as tools, passing capability phrases as parameters. Code keeps the validation and the confirm step. If the grammar stays as a stopgap, an utterance that looks like a command and fails to parse must produce a spoken refusal — never fall through to ordinary conversation, where the model can answer as if it complied. **`silent` penalty.** |
| 4 | `PERMISSION_CAPABILITIES` / `OwnerAccessService.#snapshot` (`src/voice/owner-access-service.ts`) | Which capability the owner's words name. A frozen table maps 17 phrases to 16 capabilities, and production installs only `conversation.basic` and `access.manage`, so **only "conversation" resolves** — the other 14 throw `capability_not_installed`, `access.manage` throws `capability_not_grantable`, and the `catch` at `#snapshot` collapses all of it into one `owner_access_permission_invalid` the owner never hears. | Give the model the capability ids as a tool parameter and let it map the owner's words; keep the table only as a validation set for what the model returns. At minimum drop `access management` (it can never succeed) and make refusal a spoken outcome. |
| 5 | `PreparedOwnerAccessProposal.expiresAt` (`src/voice/owner-access-service.ts`) | How long the owner's pending decision lives: a hard-coded 60 s. Confirming takes three relay round trips through Deepgram transcription, so a slow confirmation loses the change **and** the call. | Either drop the wall-clock expiry — the call lifecycle is the natural bound and needs no invented timer — or tell the owner the window in the prompt. "How long a fact lasts" is named as Jarvis's call in the roadmap. |

Also in this file, and **the same class**: `CallSessionCore.#handlePrompt` has a further set of
branches that drop an owner's utterance with no reply and no transcript row, and they predate
item 1. Enumerated while verifying item 1 rather than by the audit:

- `#isFixedStepUpEcho` drops any utterance exactly equal to one of five code-authored
  constants: `OWNER_STEP_UP_PROMPT`, `OWNER_STEP_UP_RETRY_PROMPT`,
  `OWNER_STEP_UP_FORMAT_PROMPT`, `OWNER_STEP_UP_VERIFIED`, `OWNER_STEP_UP_REJECTED`.
- `#ownerStepUpVerificationInFlight` drops any final utterance that arrives while a
  passphrase KDF is running. (One existing test covers this — *"ignores a final arriving during
  KDF work instead of replacing the window alarm"* — but it asserts the alarm, not what the
  owner hears, which is nothing.)
- A non-final frame, a non-`active` phase, and an empty utterance are also dropped silently.

Same fix shape as item 1: tell Jarvis these utterances will not arrive, and speak a neutral
line whenever anything is dropped, so silence is never unexplained.

### Additional voice finding (2026-09-23)

This register remains partial. PR #171's first version made regexes the only
judge of action claims on voice. Calling that an "accepted stopgap" was wrong:
Sid had not accepted it. The independent review required the model to declare each
action sentence outside the spoken prose. The voice marker names its proving
tool and this turn's receipt ids; code strips the marker, redacts the unsplit
prose, and verifies that exact sentence's proof before speech. Unsupported
declarations get a fixed honest line, without a rewrite call.

Regexes remain an omission backstop, as on Telegram. They cannot establish that
an arbitrary untagged sentence is not a claim, or decide whether a declared
paraphrase faithfully describes the receipt. Those judgments remain the model's.
See [the protocol and evidence](voice-streaming.md). Telegram's JSON inventory
and rewrite are unchanged by #171.

### Memory

Rows 6–9 and 13 were removed on 2026-09-25; see the removal table above. What
remains of row 6 — which inbox items the automatic job retries, how many and in
what order — is a written blocker there, not a live judgment row: handing it to
the model needs a wake-up surface this codebase does not have.

| # | Symbol | The decision code is making | Surface it should move to |
|---|---|---|---|

### Reply-reference selection: removed

Row 14, `MAX_REPLY_REFERENCES` / `replyReferences` in `owner-agent-core.ts`, is
deleted by [#200](https://github.com/stremysid/jarvis/pull/200). It kept the 8
most recent memory items a turn had touched, so code chose which memories the
reply was about and which a later "forget that" could reach. The model now
declares them: `declare_memory_references` takes the item ids the reply relied
on, and every tool result names the item ids it touched so the model can name
them. Code checks only that each declared id was shown this turn and that the
list fits the store's bound of 8, refusing rather than trimming; a turn that
declares nothing records nothing, with no recency fallback.

---

### School and university

| # | Symbol | The decision code is making | Surface it should move to |
|---|---|---|---|
| 10 | `SchoolObservationRepository.deriveMissingWorkPage` (`src/school/school-observation-repository.ts`) | Chooses `closed`, `submission_seen`, `not_due` or `no_submission_seen` from deadline status, Classroom submission state and observation time, then persists a missing-work transition without model interpretation. **Partially addressed 2026-09-25 ([#204](https://github.com/stremysid/jarvis/pull/204)):** `readWorkEvidence` and the `school_work_evidence` tool now hand Jarvis the source state, due dates and read coverage, and the tool description says "You decide whether work is missed; code does not." The persisted inference itself is **not removed**: see [the blocker](#row-10-persisted-inference-still-in-code-not-removed). | Expose source state, dates and read coverage through school evidence tools; Jarvis records the interpretation with those references. Retain mechanical timestamps/provenance. This finding from #160 is preserved here even if that design PR closes; no runtime change to the collector. |
| 14 | `OWNER_ACKNOWLEDGEMENT` (`src/school/school-catchup-model.ts`), found in [#204](https://github.com/stremysid/jarvis/pull/204) review | Whether Sid's whole message is an acknowledgement, so the model's tracker changes are thrown away. `/^\s*(?:ok(?:ay)?|thanks?(?:\s+you)?|got\s+it|sounds\s+good|cool|alright|sure|👍)\s*[.!]?\s*$/iu` gates `withoutUnsupportedAcknowledgementMutations` and its combined variant: a "sure" that answers Jarvis's own question discards a real update. Registered rather than removed here because #204 is already a large round; the removal is queued. | Delete the regex and both wrappers. The model already decides whether the message engaged the tracker; the prompt tells it not to save on a bare acknowledgement. If a guard is kept it must be a non-authoritative hint, never a silent discard of the model's plan. |
| 15 | `BRIGHTSPACE_REFRESH_REQUEST` / `isBrightspaceRefreshRequest` (`src/school/school-catchup-model.ts`), found in [#204](https://github.com/stremysid/jarvis/pull/204) review | Whether Sid asked for a D2L refresh, decided by regex before the model runs (`/^\s*(?:jarvis[,\s]+)?…(?:check|refresh|update)\s+(?:my\s+)?(?:d2l|brightspace)…now…$/iu`), used at `streamOwnerTool` and `study-coach-model.ts`. | Give the model a bounded refresh tool and let it decide, as `school_d2l_status` already does for the read. Registered rather than removed here because the refresh is a write-ish ingestion path and needs its own tool plus tests; queued. |

Rows 10 and 11 retain the identifiers used by #160 and #162. The university
intake finding is row 12, avoiding a second row 10 when those branches meet.

### School reply and scope judgments: removed (rows 11 and 12, 2026-09-25)

Removed by the PR titled "School: the AI decides, not code (register rows 10-12)"
([#204](https://github.com/stremysid/jarvis/pull/204), branch `codex/school-judgment-to-ai`,
2026-09-25). Both were code deciding what
Sid's words or the model's sentences meant, which Sid's 2026-09-25 rule —
"any judgment and decisions and thought should be the ai brain remember" —
puts in the model, not here. Neither removal needed a migration.

| # | Symbol (as of `e2af1aa2`) | What it decided | Now |
|---|---|---|---|
| 11 | `isWorkedExplanation` and the `WORKED_*` grammar (`WORKED_OBJECTS`, `WORKED_CLAIM_PREFIX`, `WORKED_CONTINUATION`, `WORKED_DESTINATION`, `WORKED_RECIPIENT`, `WORKED_NAMED_RECIPIENT`, `WORKED_REAL_WORLD_VALUE`, `WORKED_TRANSACTION_OBJECT`, `WORKED_APPLIED_FOR_YOU`) in `src/school/school-catchup-model.ts` | Whether a sentence was a worked explanation, by parsing a verb object and a continuation and vetoing destinations, recipients, times and money. The model's declarations on Telegram (`workedExplanations`) and voice (`[[worked]]`) were ignored. | Deleted. The model declares its worked-explanation sentences: `workedExplanations` is an accepted key of the structured reply (`ParsedReply.workedExplanations`, threaded through `parseOwnerCatchupPlan`, the university combined reply and the study practice JSON), and voice wraps one sentence in `[[worked]]…[[/worked]]`. `unsafeFirstPersonRanges` checks plain membership for the exemption and keeps the omission backstop for an **undeclared** first-person action sentence; `blankDeclaredWorked` gates `FALSE_EXTERNAL_COMPLETIONS` and the passive patterns the same way. A declaration naming text the reply does not contain is refused, so it cannot exempt anything. |
| 12 | `isUniversityExecutionRequest` and its regex engine (`REQUESTED_ACTION`, `REQUEST_PARTY`, `REQUEST_EXTERNAL_OBJECT`, `DECISION_OBJECT`, `TRANSACTION_VERB`, `COMMUNICATION_VERB`, `DECISION_VERB`, `COURTESY_MARKER`, `DIRECTIVE_PREFIX`, `PREPARATION_START`, `SCHOOL_NAMES`) in `src/school/school-catchup-model.ts` | In university and legacy unselected scope, a hand-written grammar decided whether Sid was asking Jarvis to act on an external target, and refused before the model ran. | Deleted. Every request now reaches the model, which decides what Sid means. `OWNER_AGENT_COMMON_PROMPT` states that no tool can email, submit, upload, pay, sign up or contact anyone, so Jarvis says plainly that he cannot and prepares the draft or checklist; the university and school structured prompts already carry the same rule. Nothing is lost in enforcement: the pipeline has no external execution hand — `university_update` and `school_update` only store plans — and the reply guards (`FALSE_EXTERNAL_COMPLETIONS`, the passive patterns) plus the `claimedActions` receipt protocol still bound what may be said. |

Rows 11 and 12 are removed; the identifiers stay in this file so a future
reader can find what decision they carried.

### Row 10 persisted inference: still in code, not removed

`deriveMissingWorkPage` still maps deadline status, Classroom submission state
and observation time to a `school_missing_work_transitions` row that the digest
and study coach read. This PR removed **no** part of that inference; it added the
read half (`readWorkEvidence`, the `school_work_evidence` tool) so Jarvis can
make the call.

It was not removed here, and the reason is concrete:

- The derivation runs inside `runClassroomObservationSync`, a model-less
  scheduled job. There is no model in that loop to hand the decision to. The
  register's own surface ("Jarvis records the interpretation with those
  references") needs a **model-write path**: a tool that persists a transition
  with the observation references the model read.
- Writing that path needs a migration. `0027_school_observations.sql` constrains
  `classification` to `'derived'` and its insert trigger admits only a
  reconciled derived row, so a model-authored interpretation has no admitted
  shape today.
- Deleting the inference without the replacement would silently remove the
  digest's missed-work alerts and the study coach's `derived_missing_work`
  signals — a feature regression, not a removal of a judgment. BUILDING.md's
  stop conditions cover "finishing the item would require starting a different
  one", and a migration-bearing model-write path is that different item.

The evidence tool is the enabler, and it is tested; the write half belongs in a
separate PR that takes its own migration number.

### Fixed school intake decision (`SchoolCatchupModelAdapter.streamOwnerTool`, #164)

`SchoolCatchupModelAdapter.streamOwnerTool` now skips `isUniversityExecutionRequest`
only when `agentSelectedScope` is `school`. An assignment-list line such as
"Email Ms. Patel if you need an extension." previously refused the whole paste.
The school pipeline has storage and planning, but no external execution hands.
The `school_update` description now tells Jarvis when to select that tool;
forwarded-text provenance checks and `guardReplyClaims` remain in place.
**That function and its regex engine were deleted on 2026-09-25
([#204](https://github.com/stremysid/jarvis/pull/204), row 12 above): every scope now reaches
the model, which decides what Sid means.**
Pinned daily capacity, due-date priority and stated weight are prompt guidance,
not a new hard-coded ranking or capacity parser. Existing storage ceilings remain.
The core-profile reference is capped at 8,192 UTF-8 bytes and omitted with a rules
notice if it cannot fit; omission never becomes profile content. These are
transport bounds, not a decision about which capacity the owner should choose.
`schoolPlanReceipt` summarizes only the repository's committed result, retaining
per-course inserted/deduplicated counts while limiting examples to fit Telegram.
Schedule repair notices describe the existing storage ceilings, not new planning policy.
This is a partial register, not a completed audit of school or university code.

### Fixed collector name judgment (PR #170 round 2)

`apps/d2l-extension/collector.js:offering` previously excluded the exact name
`DCE D2L BrightSpace Orientation`. That name-based relevance decision is deleted:
every active accessible course offering is read and Jarvis judges its evidence.
The collector's queue limits are explicitly owner-authorised storage bounds, with
visible eviction counts. This remains a partial register, not a completed audit.

## How to use this list

1. **Every entry is a work item, not a complaint.** The third column is the deliverable: the
   code is only done when the decision lives in a tool description or the system prompt and
   code merely enables it.
2. **Do not fix these by adding a guard.** A guard that suppresses the symptom is a second
   copy of the same decision, which is how several of the duplicate thresholds above came to
   exist. Items 6 and 7 each already have three or four copies of one number.
3. **A new decision in code does not merge.** A reviewer who finds one blocks the pull
   request; recording it here does not clear it. A row here is only for a judgment already
   on main, and it comes with a removal item in [QUEUE](QUEUE.md).
4. **When a row is fixed, move it to a "fixed" section with the commit** rather than deleting
   it. The value of this page is the count of things still deciding.

## How to add a finding, so the next one is usable

State three things and nothing else:

- **The symbol**, so it can be found without a line number.
- **The decision** in one sentence a non-author would understand.
- **The surface it moves to** — a specific tool, a specific prompt statement, or "delete it".

A finding that cannot name the third column is not yet understood. Mark it `unverified`
rather than writing a fix; an asserted mechanism that turns out to be wrong costs more than a
gap does.

## Also in the register, named so it is not dropped

The audit that produced the nine also produced **22 non-violation defects** from the same two
batches. They belong in `KNOWN_ISSUES.md`, not on a principles page. One is confirmed here and
is severe enough that burying it would be a second failure of the kind this project keeps
recording — so it is named, with a pointer, not imported:

**`memory_pin` and `memory_unpin` threw on every call — FIXED in #135, and the reason it hid is
not fixed.** At `ca88bf4`, `findControlTargets` (`src/memory/telegram-memory-retriever.ts`) threw
`telegram_memory_target_invalid` for any operation outside `forget`/`lift`/`confirm`/`explain`/
`correct`, and `"pin"`/`"unpin"` were not in that set — while the very next helper, `targetStates`,
had an explicit pin/unpin branch that the throw made unreachable. Its only production caller
(`telegram-memory-controls.ts`) passed the operation straight through. **Confirmed by reading.**

**#135 corrected the guard** and added `test/memory/control-targets.test.ts`, derived from the
declared union rather than hand-listed, which fails before the fix and passes after. So the defect
itself is closed — **do not carry it as an open item.**

The part worth keeping is *why it survived*: the suite stayed green because three test files
injected a stub in place of `findControlTargets` — `owner-telegram-agent.test.ts` (stubbed at two
call sites), `memory-search.test.ts`, and `owner-telegram-pipelines.integration.test.ts` — each
returning a fixed list without looking at the operation. That is the "`memory_pin` throws on every
call while the whole suite stays green" pattern AGENTS.md already records once, and **the stubs are
still there.** A stub standing in for the code under test is why a dead tool read green, and it is
a general hazard rather than a `memory_pin` one: the same shape can hide the next dead tool.

`QUEUE.md` keeps one follow-up from #135 — the corrected guard is still a hand-kept list, so the
*next* operation added to `TelegramMemoryTargetOperation` will drift the same way.

Last verified against the code: 2026-09-21, at `0611803`. Coverage is partial — see the top
of this file.

## School collector findings, 2026-09-23 (still a partial register)

Receiver compatibility correction, 2026-09-24: `mapSchoolCourse` no longer rejects
storable unknown JSON as a failed school read. It records projection labels and keeps
raw evidence for Jarvis; `200 []` submissions stay unknown. `school_d2l_status` reads
deliberately bypass the tier gate and spend no tap under [Sid's 2026-09-24 decision](https://github.com/stremysid/jarvis/pull/175#issuecomment-5816467523).
The pipeline's direct-text authority still applies because that decision removed the safety
tier, not the authenticated-source boundary. Collector revocation no longer asks: migration
`0051` ([#199](https://github.com/stremysid/jarvis/pull/199)) moved `school.collector.revoke`
to tier 1, because it is not one of Sid's five actions. The two existing judgment findings
below remain open.

Date-disagreement follow-up, 2026-09-24: no rationale for preferring a
`content/myItems` date to the folder `DueDate` was recorded in #175's review, its
agent-log entries or this register. The mapper retains that compatibility projection,
but unequal values now add `ambiguous_assignment_date` to the evidence Jarvis reads;
equal values do not. Folder `Availability.EndDate` is a separately labelled fallback,
and an unfamiliar `Availability` shape is likewise surfaced rather than interpreted.
This register remains partial.

| Symbol | Decision in code | Surface it should move to |
|---|---|---|
| `SchoolCollectorRepository.status` called by the deterministic digest | Twelve hours determines when a whole school read is labelled stale, following the existing school-observation convention | An owner or Jarvis-selected source freshness setting. `school_d2l_status` already requires Jarvis to supply `staleAfterMs`; the digest default remains explicit here |
