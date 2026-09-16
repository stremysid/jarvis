## 2026-09-16 19:49 UTC — Claude Opus 5, PR #64 max re-review at 61bf0f2: changes requested (round 3 regressed; change the approach)

**Gates are green, but three rounds of phrase lists have not converged, and this round is weaker than main in places.**
- **Gates at `61bf0f2`:** lint 0, typecheck 0, **177 files / 4,163 tests**. `0029`, voice/**, calls/** and `D1ContextRetriever` are unchanged.
- **Narrow second reviewer:** `reviewer-tools/pr64c-adversarial.md`, scripts in `reviewer-tools/pr64c/agent/`. I re-ran `e2e3.mjs`, `b2r3.mjs` and `n2r3.mjs` at this head myself, and the results below reproduce.
- **Round-2 status:** S2, S3 and N1 fixed; S1, S4, N2, N3 and N4 partial; **B1 and B2 not fixed**.

**B1. False external-action claims still reach Sid, now in cases main blocks.** 54 of 72 new false claims pass, including "I submitted your chem lab on D2L.", "I emailed your chem teacher after class." and "I accepted your Waterloo offer before the deadline." The cause is that the reply guard (`school-catchup-model.ts:38-48, 271-286`) dropped main's first-person action check, and words like "after" or "you can" exempt a clause.

**B2. Ordinary replies and truthful saves are replaced by the refusal.**
- 30 of 41 benign replies are replaced, against 2 on main.
- That includes "Your Waterloo AIF is due in 12 days…" and "Queen's Computing is a strong program…". Any 5+ letter -ed/-en word counts as a completion.
- 8 of 10 true save confirmations are replaced ("I've marked your Western essay as submitted.", "Logged the Waterloo offer."). After "I got my Waterloo offer!!" the offer **is saved**, but Sid is told "I can't do or confirm that action".

**B3. Regression against #52.** These are now recorded as submitted, while main and round 2 refuse them: "Priya told me I submitted the Western essay.", "My friend sent me a text saying I submitted the Western essay.", "I submitted the Western essay. Wait, I'm not sure it uploaded.", "Grandma asked me whether I submitted the Western essay." The cause is `university-tracker-model.ts:32, 35, 52-55`.

**B4. Wrong records.**
- "Waterloo still hasn't accepted me." records an offer (`:70`, the new "accepted me"/"got into" shapes). So do "I hope Waterloo accepted me" and "I got into the Waterloo open house".
- "I got a Waterloo Math offer." records the tracked **Computer Science** offer (`:868`).
- "I completed the Waterloo condition form but haven't submitted it." records the condition satisfied (`:980`).
- A model-written label "Waterloo offer (confirmed, reply by June 1)" is stored (`:1152-1153, 892-893`, `:213-218`).

**S1.** The pre-model "Which Waterloo program?" question runs without negation or hearsay checks. "I got rejected by Waterloo, no offer." gets asked which program, the rest of the message is dropped, and answering "Computer Science" can't be saved (`school-catchup-model.ts:345-359, 660-665`).

**Required approach for round 4 (reviewer decision, so it converges):**
1. **Receipts, not model claims, for anything saved.** When a tracker update is saved, Sid sees a fixed receipt built from the saved rows, for example "Saved: Waterloo Computer Science offer (you told me; unverified)". When nothing is saved, the fixed line says so and asks for the one missing fact. The model's free text never states that anything was saved, sent, submitted, accepted, paid or contacted. For all other model text, restore **main's** reply guard exactly; don't widen it further. B2's over-refusal and the save-confirmation problem both disappear.
2. **#52 parsing byte-identical to main.** Restore main's `supportsDirectOwnerClaim` path and the submission-status parsing exactly. New workflow statuses call that same validator and add nothing looser.
3. **Offers and conditions: record only one explicit affirmative shape.** "I got an offer from <tracked school> for <tracked program>" (or program-then-school), with the school and program both named and both tracked, and no negation, hedge, hearsay, question or second clause. Everything else saves nothing and gets the fixed "not saved, tell me the school and program" line. Drop "got into", "accepted me" and single-program inference. Labels come only from tracked names, never from model text.
4. **Pre-model refusal:** main's behaviour only, plus the round-3 S3 external-object rule.
5. **Regression corpus as tests.** Import every input from `reviewer-tools/pr64b/agent/*.mjs` and `reviewer-tools/pr64c/agent/*.mjs` as table tests with expected outcomes. Thresholds:
   - 0 false external-action claims shown to Sid;
   - 0 records from negated, hedged, hearsay or hypothetical inputs;
   - over-refusal on the benign-reply set no worse than main;
   - #52's corpus results identical to main.

**Next.** A fresh session implements the approach above. It merges main, runs lint, typecheck and the full suite, and requests re-review. `0029` stays unchanged.

— Claude Opus 5
