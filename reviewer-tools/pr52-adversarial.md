# PR #52 adversarial review: university application workflow slice 1

- Branch `origin/codex/r5-application-track-slice1`, head `3388c39` (ready entry at `61a0377`), base `main ebb757b`.
- Read-only. I read from a `git archive` of `3388c39` exported to the scratchpad.
- No repo tests were run. Regex behaviour was checked with standalone node scripts that copy the PR's regexes verbatim: `scratchpad/pr52-regex-probe.mjs` and `pr52-date-probe.mjs`.
- File:line references are at `3388c39`. Paths are relative to `apps/cloud-gateway/src/` unless stated otherwise.

**Verdict: changes requested.** One High, five Medium, several Low.

---

## H1: `submitted_by_sid` is bound to neither the speaker nor the item, and it is terminal, permanent and hidden from the digest

The code guard is the only non-prompt barrier. It accepts any message where a sentence starts with first-person "I (have) submitted / sent in / turned in / uploaded", including text Sid pastes or forwards from a teacher.

**Code**

- `university/university-tracker-model.ts:21`:
  `const OWNER_SUBMISSION = /(?:^|[.!?;:]\s+|\b(?:also|and|yes),?\s+)i(?:['’]ve| have)?\s+(?:(?:already|just|now|successfully)\s+)?(?:submitted|sent\s+in|turned\s+in|uploaded)\b/iu;`
- `university/university-tracker-model.ts:255-257`:
  `|| status === "submitted_by_sid" && (statusEvidence !== ownerMessage || !OWNER_SUBMISSION.test(ownerMessage))`
  - This is the whole check. Nothing ties the evidence to the item's label, kind or program, or to who is speaking.
  - Nothing limits how many items one message can mark submitted.
- `channels/telegram/telegram-types.ts:69-73, 213-217`:
  - Only media keys are rejected. `forward_origin`, `quote`, `external_reply` and `reply_to_message` are not.
  - A forwarded Telegram message arrives as plain owner `text`, and the model is given no forwarded marker (grep for `forward` in `src/` finds nothing).
- Terminal and permanent:
  - `university/university-tracker-repository.ts:528-530`: `if (existingRecord?.item.status === "submitted_by_sid" && status !== "submitted_by_sid") throw ...`
  - `persistence/migrations/0024_university_application_workflow.sql:117-122` (`submitted_terminal`) and `:124-128` (`reject_delete`).
  - There is no resolve, archive or correction path.
- Hidden: `university-tracker-repository.ts:323` (`i.item_status != 'submitted_by_sid'`) and the composer filter drop it from the digest.

**Proven inputs.** OWNER_SUBMISSION returns true for each of these, so the parser accepts `submitted_by_sid` when the whole message is used as evidence:

- `"I have submitted your reference letter to OUAC."` (a forwarded teacher message, which reaches the model verbatim)
- `"Hi Sid. I have uploaded your transcript to OUAC. Ms. Lee"`
- `"Guidance office: I've sent in your transcript request."`
- `"Ms. Chen and I submitted your reference"`
- `"I submitted my Waterloo AIF and still need to start the McMaster supplementary."` The code also accepts `submitted_by_sid` on the McMaster item from this message.
- `"I submitted none of them yet"` and `"I uploaded the wrong file?"`

Negation and conditionals the tests pin still fail closed: "I don't think I submitted…" and "If I submitted…".

**Consequence for Sid**

- A teacher or guidance message he forwards can move an unfinished reference, transcript or supplement to "submitted by Sid". So can one sentence covering two items.
- The item then leaves the morning digest permanently.
- He cannot undo it by saying "no, I didn't submit that": the repository and the trigger both refuse.
- This breaks the rule that "submitted" is only what Sid himself says he submitted. Only the prompt stops it, and commit `61a0377` claims the binding is done in code.

**Fix**

1. Add a correction path. Allow `submitted_by_sid → ready/drafting` on an owner turn whose evidence contains a correction phrase ("didn't submit", "not submitted", "undo"). Replace the terminal trigger with "a revert requires a newer `source_turn_id`", or add a `submission_retracted_at` column.
2. Bind speaker and item. Carry a `forwarded/quoted` flag from `telegram-types.ts` (`forward_origin`, `forward_from`, `quote`, `external_reply`, `reply_to_message`) into `ModelAdapterStreamInput`, and refuse `submitted_by_sid` on such turns.
3. Require the item's label, or a kind keyword such as essay, reference, transcript, AIF or scholarship, to appear in the same sentence as the submission verb.
4. Allow at most one submitted transition per turn, or require one distinct submission sentence per item.
5. Reject messages whose first-person submission sentence is followed by a negation ("none", "nothing", "not yet") or ends in "?".

