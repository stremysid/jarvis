# PR #52 round-4 verification re-review: university application checklist

**Verdict: changes requested — 2 High, 1 Medium, 4 Low.** Every round-3 finding is genuinely
closed in code except H2 (partly). The two places the fix widened what counts as evidence both
re-open round-2-class defects, and the narrowed reply guard now misses 11 of 18 external-action
claims it blocked at 12a7bbf.

- **Scope:** `origin/codex/r5-application-track-slice1` at `5f150b1`; only `d5f5ede` is code.
  Round-3 head `12a7bbf`. Line references at `5f150b1`, relative to `apps/cloud-gateway/src/`.
- **Method:** read-only. `git archive` of both `5f150b1` and `12a7bbf` into scratch trees, then
  every probe run against **both** so each finding is a proven differential, not a guess.
  Probes ran the real `parseOwnerUniversityPlan`, the real `SchoolCatchupModelAdapter`, the real
  `UniversityTrackerRepository` over `0022`+`0024` on `node:sqlite`, and `0024` standalone.
  No repo test suite was run.

---

## Round-3 findings: status

| Finding | Status | Deciding file:line / evidence |
|---|---|---|
| **H1** URL splitting kills verified dates | **FIXED** | `university/university-tracker-model.ts:146-168` masks `https?://\S+` before sentence/connective splitting and restores it after. Proven: all four orderings accept (`…per https://uwaterloo.ca/aif for the 2027 cycle`, URL-first, `www.`, cycle-first) at `5f150b1` and all four are refused at `12a7bbf`. Control (no cycle phrase) still refused. |
| **H2** connective names unreachable | **PARTLY FIXED** | `:496` (status) and `:329-334` (date) fall back to the whole message when the label or a program alias contains `and/but/then`. All six round-3 inputs plus `"I finished the Western essay then submitted it"` now accept (all seven refused at `12a7bbf`). But the fallback is all-or-nothing — see **Medium 1** — and it binds the wrong sentence — see **High 1(b)**. |
| **M1** reply guard blocking benign replies | **FIXED, regressed the other way** | All 16 round-3 benign replies pass (`school/school-catchup-model.ts:37-53`), the seven round-3 BLOCK controls stay blocked, and the round-2 47-reply corpus is still 0/47 mismatches. But 11 of 18 external-action claims that `12a7bbf` blocked now pass — see **High 2**. |
| **M2** punctuation-exact `containsLabel` | **FIXED** | `:139-140` folds `['’ʼ\`]` → `'` and `\p{Pd}` → space. Proven: both apostrophe directions and `video-interview`/`video interview` accept at `5f150b1`, all three refused at `12a7bbf`; `co-op form`/`coop form` still refused, and the round-2 emoji-label control is unchanged. Residual: **Low 4**. |
| **M3** prompt budget on multi-program messages | **FIXED** | `:638-645` expands at most 2 named programs; `school/school-catchup-model.ts:577-579` retries once fully compact. Measured through the real adapter with a message naming every program: 8×5 → 23,375 B, 10×6 → 28,197 B, 12×6 → 31,627 B, 16×8 (128-item cap, 4 req + 2 dates) → 43,603 B — all structured, all under 48,000, **0 missing active itemIds** in every configuration. At `12a7bbf` the 12×6 and 16×8 cases fell back to ordinary chat. The retry is bounded at exactly one (`:579`), and compact rows keep `itemId` (`:660-666`), so no active itemId is dropped. |
| **M4** forwarded text records `submitted_by_sid` | **FIXED (for the disclosed class)** | `:39` widens `REPORTED_OWNER_SUBMISSION` and `:448-457` adds `namesItemAsThirdPartyPossession`. Proven: the three round-3 inputs plus `"Mom writes: …"`, `"Dad sent me this: …"`, `"Guidance forwarded this: …"`, `"Ms. Lee says …"`, `"Ms. Lee wrote that …"` are all refused at `5f150b1` and all accepted at `12a7bbf`. **The widened alternatives are load-bearing in production** — the reviewer's mutation survived only because no test exercises them; that is a test gap, not dead code. |
| **L1** duplicate → whole-turn failure | **PARTLY FIXED** | `university/university-tracker-repository.ts:561-569`. Proven end-to-end: re-adding an active label alongside a program update now saves the turn instead of throwing. But `:566` `continue`s silently — round-3 asked for "skip that one update **and name it in the reply**"; there is no reply line. See **Low 1**. |
| **L2** reactivate-before-retire plan order | **FIXED** | `repository:527` + `:647-651` + `:667` put every retirement statement ahead of every other status statement, so a reactivation can no longer reach `cap_reactivate` before capacity is released. *(By reading; the trigger behaviour itself was already proven.)* |
| **L3** stale `source_url`/`cycle` after un-verifying | **FIXED on the UPDATE path** | `persistence/migrations/0024_university_application_workflow.sql:176-181` plus `repository:189-197` and `:596-598`. Proven on `node:sqlite`: keeping both, keeping only the URL and keeping only the cycle all abort with `university_application_item_state_invalid`; nulling both still succeeds. INSERT-path residual: **Low 3**. |
| **L4** stale `KNOWN_ISSUES.md` claims | **FIXED** | `KNOWN_ISSUES.md:5-8` no longer claims URL+cycle must share one evidence excerpt, and `:33-36` no longer claims multiline reports fail closed. Both bullets now match the code. |

