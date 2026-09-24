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
| 11 | `guardReplyClaims` / `unsafeFirstPersonRanges` (`src/school/school-catchup-model.ts`) | Sentence patterns decide which replies claim unreceipted external actions; these language heuristics also mistake some worked explanations for actions. | `OWNER_AGENT_SYSTEM_PROMPT` and the model's `claimedActions` should carry the judgment; receipts enforce proof. #162 narrows the tutoring heuristic and retains a fallback for undeclared real actions. Its runtime change is not part of this PR. The school intake still guards claims, including a leading "Done." attached to a removed external-action claim. |
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
no longer spend an action tap or depend on the pipeline's direct-text action authority.
Collector revocation still requires its tier-three tap. These changes follow Sid's
explicit follow-up instruction; the two existing judgment findings below remain open.

| Symbol | Decision in code | Surface it should move to |
|---|---|---|
| `DeadlineIngestion.ingest` / `classifyEffort` | Existing keyword and per-course rules choose an effort category and lead time for every ingested deadline, including new D2L evidence | Jarvis-supplied effort and reminder choices. This receiver reuses the existing ingestion safeguards and does not broaden that classifier |
| `SchoolCollectorRepository.status` called by the deterministic digest | Twelve hours determines when a whole school read is labelled stale, following the existing school-observation convention | An owner or Jarvis-selected source freshness setting. `school_d2l_status` already requires Jarvis to supply `staleAfterMs`; the digest default remains explicit here |