**Tests**

- A parser test for each proven input above, expecting `university_application_model_item_invalid`, or rejection because the turn is flagged forwarded.
- An adapter test where a forwarded Telegram update does not call `applyOwnerPlan` with `submitted_by_sid`.
- A repository test and a migration test showing a correction reverts a submitted item and it reappears in `listApplicationItemsByDueDate`.

---

## M1: The reply guard misses ordinary claims that Jarvis sent, submitted or contacted something

`school/school-catchup-model.ts:37-41` (`FALSE_EXTERNAL_COMPLETIONS`) is the only code guard for "never claims it did". Proven with the exact regexes, each of these reaches Sid unreplaced:

- `"I've sent your reference request to Ms. Chen."` Plain "sent" is not in the verb list, and the third pattern needs "has been contacted".
- `"I've now submitted your Waterloo AIF."` ("now" is not in the adverb list.)
- `"Done, your Waterloo AIF is submitted."` (Passive voice; the second pattern needs "for you".)
- `"Your transcript request has been sent to the guidance office."`
- `"I've gone ahead and submitted the scholarship form."`
- `"I forwarded your essay to your teacher."` and `"I've asked Ms. Chen for your reference."`

**Consequence.** References and transcripts are exactly where a model is likely to say "I've sent your request". Sid could believe a referee was contacted or a form went in.

**Fix**

- Add the verbs sent, forwarded, requested, asked, notified and filed.
- Add the adverbs now, also, and "gone ahead and".
- Add a passive pattern: `(is|was|has been|have been) (submitted|sent|uploaded|forwarded|turned in|filed)`, when the subject is an application, item, transcript, reference, essay, form, request or scholarship.

**Tests.** A table test over the strings above expecting `EXTERNAL_ACTION_REPLACEMENT`.

**Related false positives (Low).** The new verbs replace benign replies with the refusal line. Both of these now get replaced:

- `"I've spent some time on your essay outline."`
- `"We're calling this the draft stage."`

The fallback paths now apply this guard too (see L3). Add negative tests.

---

## M2: No way to correct or remove an item; labels are free model text; the cap is for life

- `0024:104-115`: `item_kind` and `item_label` are immutable.
- `0024:124-128`: delete is forbidden.
- The repository (`:471-556`) has no resolve step for application items. PR #48 program items do have one (`resolveItemIds`, `:428-435`).
- `0024:70-80`: the cap counts every row ever inserted: submitted items, and items under deactivated programs.
- `university-tracker-model.ts:246`: `label` is a free model string of up to 160 bytes. Unlike status and date, it is not checked against the owner message.

**Scenario**

- The model mislabels an item, attaches it to the wrong program, duplicates it, or writes a guessed date or "(verified)" into the label.
- An example label: "Waterloo AIF — due 2027-02-01 (verified)" on an item whose real due date is null.
- The digest line (`digest/digest-composer.ts` ~178-203) then shows the invented verified date beside the real "[not started; due date unverified -- awaiting current-cycle source]".
- The item can never be fixed or removed. A wrong item with an early date sits in the top five of every digest.
- The only way to clear it is for Sid to falsely say he submitted it, and that is itself irreversible (H1).

**Fix**

- Add a `removed` or `resolved` status that needs owner evidence ("remove", "wrong", "not applying"), and exclude those rows from the digest, the caps and the prompt.
- Allow a label correction with owner evidence.
- Reject labels containing date-like tokens or verified/unverified wording, or require the label to be an owner-message excerpt.

**Tests**

- A remove flow in the repository and migration tests.
- A parser test rejecting a label that contains a date or "verified".

---

## M3: "Verified" checks only that the URL and cycle appear somewhere in the message

`university-tracker-model.ts:113-129`:

- Any https URL in the message is accepted. There is no official-source check, not even labelling it "owner-provided".
- `cycle` passes if `ownerMessage.includes(cycle)`. So a single character, or a prior-cycle year such as "2026" copied from a 2026-dated deadline, is enough.
- The URL is not tied to the item or the date. In `"Waterloo AIF due Feb 1 2027 https://uwaterloo.ca/... and I think McMaster's supp is Feb 15 2027"`, the McMaster date can be marked verified under Waterloo's URL:
  - its evidence excerpt only has to contain its own date (`:218-221`);
  - the URL check is message-wide.
- The plan's date-verification rule (current cycle, official source) is enforced only in the prompt.
- The digest shows "(verified)" without the cycle, so a verified prior-cycle date looks current.

