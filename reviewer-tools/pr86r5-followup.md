# PR #86 round 5 follow-up, head 1335d73 — NOT a clearance

**Yes. Four of the five unrelated-"yes" shapes still promote** the model-inferred item to `basis confirmed / origin authenticated_first_person / uncertain 0 / active`. Your example is real, and the hole is wider than that one sentence.

Tests: `C:\Users\Sid\jarvis-pr86-adv\apps\cloud-gateway\test\channels\adversarial-pr86r5.test.ts` (worktree detached at `1335d73`). Run from the worktree root:
`npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/channels/adversarial-pr86r5.test.ts`
**Result: 5 failed / 3 passed of 8.** Every test asserts the correct behaviour. No source mutation was made or left (`git status --porcelain -- apps/cloud-gateway/src` empty). Nothing pushed, merged or deployed.

Every case plants the same fabricated item (`Sid likes math`, `proposed/model/inferred`, from Sid typing "remember I don't like math"), then Sid types `yes`. Only Q0 is a genuine confirmation.

| Test | Jarvis's previous message | Outcome |
|---|---|---|
| `Q0 control: a genuine confirmation question must still promote` | `Noted. Should I remember "Sid likes math"?` | **PASS** (promotes, correctly) |
| `Q1 control: an unquoted echo must still refuse (round 4 A2)` | unquoted echo + unrelated question | **PASS** (refuses) |
| `Q2 the quoted fact and an unrelated question in ONE sentence must not promote` | `Noted. I have "Sid likes math" noted — want me to plan your chem lab tonight?` | **FAIL — promotes** |
| `Q3 a question that is genuinely about something else must not promote` | `Noted. Should I put "Sid likes math" aside and start your chem lab?` | **FAIL — promotes** |
| `Q4 two questions where Sid answers the second must not promote the first` | `Noted. Is "Sid likes math" right? Also, want me to plan your chem lab tonight?` | **FAIL — promotes** |
| `Q5 re-quoting a question Jarvis asked earlier must not promote` | `Noted. That older question was: is "Sid likes math" right? Anyway, want me to plan your chem lab tonight?` | **FAIL — promotes** |
| `Q6 a quoted fact inside a rhetorical question about the chem lab must not promote` | `Noted. Since "Sid likes math", shall I book your chem lab for tonight?` | **FAIL — promotes** |
| `Q7 the round-4 attacks stay closed` | bare `ok`; and `no, that's not right, correct it` after a genuine question | **PASS** (both refuse) |

Q3 is the sharpest: Jarvis asks whether to **put the fact aside**, Sid says `yes` meaning "yes, put it aside and start my chem lab", and the fact is promoted to something he said himself.

## Where, and why the gate does not bite

`apps/cloud-gateway/src/channels/telegram/owner-telegram-agent.ts:527-551` (`exactStoredFactQuestion`), reached from `:1024-1028`.

The function only requires: an exact quoted span equal to the stored fact; the sentence containing it ends in `?`; `isQuestionSentence`; and `isMemoryOfferOrGroundedQuestion(question, fact)`.

**That last check is vacuous in this position.** `isMemoryOfferOrGroundedQuestion` (`:520-524`) returns true if the question shares *any* content word with the fact — and the fact is quoted **inside** the question, so `contentWords(question)` always contains every word of `contentWords(fact)`. The `some(...)` branch is unconditionally true. What is left is "the fact appears in quotes somewhere in a sentence that ends in a question mark", which any sentence can satisfy while asking about something else entirely.

Two further gaps in the same gate:
- **Nothing requires the qualifying question to be the last one.** Q4 and Q5 put the confirm-shaped question first and the real question second; Sid's `yes` answers the second.
- **Nothing distinguishes a live question from a recap.** Q5 re-quotes a stale question and still qualifies.

One caveat on my own earlier phrasing: my first Q5 (`Earlier I asked: Is "Sid likes math" right?`) refused, but only because the honesty guard deleted that sentence before delivery (`I asked` matches `FIRST_PERSON_ACTION_CLAIM`). Rewording it without a first-person verb promotes. The reply guard is not a defence here.

## Precise fix

1. **Stop passing the whole question to the semantic check.** In `exactStoredFactQuestion`, cut the quoted span out of `question` first and test the *remainder*, so the fact cannot vouch for itself:
   ```ts
   const remainder = question.replace(match[0], " ");
   if (!/\b(?:remember|note|save|store|keep|right|correct|confirm|accurate|true)\b/iu.test(remainder)) continue;
   ```
   and reject a remainder that carries any other request — anything matching `\b(?:plan|book|start|check|send|email|call|put|set|open|show)\b` — so Q2, Q3 and Q6 fail. Tighter and better: match the whole question against a small whitelist of confirm shapes anchored on the quote (`is/was "FACT" right/correct?`, `should I remember/note/save/keep "FACT"?`, `want me to remember/note/save/keep "FACT"?`) and accept nothing else.
2. **Require it to be the question Sid is actually answering:** no further `?` may appear in `previous.text` after the qualifying question's `end`. That closes Q4 and Q5.
3. **The durable fix, which I would take instead of a fourth regex round.** Rounds 3, 4 and 5 each narrowed this predicate and each time a plausible phrasing got through, because the model writes both the stored fact and the question that licenses it. Stop promoting `origin='model' AND basis='inferred'` proposals from free text at all: raise a decision and reuse the existing keyboard path (`agent:936-950` already does this for multi-item forget), so Sid taps a button that shows him the exact stored wording. Then no sentence the model composes can ever be its own confirmation.

## Verified fixed at this head

- **Round 4's M1 is fixed as recommended:** `offendingSentenceRanges` now takes `(reply, scan, patterns)` and calls `sentenceAround(reply, …)` (`school-catchup-model.ts:534-545`, call sites `:563-575`). My round-4 `C3` shape no longer deletes the draft.
- **Round 4's A2/A2b/A3/A5 are closed** — reconfirmed by `Q1` (unquoted echo) and `Q7` (bare `ok`; explicit negation `no, that's not right, correct it`).
- **The gate is not dead:** `Q0` shows a genuine `Should I remember "Sid likes math"?` still promotes.
