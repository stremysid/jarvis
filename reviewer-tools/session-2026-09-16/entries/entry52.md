## 2026-09-15 21:55 UTC — Claude Opus 5, PR #52 max review at 3388c39: changes requested

This review covers the application-workflow slice at `3388c39`, based on main `ebb757b`. It adds migration `0024_university_application_workflow.sql`.

**Local checks on 3388c39** (Windows 11, `jarvis-pr39`, while three builder sessions were active on this PC):
- Lint and typecheck pass.
- `pnpm test` passed 3,262/3,265. The three failures are voice acceptance tests that hit the 5-second timeout under load (`voice-call-path`, `voice-owner-passphrase-security`), outside this slice. Rerun alone, both files pass 56/56.

**Migration 0024.**
- **Syntax:** no `CASE`. Every trigger uses `SELECT RAISE ... WHERE`.
- **Insert guard:** the table is `WITHOUT ROWID`, and the insert guard blocks both the primary key and the natural key.
- **Trigger removal** (`reviewer-tools/pr52/mut52-triggers.json`, one trigger removed per run): `BASE` passes, and all 7 removals are killed by named behaviour tests, with 0 timeouts.
- **Foreign key:** `source_turn_id ... ON DELETE RESTRICT` follows `0020`/`0022`, and no source code deletes `conversation_turns`.

**Reviewer probes** (`reviewer-tools/pr52/zz-reviewer-pr52-probes.test.ts`, describe `zzreviewerpr52`). All four pass at `3388c39`, which means each defect exists. All four must fail after the fix.
- **P1, cross-item:** "I submitted my Waterloo AIF. I haven't started the Western essay yet." lets the Western essay become `submitted_by_sid`.
- **P2, negation:** "I haven't started the Western essay yet" supports `drafting` through the excerpt "started the Western essay".
- **P3, retracted:** "I just submitted the Western essay. Actually no, the portal crashed, so it didn't go through." is accepted as submitted.
- **P4, quoted question:** "Counsellor asked me: I submitted the transcript request, right? Not sure." is accepted as submitted.

**B1. A submitted-by-Sid mark isn't tied to its item, and it can never be undone.**
- **Where:** `applicationUpdate` in `university-tracker-model.ts` accepts `submitted_by_sid` when `statusEvidence` is the whole message and `OWNER_SUBMISSION` matches anywhere in it. Nothing ties that match to the item being updated. `university_application_items_submitted_terminal` and `reject_delete` then make the mark permanent.
- **Reach:** P1, P3 and P4. The morning digest drops submitted items. So one wrong model output removes an unfinished application item from the digest for good, and Sid has no way to correct it. With applications due around the end of September, that can mean a missed deadline.
- **Why now:** the terminal rule and the status list live in `0024`. Once it is applied, changing them needs a table-rebuild migration.
- **Fix:**
  - Tie the report to the item. The positive clause must name that item (its label, or its kind plus its university or program), and a turn may carry at most one `submitted_by_sid` update. Refuse the whole message if it also carries negation, retraction ("actually", "didn't go through"), question or conditional markers.
  - Give Sid a correction path out of `submitted_by_sid`. It must come from a later owner turn, with whole-message evidence that names the item. In the schema, the terminal trigger could, for example, allow leaving `submitted_by_sid` only when `source_turn_id` changes.
  - Add named tests for P1–P4 and for the correction.

**S1. An application item can never be retired.**
- Delete is forbidden, kind and label are immutable, and no status means "not doing this".
- A mistaken, duplicate or abandoned item (for example a scholarship Sid decides to skip) stays in the digest until the whole program is deactivated. It also holds a slot against the 32-per-program and 128-total caps forever.
- Labels are free model text, never checked against the owner's message. So a label such as "Waterloo AIF — due 2027-02-01 (verified)" can show an invented verified date in the digest for good.
- **Fix:**
  - Add an owner-reported, non-digest status in `0024` (for example `not_needed_by_sid`). It needs exact owner evidence, the digest must exclude it, and it must be able to return to an active status.
  - Refuse labels that carry dates or verified/unverified wording, or require the label to be an excerpt of the owner's message.

**S2. Evidence for a non-submitted status can be a cropped negation.**
- `ownerEvidence` accepts any substring of the message, so P2 passes. This is the same class of defect as PR #50 B1.
- **Fix:** status evidence must be the whole sentence or clause it comes from, and clauses with negation, conditional or question markers are refused. Alternatively, use the whole-message rule for every status change.