---

## New findings in the round-4 fix diff

### High 1 — The widened evidence binds the wrong sentence to an item (proven end-to-end)

- **Where:** `university/university-tracker-model.ts:487-497` (`evidenceClauses` = named clauses
  **+ every clause containing `it`/`that` + the whole message**) and `:329-334` (the same
  whole-message fallback on the date path). Both are gated only by
  `evidenceNamesOnlyItem` (`:435-446`), which asks whether the message names exactly one
  *tracker* item — not whether the claim is about that item.
- **(a) Anaphora — no special item name needed.** Proven end-to-end through the real repository
  and `0024`: the turn
  `"I'm drafting the Western essay. The Common App is done and I submitted it."`
  writes `item_status = submitted_by_sid` on the Western essay and drops it out of the digest.
  Refused at `12a7bbf`. Same class, all accepted at `5f150b1` and all refused at `12a7bbf`:
  `"The Western essay is next. My mom and I submitted it."` (submitted),
  `"The Western essay is the last one. I am skipping band this term, remove it."` (retired),
  `"The Queen's scholarship is retired. I changed my mind about the gym, keep it."` (reactivated),
  `"Mac statement check. The band form didn't go through, I never submitted it."` (un-submits a
  submitted item). Negations, questions and hearsay *inside the anaphoric clause* are still
  caught, so `"…then didn't submit it"`, `"Did I submit it?"`, `"Mom submitted it for me."` and
  `"My teacher says I submitted it already."` correctly refuse — the hole is the clause that is
  clean but about something else.