**Fix**

- Require `cycle` to match something like `/^20\d\d(?:[–-]20\d\d)?$/`, and be at least the current application cycle, which is injected from the clock.
- Require the date's evidence excerpt to contain both the date and the URL, or at least the same sentence.
- Show the cycle in the digest.

**Tests**

- Cycle "2" or "2026" on a 2027-cycle item: rejected.
- A URL from a different sentence than the date: rejected.

---

## M4: A verified due date can be wiped without any correction from Sid

- `university-tracker-model.ts:203-227` and `university-tracker-repository.ts:514-523`.
- On an existing item, `dueDate: {date: null, verification: unverified, evidence: <any 1+ character excerpt>}` passes the parser. For a null date, the evidence only needs to be a substring of the message.
- The repository then replaces the verified date, URL, cycle and `verified_at` with null/unverified.
- **Scenario.** Sid says "ok what's next for the Waterloo AIF". The model returns a null-date object instead of `dueDate: null`, and the official verified date disappears.

**Fix.** On an existing item that has a date, refuse a null-date update unless the evidence carries a correction phrase ("not published", "no longer", "wrong date").

**Test.** A repository and parser test where a verified item plus an incidental null-date update is rejected.

---

## M5 (estimate, not measured end to end): tracker state can outgrow the prompt cap and lock both trackers

- `school/school-catchup-model.ts:20`: `MAX_STRUCTURED_PROMPT_BYTES = 48_000`. At `:493-497`, any larger prompt goes to `guardedOrdinaryReply`, so no tracker writes happen on that turn.
- `universityStateJson` (`university-tracker-model.ts:290-302`) now includes every application item, and `readSnapshot` (`repository:268-274`) does not filter out submitted items.
- Measured: a typical item with a real university URL is **401 bytes** of state JSON. 128 items is about 51 KB, over the cap by itself.
- Before that point, PR #48 requirement items (details up to 512 bytes), about 5.6 KB of prompt text and school state add up.
- Rough realistic mix: 10 programs × 5 application items + 5 requirement items is about 45 KB or more.
- Once over the cap, every turn skips the structured path. Nothing can be resolved or removed to recover, and application items cannot be removed at all.

**Fix**

- Leave submitted and removed items out of the prompt, send only the fields the model needs (drop `updatedAt`/`verifiedAt`), and budget or truncate each section.
- Or send only the programs the message is about.

**Test.** Fill the caps (16 programs, 128 program items, 128 application items with 120-byte URLs) and assert the structured prompt is at most `MAX_STRUCTURED_PROMPT_BYTES`, or that it degrades deterministically.

---

## Low

- **L1: date evidence is loose.** `university-tracker-model.ts:87-102` checks year, month word and day independently anywhere in the excerpt. Proven, all accepted:
  - `"Waterloo AIF due Feb 1, 2027; I have 15 essays to plan"` supports `2027-02-15`;
  - `"the essay may be due in 2027, maybe the 3rd week"` supports `2027-05-03` ("may" is matched as the month);
  - `"due 02/03/2027"` supports both `2027-02-03` and `2027-03-02`.

  Fix: require one contiguous date expression, and treat ambiguous dd/mm forms as unverified. Add a table test.

- **L2: repeating an item fails the whole university turn.** `repository:533-543` inserts a new item without checking existing keys, unlike the PR #48 program items (`:450-452`, `knownKeys … continue`). If Sid mentions "Waterloo AIF" again and the model uses `new-item-1`, the `0024` insert guard aborts the batch. Sid gets "I couldn't update your university tracker." and program updates in the same turn are lost. Fix: map to the existing item or skip. Add a repository test.

- **L3: the ordinary-reply fallback can now fail the turn.**
  - The fallbacks at `school-catchup-model.ts:417-443` now run `safeReply` through `safeOrdinaryReply` (`:226-231`), which calls `safeModelText` (`:106-126`).
  - That throws on non-NFC text, replies over 24,000 bytes, or malformed text.
  - `conversation/conversation-service.ts:921-946` then records `model_failed`, so Sid gets no reply. Before this PR the ordinary text passed through.
  - This is the path meant to keep ordinary chat alive when the model ignores the JSON contract.
  - Fix: normalise to NFC and truncate instead of throwing, and catch to a fixed line. Add a test with a decomposed-accent reply.

- **L4: saved state and the shown reply can disagree.** `school-catchup-model.ts:555-570` applies the plan, including `submitted_by_sid`, then yields the reply. If the reply trips the external-action guard, Sid sees "I can't confirm that action…" while a permanent submitted state was committed. Fix: skip the submission, or append a fixed factual line ("Recorded: you said you submitted <label>").