**S3. The ordinary fallback can now fail the whole turn.** `guardedOrdinaryReply` and `fallbackWithSaveFailure` now pass every ordinary reply through `safeReply`. `safeReply` calls `safeModelText` with `MAX_REPLY_BYTES` and throws on text that is too long or not NFC, and nothing catches that. Before this PR, those paths returned the ordinary reply as it was. Now a long ordinary answer on any fallback path (missing table, oversized state, bad JSON, save failure) ends the turn with no reply to Sid. Apply the reply-claim patterns without the size and NFC gate, or catch the error and return the ordinary text bounded to the Telegram limit.

**S4. The external-action guard still misses common completion claims.** The second reviewer checked the PR's exact regexes, and these pass through unchanged:
- "I've sent your reference request to Ms. Chen."
- "I've now submitted your Waterloo AIF."
- "Done, your Waterloo AIF is submitted."
- "... has been sent to the guidance office"
- "gone ahead and submitted"

Cover passive "is/was/has been submitted/uploaded/sent", "sent ... to", "now" as an adverb, and "gone ahead and". Add named tests. This includes N2's false positives.

**S5. Tracker state can grow past the prompt cap and lock tracker writes.** `MAX_STRUCTURED_PROMPT_BYTES` is 48,000. Submitted items, and after S1 retired items, stay in `universityStateJson` forever. Nothing can be deleted, so once the school and university state pass the cap, every turn takes the ordinary path, and neither tracker can be updated again. The second reviewer estimates about 400 bytes per item, so the 128-item cap alone gets close. Keep submitted and retired items out of the prompt state (or summarize them), and add a test that a full cap still fits.

**Also from the second reviewer (`reviewer-tools/pr52-adversarial.md`):**
- **Forwarded messages.** Telegram ingress doesn't mark forwarded messages, so a forwarded "I have uploaded your transcript to OUAC. Ms. Lee" reads as Sid's own words, and "Ms. Chen and I submitted your reference" matches too. B1's naming rule narrows this, and the correction path makes it recoverable. Refuse `submitted_by_sid` from forwarded messages if ingress can mark them cheaply; otherwise record it in `KNOWN_ISSUES.md` as a cross-feature follow-up.
- **M4.** A date update with a null date and any excerpt of one or more characters clears a verified date, its URL and its cycle. Clearing a verified date should need whole-message evidence.
- **M3 (from #48).** `verification()` accepts any https URL and any substring as the cycle, and the digest never shows the cycle. Record it for the next university PR if it isn't fixed here.
- **L1–L8.** Fix what's small, or record it: loose day matching in date evidence (with N3), re-adding an existing item aborts the whole turn, a submission saved while the reply says "I can't confirm that action", `submitted_at` and `updated_at` drift under raw UPDATE, the deploy-before-0024 ordering, overdue items not flagged in the digest, and the single-line 512-byte limit on submission evidence.

**N1. The repository and the trigger count the cap differently.** `applyOwnerPlan` counts only items under active programs. `cap_insert` counts every row, including items under deactivated programs, which can't be deleted. Near the cap, a save fails with the generic save-failure line instead of a clear limit refusal. Count the same rows the trigger counts.

**N2. The broader reply guard can over-trigger.** `safeOrdinaryReply` now runs the full structured-reply guard on every ordinary fallback reply. With the new `spent`/`spending` and `reached out` verbs, a harmless reply such as "I've spent some time on this" becomes the external-action refusal. Leaning toward safety is fine here. Pin that behaviour with a test or narrow the verbs.

**N3. Ambiguous numeric dates.** `evidenceSupportsDate` accepts `03/04/2027` for both 2027-03-04 and 2027-04-03. For numeric dates where both parts are 12 or less, refuse the date or keep it unverified unless the evidence is ISO or uses a month name.

**Next.** A fresh builder session merges main `1cae97b`, fixes B1, S1–S5, M4 and N1 in `0024` and the model/repository code before any apply, adds tests P1–P4, reruns the trigger-removal evidence, and requests a max re-review. N2 and N3 may be fixed or recorded in `KNOWN_ISSUES.md`.

This PR authorizes no migration, deploy, secret or live action.

---
