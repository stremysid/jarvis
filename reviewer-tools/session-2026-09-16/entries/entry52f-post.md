## 2026-09-16 03:38 UTC — Claude Opus 5, PR #52 round-6 max re-review at df5ba4d: cleared with follow-ups

You made the two structural changes rather than another round of phrasings, and it shows. Six rounds is a lot, but this one broke the pattern: nothing here enumerates its way out of the problem. Merging.

**Gates at `df5ba4d`:** lint and typecheck pass, `pnpm test` **3,707/3,707 with 0 timeouts**. `0024` has no `CASE` and is unchanged since round 5, so its 9/9 whole-trigger-removal evidence carries; I re-ran it anyway and got **9/9 killed with BASE surviving**, 0 timeouts, 0 ENOENT. All four round-1 probes still **FAIL**.

**H2 is fixed, and the rule is now simple enough to reason about.** `itemEvidenceClauses` sets `immediatelyFollowsTarget` true only on the naming clause and clears it at the end of **every** iteration, so an `it`/`that` clause binds only when it is literally the next clause in that sentence. `"The Western essay is next, and I submitted it."` still works; `"The Western essay is next, the Common App is done and I submitted it."` cannot, and the code no longer has to know whether the Common App is tracked. That is the whole point — the previous version depended on recognising the interrupting subject, which is unbounded. The reactivation wording is carried through the same gate.

**M2 is fixed.** The protected-phrase masking now runs on the whole message **before** the sentence split, so a label's own punctuation cannot cut it. `"St. Michael's reference"` survives in both a plain and a connective-named program.

**H1 is fixed by inversion, and I proved the inversion is load-bearing.** `FIRST_PERSON_ACTION_CLAIM` now matches any first-person action verb and `allowedFirstPersonActionClaim` is an allow-list of benign shapes, with the fixed refusal winning otherwise. Mutation `H1-reply-guard-allowlist` — making that function always return `true` — is **KILLED**. BASE survives. The four comma regressions and the eight residual cross-clause claims are gone, and the 16 benign replies including the explicit denial still pass.

**Lows closed:** `JOINT_OWNER_SUBMISSION` now covers plural parents, siblings, both `counsellor`/`counselor` spellings and an optional `have`/`had`; a response-local duplicate of a retired item remaps only after the same status-evidence validator proves reactivation, so a bare "Add …" refuses while "Add … back, I need it after all" reactivates without discarding the turn; and `KNOWN_ISSUES.md` records the seventh deferred limit for the silent active-duplicate skip.

**Follow-up, not blocking, and the thing to watch in real use.** The allow-list still names benign objects literally — `your feedback|edits|changes|notes`, `the same structure`, `a stricter word limit`, `note|placeholder due date|reminders|tracker`. Anything outside those refuses: "I've applied your suggestions" and "I've put in a bookmark" would both be replaced by the external-action line. That is the **safe** direction and it is exactly the trade I asked for — a false refusal is visible and annoying, a false claim is invisible and harmful — but it will need widening against real replies rather than a fixed list. When Sid starts using this, collect the refusals it produces and widen from them; do not re-enumerate the harmful side. Worth a line in `KNOWN_ISSUES.md` saying the allow-list is expected to grow from observed usage.

**Merging** at `df5ba4d` plus my entry, per Sid's delegation, and verifying main afterwards. Migration `0024` stays an **unapplied candidate** along with `0016`–`0023` and `0025`; nothing here is deployed or switched on, and the owner-attended scratch proof still comes first — see the separate entry about that runbook, which cannot complete as written and is being rebuilt.

— Claude Opus 5
