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

## Owner deadline proof contract (#166 review rounds 1–7)

| Symbol | Decision or bounded proof rule | Model-visible surface |
|---|---|---|
| `proveDeadlineDue` | Validates the model's proposed instant against one grounded date/clock phrase and the durable current-message timestamp, using `DIGEST_TIMEZONE ?? "America/Toronto"`. An override zone must be named in that phrase. | `deadline_record` describes the grammar and returns a specific refusal reason for one precise clarification. Course, title, effort, whether to act, and the proposed resolution remain model arguments. Receipts always use the owner zone. |
| `resolveDate` | Next weekday and a bare weekday naming today are ambiguous. Both supported dates are returned with `deadline_ambiguous_date`; no candidate is stored by a code convention. Explicit `this` weekday accepts only the next occurrence on or after the message's local date, and no non-explicit relative form may resolve before that date. Other supported forms remain ISO, English month/day or day/month, today/tomorrow, next week optionally with weekday, and ordinal day. | Ask Sid which candidate date he means. The model proposes the resolution; code proves it or refuses. Explicit historical calendar dates remain valid. The retained nearest-occurrence rule for omitted year/ordinal and the unconfirmed bare-next-week upper bound remain **judgment findings**, not owner-approved exceptions; disclosure alone does not cure them. |
| `proveDeadlineDue` relative-date / bare-clock branches | A clock without a date (`3pm`, `at 3pm`, `tonight at 11:59pm`) uses the durable message's local date in the owner zone under the round-2 review contract. Already-passed bare/weekday/today clocks return `deadline_time_already_passed`, never an automatic tomorrow. `OWNER_SMALL_HOURS_END_HOUR` is `null` until Sid supplies the owner-local end hour, so `today` and `tomorrow` mean the current and next calendar dates all day; the prepared adjacent-date refusal can run only inside that future window, including for date-only phrases. Under `tonight`, an a.m. clock, a suffix-less two-digit clock from `00:00` through `12:59`, or a 12 o'clock p.m. clock remains ambiguous independently of any cut-off. | The receipt names the proven local time; refusal asks for the intended date. The tool description states the disabled window, and [OWNER-ACTIONS](OWNER-ACTIONS.md) holds the unanswered hour. Explicit historical dates remain possible for reporting past deadlines. |
| `proveDeadlineDue` date-only branch | Clocks accepted are `3pm`, `3:30 p.m.`, and `HH:mm` in 24-hour form. Missing clocks, a single-digit hour without am/pm, and repeated/nonexistent DST hours become date-only at owner-zone end of day. Bare next week uses Sunday as an **unconfirmed upper bound**, never a claim that Sid named Sunday. | The model supplies the proven `YYYY-MM-DD`; the receipt explicitly says date-only/end-of-day, or unconfirmed end-of-week bound. Numeric ambiguous dates such as `03/04` cannot establish even a unique day and are refused with `deadline_ambiguous_date`. |
| `statusOf` | `submitted`, `handed in`, `turned in` prove submitted; `missed` proves missed; `cancelled`, `canceled` prove cancelled. Omission preserves stored status. `finished` is not proof of submission. | Aligned with #164's school tool description: school_update handles missed classwork/finished work and catch-up planning, deadline_record handles dated deadlines and explicit deadline status. Words are named in the tool schema and description rather than silently inferred. |
| `matchingDeadline` / `recordDeadline` | Only case/whitespace share a principal-scoped identity. Chem/Chemistry uses the existing uncertain-prefix clarification path, not a semantic alias. The literal course, title and due phrase must occur in that order. Proof scans only the course-to-title and title-to-due gaps, never course/title text: a date, clock or sentence separator breaks either tie. Every vertical break becomes a comma; any other punctuation (a character that is not a letter, digit, whitespace or apostrophe), or `and`, `then`, `or`, `plus` or `also`, breaks a tie only when the same gap contains a non-connector/filler word or any digit. Unpunctuated speech remains model judgment. | `deadline_record` asks which assignment is intended when a prefix/punctuation collision occurs and refuses borrowing another assignment's date, while names such as `Pride and Prejudice`, `Monday lab writeup`, `1st draft`, `Sun Yat-sen essay`, `Q&A worksheet` and `A/B testing lab` remain ordinary title evidence when copied whole. Platform sources still may duplicate owner-reported rows. |