- **(b) Connective names — the fallback covers the whole program, not just the item.**
  `itemNameContainsConnector` (`:379-385`) tests the label **and every program alias**, so every
  item in a program called "Arts and Science" (or "Arts and Business", "Computing and Financial
  Management") gets whole-message evidence even when its own label is ordinary. Proven accepted at
  `5f150b1`, refused at `12a7bbf`, for the plain label `"UofT transcript"` in that program:
  `"I submitted my scholarship form today. The UofT transcript is next."` → submitted;
  `"I finished my chemistry lab. The UofT transcript is the last thing."` → ready;
  `"Remove my shift on Friday. The UofT transcript is fine."` → retired.
  Same on the connective label itself:
  `"I still have to write the Arts and Science essay. I submitted my OUAC application today."`,
  `"I am going to skip grade 12 calculus. The Arts and Science essay is my focus."`,
  `"I'm working on the Arts and Science essay. I finished my Mac supplement."`,
  `"My mom and I submitted the Arts and Science essay."` — and on the date path:
  `"I have a dentist appointment on Feb 1, 2027. The Arts and Science essay is next."` and
  `"My band concert is Feb 1, 2027. The Arts and Science essay is the last thing left."` both set
  Feb 1 2027 as the essay's due date. The identical messages against an ordinary label
  ("Western essay") are refused, which isolates the fallback as the cause.
- **Effect for the owner:** this is round-2's H1b message-wide binding, back in a narrower but
  still everyday form. Sid writes two sentences about two different things and one of his
  application items silently flips to submitted, ready, retired or reactivated — or takes an
  unrelated date. A wrong `submitted_by_sid` removes the item from the digest and needs explicit
  correction wording to undo; a wrong retirement hides it entirely.
- **Fix:** resolve `it`/`that` to the item only inside the *same sentence* as the naming clause
  (the message is already split into clauses; carry the last named item forward within a
  sentence, and reset at `.`/`;`/`!`/`?`/newline), not across the whole message. For (b), mask
  matched labels and program aliases before splitting on connectives — the approach round-3
  suggested first — and drop the whole-message branch entirely; that also removes Medium 1.
- **Test:** the four (a) inputs and the six (b) inputs above as refusals, each paired with the
  single-clause control that must still accept; plus a repository test asserting the D1 row for
  `"I'm drafting the Western essay. The Common App is done and I submitted it."` stays `drafting`.

### High 2 — The narrowed reply guard now misses external-action claims it used to block (proven)

- **Where:** `school/school-catchup-model.ts:39` (`applied|booked|put in` removed from the bare
  verb list), `:43` (the third-party noun must now be the verb's immediate object,
  `…(?:to\s+)?(?:the\s+)?THIRD_PARTY`), `:44` (the loose 40-character form kept only for
  `sent|forwarded|shared`), and `:46` (`applied`/`booked`/`put in` re-added behind narrow object
  lists).
- **Proven** through the real adapter, run against both heads. Blocked at `12a7bbf`, **passing at
  `5f150b1`** — 11 of 18:
  `"I've requested your transcript from the school."` ·
  `"I've requested your reference from Ms. Chen."` ·
  `"I've emailed your essay to Ms. Chen."` ·
  `"I've messaged your reference request to Ms. Chen."` ·
  `"I've requested the reference from your teacher."` ·
  `"I put in your scholarship application."` · `"I've put in your essay."` ·
  `"I put in the scholarship for you."` · `"I've applied on your behalf."` ·
  `"I've applied you to Western."` · `"I've booked your guidance meeting."`
  The common shape is *verb → Sid's object → third party later in the sentence*, which is how
  these claims are naturally written. The round-2 28-reply BLOCK corpus is unaffected (0/47
  mismatches) because those all put the third party immediately after the verb.
- **Effect for the owner:** this guard exists so Jarvis can never tell Sid it contacted his
  school, submitted something, or spent money. Round 3 broke it toward over-refusal; round 4
  broke it toward under-refusal, which is the dangerous direction. Sid reads "I've emailed your
  essay to Ms. Chen" and stops chasing the reference that was never requested.
- **Fix:** keep the object-position requirement but allow the third-party noun anywhere in the
  same clause after the verb (split on `,;.` and scan the remainder) rather than only
  immediately after it; restore `applied`/`put in`/`booked` as bare verbs and instead exempt the
  proven-benign objects (`applied your feedback`, `put in a note`, `booked nothing`) with a
  negative lookahead, rather than whitelisting the harmful objects.
- **Test:** add all 11 replies above as BLOCK rows to the guard table alongside the 16 round-3
  PASS rows, so neither direction can regress silently again.

### Medium 1 — For connective-named items the fallback is all-or-nothing (proven)

- **Where:** `university/university-tracker-model.ts:496` supplies the **entire** owner message as
  one clause, so `NEGATION`, `CONDITIONAL_OR_QUESTION` and `RETRACTION` at `:500-526` are tested
  against everything Sid wrote, not against the sentence that carries the claim.
- **Proven** as minimal pairs (connective label refused, ordinary label accepted, identical text):
  `"I submitted my Arts and Science essay. What's next?"` ·
  `"I submitted my Arts and Science essay, so I don't have to think about it anymore"` ·
  `"I finished the Arts and Science essay but I haven't proofread it"` ·
  `"I submitted the Arts and Science essay today, maybe check it later"`.
  All four succeed for "Western essay". Only the bare single-clause forms work, which is why the
  round-3 H2 reproduction cases all pass.
- **Effect for the owner:** H2 looks fixed but only for terse messages. Any "?", "maybe", "could",
  "if", or any negation anywhere in the turn still returns the generic
  "I couldn't update your university tracker" for a UofT Arts and Science item — and Sid cannot
  tell why the same sentence worked for Western.
- **Fix:** the same label/alias masking proposed in High 1 removes this along with High 1(b).
- **Test:** the four minimal pairs above, connective label and ordinary label side by side.

---

## Low

1. **An active duplicate is silently dropped with no reply line.**
   `university/university-tracker-repository.ts:566` `continue`s when the deduped item is not
   retired. Proven end-to-end: `"Add the Western essay again"` against an existing active Western
   essay saves the turn (the accompanying program update lands) and the item update vanishes with
   no user-visible trace — round-2's silent-skip behaviour, which L7 asked to replace with "a
   clear line or a reactivation mapping". **Fix:** collect skipped duplicates and name them in the
   reply. **Test:** repository test asserting the skipped label is reported.

2. **A new-item update that dedupes onto a retired item reactivates it with no reactivation
   evidence.** `repository:567-568` maps the duplicate to the retired `itemId`, but the model
   validated the update as `isNew`, where `:520` requires only that the item be named — the
   `REACTIVATION` gate at `:509-513` never runs. Proven end-to-end: after
   `"Skip the Western reference, it's a duplicate"`, the plain turn `"Add the Western reference"`
   flips the row back to `not_started`. Benign for "Add", but the same path accepts
   `submitted_by_sid` on a retired item. **Fix:** re-run `supportsStatus` with
   `existingStatus = "not_needed_by_sid"` after the mapping, or reject the mapping and let the
   model use the real `itemId` (it is already visible in `inactiveApplicationItems`).
   **Test:** repository test asserting a deduped reactivation without reactivation wording is
   refused.

3. **`0024` still permits an `unverified` row to carry `source_url`/`admission_cycle` at INSERT.**
   The new guard is `state_consistent_update` (`:176-181`), and the table CHECK at `:44-48` only
   requires `verified_at IS NULL` for the unverified branch. Proven: the INSERT succeeds on
   `node:sqlite`. The repository nulls them at `:596-598` so nothing writes it today, but the
   invariant the round-3 fix asserts on UPDATE is not enforced on INSERT. **Fix:** extend the
   CHECK to `verification_state = 'unverified' AND verified_at IS NULL AND source_url IS NULL AND
   admission_cycle IS NULL`. **Test:** migration test asserting the INSERT aborts.

4. **The M2 apostrophe/dash folding is not mirrored in the dedupe key, so one message can create
   two rows.** `containsLabel` (`:139-140`) folds punctuation; `applicationItemKey` →
   `normalizedKey` (`repository:167-170`) folds only whitespace and case. Proven end-to-end: the
   same owner message `"Add the Queen’s Commerce reference"` accepts the label with a straight
   apostrophe on one turn and the curly one on the next, leaving two active rows both shown in the
   digest. Before M2 only one spelling was creatable, so this is new. **Fix:** apply the same
   normalisation in `normalizedKey`. **Test:** repository test asserting the second spelling
   dedupes onto the first.

---

## What I proved by execution vs by reading

- **Executed** (both at `5f150b1` and at `12a7bbf`, so every claim is a differential): the round-2
  parser corpus (68 cases — 1 residual flag, which is round-3's intended M2 behaviour), the
  round-2 reply-guard corpus (47 cases, 0 mismatches), 39 + 12 + 10 + 10 new parser cases, 16
  round-3 benign replies + 7 round-3 BLOCK controls + 26 + 18 new replies, 10 prompt-budget
  configurations through the real adapter, 6 focused `0024` trigger cases on `node:sqlite`, and
  two end-to-end runs (real parser → real repository → `0022`+`0024`) covering High 1(a), Low 1,
  Low 2 and Low 4.
- **Reading only:** L2's statement ordering, and that the compact retry is bounded at one
  (`school/school-catchup-model.ts:577-579`) — the measured configurations never needed it
  because the 2-program cap already fits.
- Not re-audited: the whole PR outside the round-3 findings and the `d5f5ede` diff.
