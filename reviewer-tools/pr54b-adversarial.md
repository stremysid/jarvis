# PR #54 round-2 adversarial re-review: owner step-up live evidence

- **PR:** ksid1229-ops/jarvis #54, `codex/r1-step-up-release-evidence`
- **Head:** `407af7d` (implementation `1243390`; fix commits `47cc831`, `a05cc72`; main merge `31f1f57`), no migration
- **Round 1:** my verdict at `bf16699` (AGENT_LOG entry `b8bb440`), report `reviewer-tools/pr54-adversarial.md`
- **Reviewer:** Claude Opus 5, cross-vendor second review, max depth, read-only
- **Scope:** verify the listed round-1 fixes in code, check the six survivor claims, hunt regressions in `git diff b8bb440 1243390`. Unchanged parts were not re-audited.

## Method

- Read the fix diff in full (`git diff b8bb440 1243390`), plus `git diff 1243390 407af7d` (docs only: the #55 merge and the re-review request).
- Read the validator at `407af7d` in full and checked every new field against the merged runtime: `0018_owner_call_step_up.sql`, `0021_voice_owner_delivery.sql`, `owner-call-step-up.ts`, `call-session-do.ts`, `inbound.ts`, `outbound.ts`.
- Ran the PR's own `voice-smoke.test.ts` and `voice-smoke-runtime.test.ts` against the exact `407af7d` sources under a minimal vitest shim in the scratchpad (node 24, no repo mutation): **50/50 and 16/16, matching the builder's 66**.
- Ran 45 adversarial probes against the exact `407af7d` validator (`scratchpad/pr54/round2/probe.mjs`).
- Ran an **independent 34-mutation sweep** (`mutations.mjs` / `mutate.mjs`), one change per run, each anchor verified unique, scored by the PR's own named tests. 20 killed, 13 survived, 1 control.
- For every survivor, removed the guard and re-ran the exact input that guard blocks, to separate "implied by another checked path" from "real unpinned rule" (`survivors.mjs` / `escape-probe.mjs`).
- Placed no calls, ran no live smoke, touched no secrets, deployed nothing, made no repo change.

## Verdict

**CHANGES REQUESTED (small).** 0 High, 1 Medium, 3 Low.

**Every round-1 blocker is fixed in code, not merely tested.** B1 is closed and proven closed by probe. S1's three unobservable fields are gone and each replacement is derivable from a real query over `0018`/`0021`. All five F1 rules now have named negative tests that my sweep confirms are load-bearing. L1–L9 are all addressed. The owner decision is recorded, not implemented. The main merge lost nothing. Legitimate evidence still passes: the six-record set, a refusal with one or two re-prompts, and verified counts at both ends of the runtime's range are all accepted.

What remains is small and is the same class of finding as round-1 F1: this PR's own new `not_started` branch introduced three contract rules that no test pins, one of which is the "no owner authority without a verified step-up" invariant. Plus one Low robustness issue in the new audit-time bound.

---

## Round-1 findings

| # | Finding | Status | Evidence |
|---|---|---|---|
| **B1** (High) | Release audit accepts a waived inbound record; no cross-record `ownerCallerIdPolicy` comparison | **Fixed** | `voice-smoke.ts:692-700`: every owner-path scenario must carry `ownerCallerIdPolicy: "passphrase_always"`, and `inbound` must be `ownerStepUpOutcome: "verified"`. Probes P07–P13: the round-1 mixed-policy set, a waived inbound substituted into a good set, a refusal under `waive_on_passed_a`, the whole owner path under `waive_on_passed_a`, a seventh waiver record (7 records), a waiver replacing the failure record, and a non-verified inbound are **all REJECTED**. The waiver is retained as a per-record shape only (P06 accepted by `validateEvidence`, rejected by the audit). Mutation `A-audit-policy-passphrase-always` is **killed** by a named test. |
| **S1** (Medium) | `fixedRefusalSentToProvider`, `cleanEndFrameSent`, `ownerAlertCount` not derivable per call | **Fixed** | Fields removed (`voice-smoke.ts:184-201`). Replacements are each backed by durable state: `rejectionRowCount` ← `owner_call_step_up_rejections` (PK `session_id`, immutable, delete-forbidden, `0018:65-70`); `rejectionDeliveryRowCount` ← `owner_call_step_up_rejection_deliveries` (same shape, `0021:10-14`, `133-143`); `ownerAlertDisposition` ← the alert row's `last_sent_at` (`0018:89-102`) compared with this session's `delivered_at`. `call-session-do.ts:1227-1236` calls `alert()` then `recordRejectionDelivered()` with the **same** `observedAt`, and both write `iso(now)` (`owner-call-step-up.ts:489`, `:379-389`), so `last_sent_at = delivered_at` ⟺ this call's alert was sent. No repo grep finds the three removed names outside the historical AGENT_LOG. Mutations `N-rejection-delivery-row-count` and `N-alert-disposition-sent` are both **killed** by a named test. KNOWN_ISSUES.md:120-129 records the deferred per-session `refusal_sent` / end-mode / alert-disposition runtime work and says it needs a migration. |
| **F1 / V03** | Outbound `callerIdAttestation` other than absent unpinned | **Fixed (and corrected)** | The rule was replaced by the correct binding value: outbound must be `not_applicable` (`voice-smoke.ts:337`), matching `0018:128-130` and `outbound.ts:432,455`. Named test "requires outbound owner evidence to use the not_applicable attestation binding". Mutation **killed**. P14/P15: outbound with `absent` or `passed_a` rejected. |
| **F1 / V11** | Refusal `terminalState` other than rejected unpinned | **Fixed** | `voice-smoke.ts:494`; named test "requires refused owner step-up to end in the rejected terminal state". Mutation **killed**. P16 rejected. |
| **F1 / V12** | Refusal `authenticatedTurns > 0` unpinned | **Fixed** | `voice-smoke.ts:495`; named test "requires refused owner step-up to have zero authenticated turns". Mutation **killed**. P17 rejected. |
| **F1 / V22** | `outbound-no-answer` with non-zero prompts/attempts unpinned | **Fixed** | `voice-smoke.ts:480-482`; named test "rejects outbound no-answer evidence if owner step-up started". Mutation `F1-V22-no-answer-outcome` **killed**. P18/P19 rejected. |
| **F1 / V25** | Schema 1.2 record carrying 1.3 fields unpinned | **Fixed** | Named test "rejects schema 1.2 records carrying the schema 1.3 fields". Mutation **killed**. P20 rejected. |
| **L1** | Refusal pinned to 3/3; no rejection reason | **Fixed** | `voice-smoke.ts:497-500`: `attemptCount === 3`, `repromptCount` 0–2, `promptCount === 3 + repromptCount`, `rejectionReason === "attempts_exhausted"`. P21/P22: prompts 4 with 1 re-prompt and prompts 5 with 2 accepted. P23/P24: `deadline_expired` and `reprompts_exhausted` rejected. Both bounds are real: `attempts_exhausted` is written by the `0018:334-339` trigger on the third mismatched attempt, and a third re-prompt instead produces `reprompts_exhausted` (`0018:378-384`), so 0–2 is exactly the reachable range. Three mutations **killed**. |
| **L2** | Verified counts accept impossible pairs | **Fixed** | `voice-smoke.ts:371-372`. P26/P27 reject prompts 1/attempts 3 and prompts 5/attempts 1; P28/P29 accept prompts 3/attempts 1 and prompts 5/attempts 3. Both mutations **killed**. |
| **L3** | Audit accepts shared correlation IDs and event IDs | **Fixed** | `voice-smoke.ts:683-690`. P30/P31 rejected. Both mutations **killed**. |
| **L4** | No time plausibility checks | **Fixed** | `voice-smoke.ts:506` (refusal ≤ 5 min) and `:691` (no `startedAt` after audit time). P32/P34/P35 rejected; P33 (4 m 59 s) accepted. Mutation **killed**. |
| **L5** | Labels do not match the runtime binding | **Fixed** | `not_started` outcome added for no-answer (`:351-359`, `:480`); outbound mirrors `passphrase_always` / `not_applicable` (`:337`, `:363`). P37–P39 reject a no-answer claiming `refused`, the waiver policy, or an outbound waiver. |
| **L6** | No failed-attempt ledger | **Fixed (recorded)** | KNOWN_ISSUES.md:137-141 and runbook `:371` ("a failed paid scenario remains a stop-and-review event rather than permission to retry"). |
| **L7** | Gate omits the #46 test groups | **Fixed** | `scripts/voice-release-gate.mjs:15,18,24` and the matching gate test. All three paths exist at `407af7d`. |
| **L8** | Dropped assertions and removed per-scenario loop | **Fixed** | Named tests "rejects the retired schema 1.1 contract" and "rejects guest_pin authentication for owner evidence" restored; the loop is back at `:703-705`. It is load-bearing as defence in depth — see the survivor verdicts. |
| **L9** | Manifest plan lists five voice keys | **Fixed** | `docs/superpowers/plans/2026-08-29-jarvis-telegram-memory-release.md:1065,1070,1075` adds `owner_step_up_refused` and the note that aggregation must derive keys from `VOICE_SMOKE_SCENARIOS`. |
| **Owner decision** | Answered outbound call that fails step-up | **Recorded, not implemented** | KNOWN_ISSUES.md:131-136 states Sid has not required it, that adding `outbound-step-up-refused` costs another paid call, and that it waits for his explicit decision. No scenario was added; `VOICE_SMOKE_SCENARIOS` is still six. Correct. |

**Main merge `31f1f57`.** Nothing lost. `docs/AGENT_LOG.md` has 225 headings against 221 on `1243390` and 223 on main `4262024`; the diff each way shows only the other side's entries added, and both #54 entries and all four #55 entries survive. `KNOWN_ISSUES.md` at the merge is byte-identical to `1243390` and differs from main only by the new section. No migration anywhere in `origin/main...407af7d`.

---

## The six survivor claims

I could not locate the builder's expanded 41-mutation spec: `N41` appears nowhere in the repo at `407af7d` or on `claude/reviewer-tools`. **I therefore cannot confirm or refute the `N41` claim** — its mutation text is unverifiable from here. I ran my own 34-mutation sweep instead, covering every guard the fix added or kept, and tested each survivor by removing the guard and re-running the input it blocks.

| Claim | My verdict | Proof |
|---|---|---|
| **V04** waiver inbound-only | **Behaviour-equivalent. Claim upheld.** | With the guard removed, an outbound-answer record claiming `waived_passed_a` is still **REJECTED**: the waiver branch needs `callerIdAttestation: "passed_a"` while `:337` requires outbound to be `not_applicable`. The two cannot both hold. |
| **V05** waiver needs authority | **Behaviour-equivalent. Claim upheld.** | With the guard removed, a waived inbound with `ownerAuthorityGranted: false` is still **REJECTED** by `:334` (`ownerAuthorityGranted !== claimsOwnerAuthority`), since `validateInbound` passes `claimsOwnerAuthority = true`. |
| **V08** verified prompt minimum 1 | **Behaviour-equivalent. Claim upheld.** | With the bound relaxed to 0, a verified record with 0 prompts and 1 attempt is still **REJECTED** by the new L2 clause `attemptCount > promptCount` (`:371`). The L2 fix is what makes this survivor benign; it was not benign before. |
| **V13** refusal outcome | **Behaviour-equivalent. Claim upheld.** | With the guard removed, all three alternative outcomes are still **REJECTED**: `verified` and `waived_passed_a` both require `claimsOwnerAuthority`, which is `false` for the refusal record; `not_started` requires `direction === "outbound"` while the refusal validator passes `"inbound"`. |
| **V22** no-answer zero prompts | **Behaviour-equivalent. Claim upheld — and the round-1 gap is genuinely closed.** | With the two count lines removed, a no-answer record with 2 prompts and 2 attempts is still **REJECTED**, because the separately added `ownerStepUpOutcome !== "not_started"` check (`:480`, killed by its own named test) forces the `not_started` branch, which requires both counts to be 0 (`:357-358`). The rule is now pinned twice over; it was pinned zero times in round 1. |
| **N41** | **Unverifiable.** | The mutation is not published. Neither "implied" nor "real gap" can be asserted. See N3 below: my own sweep found three unpinned rules, so a 41-mutation sweep reporting six behaviour-equivalent survivors is not by itself evidence that nothing is unpinned. |

**Additional survivors from my own sweep that are genuinely implied** (no finding): `N-not-started-outbound-only` (an inbound refusal claiming `not_started` is still blocked by the `refused` check), `N-not-started-zero-counts` (`validateOutboundNoAnswer:481-482` re-checks both counts), `A-audit-inbound-verified` (a waived inbound is already blocked by the policy check, and no other inbound outcome is constructible — pure defence in depth), and the pair `A-audit-per-scenario-loop` / `A-audit-scenario-set-size`, which each imply the other. That pair is exactly the L8 redundancy I asked for, and it works: removing either one leaves duplicate-plus-missing rejected.

---

## New findings

### M1 (Medium). The new `not_started` branch is the only thing stopping an answered outbound call from claiming owner authority with no step-up, and no test pins it

**Where:** `tests/acceptance/live/voice-smoke.ts:351-359`, specifically `:354` `|| claimsOwnerAuthority`.

**Concrete input (probe, REJECTED today, ACCEPTED with only that line removed):**

```
{ ...outbound-answer record,
  ownerStepUpOutcome: "not_started",
  ownerStepUpPromptCount: 0,
  ownerStepUpAttemptCount: 0,
  ownerAuthorityGranted: true,
  ownerStepUpBeforeFirstModelTurn: true }
```

`validateOutboundAnswer` (`:456-469`) pins terminal state, turn counts, greeting and disclosure, but never the step-up outcome, so the whole invariant for this branch rests on `:354`. My sweep ran the full 50-test file against that single-line mutation: **all 50 tests still pass**.

**Consequence.** This PR introduced the `not_started` outcome. The rule "no owner authority without a verified step-up" is the central security claim of the whole passphrase design, and the other branches do have tests pinning it (mutations V01 and V10 were killed in round 1). The new branch has none, so a later edit to this branch can silently grant owner authority to an answered outbound call with zero phrase prompts and no test will notice. Nothing is wrong at `407af7d`; this is a coverage regression introduced by the PR's own new code, the same class as round-1 F1.

**Fix.** Keep the guard; add the named negative test.

**Pinning test.** In `voice-smoke.test.ts`, alongside the existing outbound tests:

```
it("rejects an answered outbound call granted owner authority with no step-up", () => {
  expect(() => validateEvidence({
    ...outboundAnswerEvidence,
    ownerStepUpOutcome: "not_started",
    ownerStepUpPromptCount: 0,
    ownerStepUpAttemptCount: 0,
  })).toThrow(/^unsafe_or_incomplete_evidence$/u);
});
```

### L1 (Low). Inbound evidence may not use the outbound-only `not_applicable` attestation, and no test pins that either

**Where:** `tests/acceptance/live/voice-smoke.ts:338`.

**Concrete input (REJECTED today, ACCEPTED with that line removed, all 50 tests still passing):** `{ ...inboundEvidence, callerIdAttestation: "not_applicable" }`.

**Consequence.** `not_applicable` is the binding value for outbound owner calls and for activation-only or guest sessions (`0018:118-130`, `inbound.ts:405-407`). An inbound release record carrying it would be evidence from a session where caller-ID classification never applied — that is, not the inbound owner path the gate is certifying. Low, because the record is refused today and the mirror rule at `:337` is tested.

**Fix.** Keep the guard; add the test.

**Pinning test.** `expect(() => validateEvidence({ ...inboundEvidence, callerIdAttestation: "not_applicable" })).toThrow(/^unsafe_or_incomplete_evidence$/u);` — one line inside the existing "not_applicable attestation binding" test.

### L2 (Low). An invalid audit time silently disables the new `startedAt` bound

**Where:** `tests/acceptance/live/voice-smoke.ts:672-673` and `:691`.

**Concrete input (REJECTED today, ACCEPTED with `:673` removed):** `auditVoiceEvidence(sixRecordsDated2099, new Date("nonsense"))`. With `auditTimeMs` as `NaN`, `Date.parse(startedAt) > NaN` is always `false`, so the whole time bound becomes a no-op and a set dated 2099 passes. No test pins `:673`; all 50 pass with it removed.

**Consequence.** Small today: the only production caller is `voice-smoke-cli.mjs:50`, which passes no argument and gets `new Date()`. It matters as soon as anything passes a parsed timestamp, and it is the kind of silent no-op that makes a guard look present while doing nothing.

**Fix.** Keep the check; add the test.

**Pinning test.** `expect(() => auditVoiceEvidence(completeEvidenceSet, new Date("nonsense"))).toThrow(/^release_voice_evidence_incomplete$/u);`

### L3 (Low). The audit rejects legitimate evidence if the operator's clock is behind the cloud clock

**Where:** `tests/acceptance/live/voice-smoke.ts:691`, reached from `tests/acceptance/live/voice-smoke-cli.mjs:50`, which calls `auditVoiceEvidence(records)` with the default `auditTime = new Date()`.

**Concrete input (probe P43, REJECTED):** the legitimate six-record set audited with an audit time one second before the newest record's `startedAt`.

**Consequence.** `startedAt` comes from the cloud gateway; the audit's `new Date()` comes from Sid's Windows PC. Any negative skew between them larger than the gap between the last call and the audit run turns a good release set into `release_voice_evidence_incomplete` with no diagnostic distinguishing it from tampered evidence. The failure is closed, not open, so this is a usability and diagnosis problem rather than a security one. **Estimate:** how often this bites depends on the PC's time sync, which I cannot measure from here; the mechanism is proven by probe.

**Fix.** Allow a bounded skew — compare against `auditTimeMs + 5 * 60_000`, or bound `startedAt` against a generous absolute ceiling instead of the wall clock. Round-1 L4's intent was to reject a 2099 date, which a 5-minute tolerance still does.

**Pinning test.** A record started 1 minute after the audit time is accepted; a record started 2099 is rejected.

### L4 (Low, operational, no code change). A refusal that ends any way other than three wrong candidates costs another paid call

**Where:** `tests/acceptance/live/voice-smoke.ts:497,500`; runbook `docs/runbooks/voice-smoke.md:350-359`.

The refusal record requires `attemptCount === 3` **and** `rejectionReason === "attempts_exhausted"`. Both other reachable reasons are refused (probes P23/P24). If the live refusal call ends through a third re-prompt (`reprompts_exhausted`, `0018:378-384`) or through the 60-second window expiring (`deadline_expired`), the retained evidence is invalid and the scenario has to be re-run at cost. This is the correct strict reading and the runbook does tell the operator to give three complete wrong candidates, but combined with L6's absence of a failed-attempt ledger it is worth one sentence in the runbook so the operator knows *why* a re-run is needed and that the re-run is a stop-and-review event.

---

## Checked and sound

- **No behavioural regression on legitimate evidence.** Probes P01–P05: the six-record set and each owner-path record still validate. P21/P22, P28/P29, P33: a refusal with one or two re-prompts, verified counts at both ends of the runtime's `attempts ≤ prompts ≤ attempts + 2` range, and a 4 m 59 s refusal are all accepted. The stricter audit refuses nothing the runtime actually writes.
- **New values match the runtime and the schema.** `not_applicable` for outbound matches `0018:128-130` and `outbound.ts:432,455`; inbound keeps a real attestation class from `classifyOwnerAttestation`. `attempts_exhausted` is in the `0018:68` CHECK and is genuinely produced by the `0018:334-339` trigger on the third mismatched attempt, with `#deliverOwnerStepUpRejection` passing `alreadyDurable = true` on that path so `expire()` cannot overwrite the reason with `deadline_expired`. `ownerStepUpRepromptCount` 0–2 is exactly the range a non-rejected session can reach. `promptCount = attempts + reprompts` is derivable from two count queries. No new field contradicts a CHECK constraint.
- **The alert derivation fails closed.** If a later owner rejection moves `last_sent_at` past this session's `delivered_at`, the query yields `coalesced` and the evidence is refused — it cannot manufacture a passing `sent`. **Estimate:** no query adapter exists yet, so this is my reconstruction of what an honest adapter computes; the storage facts it rests on are proven from `0018`, `0021` and the two call sites.
- **Per-scenario loop and size check.** Restored at `:703-705`; the loop and `scenarios.size` each independently reject duplicate-plus-missing, so L8's defence in depth is real rather than decorative. Seven records and a waiver substituted for a required scenario are both rejected (P11, P12).
- **The 15-minute separation is documented** at runbook `:359`, matching the coalescing window in `owner-call-step-up.ts:489`.
- **Test suite parity.** The PR's own tests pass at `407af7d` under an independent runner: 50/50 and 16/16, which is the builder's 66.
- **Redaction unchanged.** The two new refusal fields are a bounded integer and a two-value enum; `exactRecord` still pins the key set exactly, so no free-text field was introduced.
- **No migration, no scenario added, no owner decision pre-empted.**

Checked and sound.