These proof limits and date-only conventions are recorded through the independent review rounds;
they do not grant code permission to choose study priorities or reminder wording/timing.
`DEFAULT_LEAD_MINUTES[effort]` supplies the existing ingestion lead-window contract, with effort
chosen by the model, so owner-reported rows reach `listReminderDue` like collected rows.

## The list

Severity is a label for ordering, not a priority ruling. `violation` = code holds a decision
the roadmap gives to Jarvis. `silent` = the same, made worse because nothing tells Jarvis or
Sid that the decision happened.

### Voice

| # | Symbol | The decision code is making | Surface it should move to |
|---|---|---|---|
| 1 | `CallSessionCore.#guardOwnerRepeat` (`src/voice/call-session-do.ts`) | Which of the owner's spoken words Jarvis is allowed to hear. The 2 s post-match guard now suppresses only 1–3 passphrase-list words; ordinary speech outside that word-list shape passes. The existing later fragment/repeat checks remain. Every suppression by this guard sends a fixed neutral reply, but the model still receives no explanation. | Partially corrected on `codex/call-session-fixes` (2026-09-24, owner-directed scope): text-aware guard and neutral reply. A prompt statement explaining that repeated passphrases will not arrive remains open; model-prompt files are outside this change. This is still a partial register, not a completed audit. |
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

| # | Symbol | The decision code is making | Surface it should move to |
|---|---|---|---|
| 6 | `MemoryRepository.refileAutomaticInboxItems` (`src/memory/memory-repository.ts`) | Which memories move, how many (10), in what order (a wall-clock-hour-indexed rotation over ≤100 rows), and at what confidence floor (`>= 0.6`, hard-coded **four times** across two files: three literals in the repository plus `FILING_CONFIDENCE_THRESHOLD` in `automatic-distillation.ts`). It replays a topic decision the model made when the item was created, with no chance to revise it. | A refile tool: the wake-up tells Jarvis "N inbox items have unresolved topic decisions" with the stored paths and confidences, and the model decides which, how many, and in what order. If the rule must stay, export one shared constant so the gate cannot drift from `FILING_CONFIDENCE_THRESHOLD`. |
| 7 | `captureInput` (`src/memory/memory-repository.ts`) | How long a fact lasts. `input.lifetime === undefined ? (validTo === null ? "durable" : "temporary") : …` decides durability when the caller is silent — and the `memory_remember` tool description **invites the model to be silent**: *"Leave it out and the fact is durable."* The same default is written independently in `owner-telegram-agent.ts` and `memory-owner-controls.ts`. | Make `lifetime` and `expiresAt` **required** in the `memory_remember` schema so the omission cannot occur, and delete the three defaulting branches so an absent lifetime is refused rather than assumed. The same subsystem already states this principle: `automatic-distillation.ts` refuses to guess an expiry because *"answering it by guessing an expiry here would be code deciding what the roadmap gives to the model."* |
| 8 | `findActiveItemByNormalizedText` / `normalizedRememberText` (`src/memory/memory-repository.ts`) | Whether two statements are the same memory. Normalises case, apostrophes, zero-width characters and punctuation, compares strings, and on a match **silently merges** the new wording into the old item as an extra source — so the stored wording never changes and the receipt implies the new words were recorded. | Expose the candidate memories to the model and let it decide whether a new statement duplicates, extends or corrects an existing memory — exactly as `memory_correct` already invites. A mechanical guard, if kept, is a **non-authoritative hint returned to the model**, never a silent merge in the write path. **`silent` penalty.** |
| 9 | `MemoryRepository.liftItem` (`src/memory/memory-repository.ts`) | Whether a restored memory's evidence counts as confirmed. When a version's origin is `authenticated_first_person` and **every** source is archive-only, it sets `restoredBasis = "confirmed"`; otherwise it keeps the version's existing basis. Silent, and unreported to Sid. | Not necessarily a defect — the code's own comment argues the owner's lift *is* the confirmation. But it is a basis change made in code with no receipt, so either surface the new basis in the lift receipt or leave `basis` alone and let the model decide. |

