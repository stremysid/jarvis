## 2026-09-15 22:44 UTC — Claude Opus 5, PR #52 round-2 max re-review at 5e1a2ed: changes requested

This re-review covers fix commit `f2475f8` and the main merge `9fa3280`. Main has since moved to `4262024` (#55, docs only).

**Local checks on 5e1a2ed** (Windows 11, `jarvis-pr39`):
- Lint and typecheck pass.
- The first full run was invalid: five builders were active, and 104 unrelated guest/voice tests timed out. The 23 affected files, rerun alone, pass 770/770 with 0 timeouts, so the suite is green.
- **Migration 0024:** no `CASE`. All 9 whole-trigger removals are killed by named tests (`reviewer-tools/pr52/round2/run52btrig.txt`).
- **Round-1 probes:** all four now fail, as required.

**Still sound** (second reviewer, SQL-proven):
- the docs merge lost no AGENT_LOG or KNOWN_ISSUES lines;
- REPLACE, IGNORE, UPDATE OR REPLACE and DELETE are blocked;
- `submitted_at` and `updated_at` can't drift;
- leaving a submitted or retired status needs a later Telegram turn;
- retire and reactivate respect the active and history caps, which can't be reset;
- the fallback reply no longer throws (S3 fixed);
- ambiguous numeric dates are refused (N3 fixed).

The full evidence is in `reviewer-tools/pr52b-adversarial.md` and `reviewer-tools/pr52/round2/`. My own regex probe (`regex-probe52b.txt`) found H1b, H2 and M1 independently. I verified H1a and M2 by reading `supportsStatus` and `applicationDueDate`.

**H1. `submitted_by_sid` is still saved when Sid didn't say he submitted that item.**
- **H1a:** for a retired item, any new status only needs `REACTIVATION`, and that branch returns before the submission rule. So "Keep the Queen's scholarship" plus `submitted_by_sid` is saved, proven end to end.
- **H1b:** `namesItem` and `OWNER_SUBMISSION` are both matched against the whole message. So "I submitted my Waterloo AIF and started the Western essay." saves the Western essay as submitted, and it leaves the digest. P1 is refused only because it contains "haven't".
- **Fix:**
  - Check the submission rule first, whatever the current status. Reactivation may only move to `not_started`, `drafting` or `ready`.
  - Bind status evidence to one clause: split on `.;!?` and on `, and | but | then`. The clause must match the status wording and name the item, and name no other application item.
  - Apply the same clause binding to `drafting`, `ready` and `not_started`.
  - Keep "I submitted my Waterloo AIF and started the Western essay." accepted for the Waterloo AIF as a positive control.

**H2. Retirement accepts negated and cross-item messages.**
- `not_needed_by_sid` checks only `CONDITIONAL_OR_QUESTION` and `RETIREMENT`.
- These all retire an item:
  - "Don't remove the Queen's scholarship" (proven end to end);
  - "I'm not skipping the Waterloo AIF";
  - "I don't need help with the Waterloo AIF";
  - "I'll skip the gym tonight and work on the Western essay";
  - "Remove the Western essay, keep the Waterloo AIF", which retires the Waterloo AIF.
- **Fix:**
  - The retirement verb and the item name must be in the same clause, with no negation in that clause.
  - Drop bare `don't need` unless the clause ends at the item or "anymore".
  - Apply the negation rule to reactivation too.
  - Keep "Skip the Western reference, it's a duplicate" and "I'm not applying for the Queen's scholarship" accepted.

**M1. The widened reply guard now replaces ordinary replies.**
- **False positives:** the second reviewer measured 17 of 19 benign replies replaced, and my probe found the same class. Examples:
  - "I asked earlier which programs you're considering."
  - "I'm asking because the Waterloo AIF is still unverified."
  - "Once your Waterloo AIF is submitted, Waterloo emails a confirmation."
  - "I sent you a summary above."
  - The correct acknowledgement on a submission turn: "Got it. Your Waterloo AIF was submitted by you, so it's off the list."
- **Still missed:** 14 claims pass, including "has now been submitted", "I've handed in your AIF", "I told your counsellor about the transcript", "I booked your Waterloo interview" and "Ms. Chen has been contacted."
- **Fix:**
  - For contact verbs, require a third-party object (Ms./Mr./teacher/referee/counsellor/guidance/school/university/OUAC) or "for you" nearby, and drop the bare `asking|filing|called|sent`.
  - For the passive form, skip matches after `once|after|when|until|before|whether|make sure|check|if`, and matches followed by `by you` or in a sentence containing `you said`.
  - Add `has (now|already) been`, `got`, `is in`, `handed in`, `applied`, `put in` and `booked`.
  - Pin both lists in one table test.

**M2. A verified due date is still replaced by a question, hearsay, a negated clear or another item's date.**
- "Is the Waterloo AIF due Feb 15, 2027?" replaces a verified Feb 1 with an unverified Feb 15 in the digest (proven end to end).
- **Fix:**
  - For an item that already has a date, a change needs whole-message evidence that names the item, with no question, conditional or hearsay (`thinks|heard|said|might|maybe`).
  - Restating the same date unverified keeps the existing verification.
  - `DATE_CORRECTION` refuses on negation.
  - A new date must sit in the same clause as the item name.

**M3. Active tracker state isn't budgeted.** 12 programs × 6 items with 4 requirements and 2 dates each already exceeds the 48,000-byte structured-prompt cap. Past it, every turn is ordinary chat and nothing can shrink the tracker. Whether Sid reaches that size is an estimate.
- **Fix:** send full requirement detail and verification URLs only for programs the message names, and a compact `{itemId, label, status, dueDate, verificationState}` for the rest.
- **Test:** 16 programs, 128 active application items and 128 program items at realistic sizes stay under the cap and still contain every active `itemId`.

**Low (fix if small, otherwise record in KNOWN_ISSUES):**
- **L1:** legitimate reports are refused silently. Examples: "I submitted the AIF", "I submitted my Waterloo AIF. What's next?", "I didn't actually submit the Western essay", "Feb. 1, 2027", any multi-line message, and possibly trailing whitespace. Apply the `?` check per clause, allow adverbs, trim before comparing, and tell Sid when nothing was saved.
- **L2:** the correction path accepts conditionals and questions.
- **L3:** label filter gaps ("February 1st", "1 Feb", "2027/02/01", emoji), and "May 5 info session essay" is wrongly refused.
- **L4:** the verified cycle check is met by the date's own year.
- **L5:** order status updates before inserts so a plan the repository accepted can't abort at the cap.
- **L6** (must land before `0024` is applied): `state_consistent_update` should also refuse changes to a verified row's `source_url` or `admission_cycle` without a new `verified_at`, a backdated `verified_at`, and leaving a submitted or retired status with an older turn.
- **L7:** re-adding a retired item is skipped silently.
- **L8:** #53 conflicts textually in 7 files. Whichever merges second resolves them and reuses #53's `isDirectText`.

**Next.** A fresh builder session merges main `4262024`, fixes H1, H2, M1–M3 and L6, handles L1–L8, reruns the four round-1 probes plus a table of every input above, reruns trigger removal for any changed trigger, and requests a max re-review.

This PR authorizes no migration, deploy, submission, upload or contact.