- **L5: gaps in the database triggers (defence in depth; the repository is the only writer).** `0024` allows:
  - `submitted_at` to change while the item is submitted;
  - `updated_at` to go backwards (only `>= created_at` is checked);
  - `due_date` to change while keeping the old `verified_at`/`source_url`, so a raw UPDATE can keep "verified" on a new date.

  Fix, as triggers:
  - abort when `OLD.item_status='submitted_by_sid' AND NEW.submitted_at IS NOT OLD.submitted_at`;
  - abort when `NEW.updated_at < OLD.updated_at`;
  - abort when `NEW.verification_state='verified' AND NEW.due_date IS NOT OLD.due_date AND NEW.verified_at IS OLD.verified_at`.

  Add migration tests.

- **L6: deploy order.** `readSnapshot` now always queries `university_application_items`. If code deploys before `0024` is applied, the snapshot read throws and every Telegram turn goes to `guardedOrdinaryReply` (`school-catchup-model.ts:477-491`). School catch-up and university writes both stop, not just applications. The handoff says 0024 is not applied. Fix: document "apply 0024 before deploy", or treat a missing table as zero application items.

- **L7: digest presentation.** Overdue items are not marked overdue, and past dates sort first. Verified dates show no cycle (see M3).

- **L8: submission only works on short, single-line messages (fails closed).** It requires the whole message as evidence, but `inline()` trims, rejects newlines and caps at 512 bytes. A multi-line message, or one over 512 bytes, can never record a submission. That is acceptable, but tell Sid in the reply.

---

## Checked and sound

- **0024 conflict handling**
  - The BEFORE INSERT `insert_guard` RAISE(ABORT) runs before conflict resolution, so INSERT OR REPLACE and OR IGNORE cannot displace or skip rows.
  - UPDATE OR REPLACE cannot collide, because `principal_id`, `program_id`, `item_id` and `item_key` are immutable (`core_immutable`).
  - There is no DELETE path, so REPLACE-driven deletes cannot happen.
  - Every trigger aborts, so trigger order does not matter.
- **Remote D1 syntax.** No CASE…RAISE and no CTEs. It uses the same `SELECT RAISE … WHERE` pattern as 0022, and 0024 was added to the remote-D1 syntax test.
- **Principal isolation.** The composite FK `(principal_id, program_id)` to `university_programs` blocks cross-principal program attachment.
  - The repository resolves program refs only to this principal's active programs (`finalProgramIds`) or new-N programs from the same response.
  - An existing item must belong to the referenced program (`repository:486-490`).
- **Turn FK.** `conversation_turns` has a `reject_delete` trigger (`0005:251-255`) that no later migration drops. No `src` code deletes turns; archival deletes only `outbox`/`events`. The RESTRICT FK cannot block archival.
- **Owner-turn triggers** on insert and update require a Telegram turn for the same principal.
- **Non-owner principals.** Application updates from a non-owner go to a guarded ordinary reply, with no write (`school-catchup-model.ts:550-554`). `ownerPrincipalId` is wired at `index.ts:121`; if it is unset, writes fail closed.
- **Verified shape.**
  - Verified requires a non-null date, URL and cycle at the parser (`:214-217`), in the repository (`:519-522`) and by CHECK (`0024:44-48`).
  - A status-only update keeps the existing verification and `verified_at`.
  - A date update recomputes `verified_at`.
- **Terminal state and concurrency.** A concurrent turn cannot un-submit an item: the repository and trigger both refuse. Receipt idempotency and the atomic D1 batch are unchanged.
- **Digest**
  - Deterministic, with no model in the loop.
  - Unverified dates are always named: "(unverified)", or "due date unverified -- awaiting current-cycle source" when there is no date.
  - `neutraliseInline` strips `\p{C}` and whitespace runs and caps at 240 characters.
  - At most 5 items, enforced in both the repository and the composer.
  - Submitted items and inactive programs are excluded, a read failure becomes a digest gap, and the 4096-character truncation still applies.
- **PR #48 regressions.** Program and item logic is unchanged. The acknowledgement mutation stripping now also clears `applicationUpdates`. The combined `exactRecord` requires the new key, and a model that omits it falls back to ordinary chat.
- **PR #45/#51 regressions.** Both fallback paths now run the full secret, external-action and Brightspace guard. That is stricter than before, apart from L3 and the M1 false positives. The Brightspace replacement is preserved.