---

### School and university

| # | Symbol | The decision code is making | Surface it should move to |
|---|---|---|---|
| 10 | `SchoolObservationRepository.deriveMissingWorkPage` (`src/school/school-observation-repository.ts`) | Chooses `closed`, `submission_seen`, `not_due` or `no_submission_seen` from deadline status, Classroom submission state and observation time, then persists a missing-work transition without model interpretation. | Expose source state, dates and read coverage through school evidence tools; Jarvis records the interpretation with those references. Retain mechanical timestamps/provenance. This finding from #160 is preserved here even if that design PR closes; no runtime change to the collector. |
| 11 | `guardReplyClaims` / `unsafeFirstPersonRanges` (`src/school/school-catchup-model.ts`) | Which sentences describe a worked explanation. Claims remain the default; the tutoring exception requires a worked verb object plus a completely parsed explanation prefix and tail. Unknown continuation words, destinations and second actions remain claims, including verbs absent from the original action list. This remains a partial language heuristic. | `OWNER_AGENT_SYSTEM_PROMPT` says worked explanations are not actions. The model's `claimedActions` should carry the judgment and receipts should enforce proof; the fallback guard stays for undeclared real actions under Sid's explicit tutoring-fix brief. |
| 12 | `SchoolCatchupModelAdapter.streamOwnerTool` / `isUniversityExecutionRequest` | In university and legacy unselected scope, a regex decides whether the owner's wording requests external execution and refuses before the model. | University tool/prompt judgment with execution gated at real external hands. Deferred here: university scope and its corpus tests remain unchanged; a school-paste regression test now also pins university refusal before any model call. |

Rows 10 and 11 retain the identifiers used by #160 and #162. The university
intake finding is row 12, avoiding a second row 10 when those branches meet.

### Fixed school intake decision (`SchoolCatchupModelAdapter.streamOwnerTool`, #164)

`SchoolCatchupModelAdapter.streamOwnerTool` now skips `isUniversityExecutionRequest`
only when `agentSelectedScope` is `school`. An assignment-list line such as
"Email Ms. Patel if you need an extension." previously refused the whole paste.
The school pipeline has storage and planning, but no external execution hands.
The `school_update` description now tells Jarvis when to select that tool;
forwarded-text provenance checks and `guardReplyClaims` remain in place.
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
3. **A new decision in code is a new row here, in the same pull request that adds it.**
   That is what makes "a tenth is not progress" checkable.
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
tier, not the authenticated-source boundary. Collector revocation still requires its
tier-three tap. The two existing judgment findings below remain open.

Date-disagreement follow-up, 2026-09-24: no rationale for preferring a
`content/myItems` date to the folder `DueDate` was recorded in #175's review, its
agent-log entries or this register. The mapper retains that compatibility projection,
but unequal values now add `ambiguous_assignment_date` to the evidence Jarvis reads;
equal values do not. Folder `Availability.EndDate` is a separately labelled fallback,
and an unfamiliar `Availability` shape is likewise surfaced rather than interpreted.
This register remains partial.

| Symbol | Decision in code | Surface it should move to |
|---|---|---|
| `DeadlineIngestion.ingest` / `classifyEffort` | Existing keyword and per-course rules choose an effort category and lead time for every ingested deadline, including new D2L evidence | Jarvis-supplied effort and reminder choices. This receiver reuses the existing ingestion safeguards and does not broaden that classifier |
| `SchoolCollectorRepository.status` called by the deterministic digest | Twelve hours determines when a whole school read is labelled stale, following the existing school-observation convention | An owner or Jarvis-selected source freshness setting. `school_d2l_status` already requires Jarvis to supply `staleAfterMs`; the digest default remains explicit here |
