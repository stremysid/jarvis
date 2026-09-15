# PR #54 adversarial review: owner step-up live evidence

- **PR:** ksid1229-ops/jarvis #54, `codex/r1-step-up-release-evidence`
- **Head:** `bf16699` (code head `fc9e773`), based on main `1cae97b`, no migration
- **Reviewer:** Claude Opus 5, cross-vendor second review, max depth, read-only
- **Method:**
  - Read the full diff and each follow-up commit (`117ec3a`, `69bbad0`, `9a918fc`, `fc9e773`).
  - Read the validator, driver, store, CLI and release gate in full.
  - Checked the evidence contract against the merged runtime: `call-session-do.ts`, `owner-call-step-up.ts`, migrations `0018`/`0021` and `voice-callbacks.ts`.
  - Checked the passphrase design spec and research §6.7.
  - Ran 22 probes against the exact `bf16699` `voice-smoke.ts` (`scratchpad/pr54/probe.mjs`, node 24).
  - Placed no calls, did no deploy, touched no secrets, and made no repo change.

## Verdict

**CHANGES REQUESTED.** 1 High, 2 Medium, 9 Low.

The scenario-set arithmetic, the single-commit binding, the driver's correlation binding, exact-key redaction and fail-closed parsing all hold. The problems are in what the six records prove:

- A release set can pass with no live inbound phrase verification.
- The configuration can differ between records.
- The refusal record's delivery fields cannot be observed per call from what the runtime stores.
- The outbound refusal path has no live evidence.

---

## High

### H1. A waived or mixed-policy evidence set passes the v1.0 gate with no live inbound phrase verification

**Where**
- `tests/acceptance/live/voice-smoke.ts:339-348`: `waived_passed_a` is accepted for `inbound`.
- `:652-667`: `auditVoiceEvidence` has no check that the records agree with each other.
- `:329-333`: `ownerCallerIdPolicy` is checked per record only.
- Runbook `docs/runbooks/voice-smoke.md:330-340` and `NEXT_STEPS.md:194-199` document this as accepted.

**Input (probe, ACCEPTED by `auditVoiceEvidence`)**
- `inbound` with `authenticationMode: "owner_attested_waiver"`, `ownerStepUpOutcome: "waived_passed_a"`, 0 prompts, 0 attempts, `callerIdAttestation: "passed_a"` and `ownerCallerIdPolicy: "waive_on_passed_a"`.
- `owner-step-up-refused` with `ownerCallerIdPolicy: "passphrase_always"` and `callerIdAttestation: "passed_a"`.
- The other four records unchanged, all with the same `commitSha`.

**Scenario**
- Research §6.8 says to enable the waiver only if every one of Sid's calls reads `passed_a`.
- With the waiver on, Sid's phone cannot produce `owner-step-up-refused`: `:352` correctly rejects a refusal under passed_a plus waiver.
- So the operator flips `OWNER_CALLER_ID_POLICY` to `passphrase_always` for that one call.
- The commit SHA is unchanged, because the policy is an environment value read at runtime composition (`production-routes.ts:57-68`), not part of the commit.
- The audit then accepts a set recorded under two different configurations.

**Consequence**
- Sid decided the waiver must "exist but ship switched off" (spec `2026-09-14-owner-call-passphrase-design.md:13-16`, `:153-157`, "initial deployment uses `passphrase_always`").
- The gate can still certify v1.0 with no live proof that the inbound step-up prompts, verifies and mints authority. In a waived inbound call the phrase path never runs.
- The only live phrase verification would be outbound. That is a different route (`voice-route-construction.ts:96-97` vs `:110-111`) with a different binding branch (`0018:128-138`).
- Nothing records that Sid accepted the SIM-swap and attestation risk the spec requires before enabling (spec `:20-23`).
- Not reachable by an attacker. This is a release-contract hole that needs a deliberate configuration flip.

**Fix**
- In `auditVoiceEvidence`, require every owner-path record (`inbound`, `outbound-answer`, `outbound-no-answer`, `owner-step-up-refused`) to carry `ownerCallerIdPolicy: "passphrase_always"`.
- Require `inbound` to be `ownerStepUpOutcome: "verified"`.
- If Sid later enables the waiver, add a separate optional seventh `owner-attested-waiver` record (as research §6.7 proposed). Do not let it replace the verified inbound record.
- Minimum acceptable alternative: one policy value across the whole set, plus a verified inbound record whenever the policy is `waive_on_passed_a`.

**Pinning tests**
- The audit rejects the mixed set above.
- The audit rejects a set whose inbound record is `waived_passed_a`.
- The audit rejects a set where any two owner-path records disagree on `ownerCallerIdPolicy`.
- Existing per-record waiver tests (`voice-smoke.test.ts` "accepts only the explicit inbound Passed-A waiver…") can stay as validator tests. They must not imply release acceptance.

---

## Medium

### M1. Three refusal-record fields cannot be observed per call from what the runtime stores

Affected fields: `ownerAlertCount`, `fixedRefusalSentToProvider`, `cleanEndFrameSent`.

**Where**
- The validator requires them: `voice-smoke.ts:486-489`.
- The runtime delivery path is `apps/cloud-gateway/src/voice/call-session-do.ts:1217-1236`.
- Tables: alert table `0018_owner_call_step_up.sql:89-102`, delivery row `0021_voice_owner_delivery.sql:10-14`, relay-ended record `voice-callbacks.ts:157-177`.

**Observed runtime facts**
- **Refusal line.** `sendNeutralText(OWNER_STEP_UP_REJECTED)` failure is swallowed (`:1217-1218`). No durable row says the refusal was sent.
- **End frame.** A `relay.end()` failure falls back to `close(1008)` (`:1219-1226`). `recordRejectionDelivered` then writes the same `owner_call_step_up_rejection_deliveries` row either way (`:1236`). The relay-ended callback record stores `endpointKind, callSid, sessionId, sessionStatus, sessionDurationSeconds, requestHash`, but not the handoff data. A clean end and a policy-close fallback look identical in D1.
- **Owner alert.** Alerts are keyed `(owner_principal_id, alert_class, direction)` with no `session_id`. The first alert is sent; later alerts inside 15 minutes are coalesced into `observation_count` with no Telegram send (`owner-call-step-up.ts:481-543`). An alert cannot be attributed to a correlation ID.

**Scenario**
- The first `owner-step-up-refused` run fails validation, for example on L1's prompt count.
- The operator cleans up and re-runs within 15 minutes.
- The second rejection is coalesced, so zero alerts are sent for that call.
- An aggregate query that reports `ownerAlertCount: 1`, from `observation_count` or from the row existing, is asserting something it did not observe. An honest query cannot produce a passing record.
- The same applies if an unrelated inbound rejection (a spoof call or practice) happened in the previous 15 minutes.

**Consequence**
- The retained refusal record claims delivery facts the evidence query cannot derive from durable per-session state. Either the query adapter makes them up (untrustworthy evidence), or legitimate evidence is refused.
- No query adapter exists yet, so what a future adapter would compute is an **estimate**. The storage gap itself is proven from the schema and code above.

**Fix**
- Option 1 (runtime follow-up, needs a migration, so not this PR): per session, record `refusal_sent` (bool), `end_mode` (`end` | `policy_close`) and `alert_disposition` (`sent` | `coalesced`, linked to the session). The evidence fields are then derived from those.
- Option 2 (this PR): rename the fields to what is observable, for example `rejectionDeliveryRowCount: 1` and `ownerAlertDisposition: "sent" | "coalesced"`. Document in the runbook that the refusal scenario must run at least 15 minutes after any previous owner rejection alert.

**Pinning test**
- A fake-harness test derives the refusal evidence from D1 plus recorded callbacks.
- Case (a): `relay.end` throws, which must yield `cleanEndFrameSent: false`.
- Case (b): a second rejection within 15 minutes, which must not yield a passing `ownerAlertCount: 1`.

### M2. The outbound step-up refusal path has no live evidence

**Where**
- `voice-smoke.ts:491` hard-codes `validateOwnerStepUp(evidence, "inbound", false)` for `owner-step-up-refused`.
- `:466-467` requires zero prompts and attempts for `outbound-no-answer`.
- `VOICE_SMOKE_SCENARIOS` `:7-14`.
- Runbook `:346`: "an inbound owner-path call".

**Scenario**
- An outbound owner call is answered by voicemail or by someone other than Sid. This is the threat the phrase exists to cover (spec `:64-66`, "an answering machine that accepts an outbound call").
- It goes through the outbound TwiML route and step-up dependencies, and alerts with `direction: "outbound"` and no attestation.
- It ends by timeout or reprompt exhaustion.
- None of the six records exercises it. Research §6.7 expected `outbound-no-answer` to cover voicemail hearing the step-up prompt. This PR pins that record to zero prompts, a true no-answer, which removes that coverage.

**Consequence**
- v1.0 can be released with no live proof that an answered outbound call refuses without disclosure, model call or context read.
- This is the open item in the reviewer memory "R1 outbound voicemail gap".
- The spec's rollout list (`:391-393`) names only `owner-step-up-refused`, so this is a coverage gap against the spec's security claim, not a literal spec violation.

**Fix**
- Add an `outbound-step-up-refused` scenario: answered outbound, no correct phrase, rejected by attempts, reprompts or deadline, with 0 authenticated turns, 0 model requests, 0 context reads, `purposeDisclosed: false` and the fixed refusal. Or accept both directions for the refusal record and require both in the audit.
- This adds a paid live call, roughly one minute of ConversationRelay at list price. Confirm with Sid before making it a gate requirement.

**Pinning test**
- The audit rejects a set that lacks the outbound refusal record.
- The validator rejects an outbound refusal record with `purposeDisclosed: true` or `modelRequests > 0`.

---

## Low

### L1. Refusal counts are pinned to 3 and 3, which rejects legitimate refusals and ignores the rejection reason

**Where:** `voice-smoke.ts:481-483`. Compare `:357-358` (verified accepts 1-5 prompts after `fc9e773`).

**Legitimate evidence rejected (probe)**
- In the runtime, prompts = 1 initial + 2 mismatch retries + 0-2 "Please say only your passphrase." re-prompts (`call-session-do.ts:1246-1261`, `owner-call-step-up.ts:247-257`, reprompt ordinal 3 rejects).
- So three wrong phrases with one speech-to-text split gives prompts 4, attempts 3, which is REJECTED.
- This is the same counting that `fc9e773` used to allow up to 5 prompts for verified calls. The two rules contradict each other.

**Wrong-reason evidence not distinguished**
- The record has no rejection-reason field.
- `0018:386-413` permits `reason = 'deadline_expired'` whenever `rejected_at >= deadline_at`, whatever the attempt rows say.
- A deadline alarm firing while the third attempt's 600k-iteration verification is in flight gives 3 attempt rows and a `deadline_expired` rejection. Counts of 3 and 3 would still pass.
- Disabled-verifier rejections go to a separate `owner_call_step_up_disabled_rejections` table (`0021:4-8`), so `rejectionRowCount` is ambiguous about which table it counts.
- The timing race is an **estimate**. The schema allowing that state is proven.

**Fix**
- Add `ownerStepUpRepromptCount` (0-2) and require `promptCount === 3 + repromptCount`.
- Add `ownerStepUpRejectionReason: "attempts_exhausted"`.
- Define `rejectionRowCount` as the count of `owner_call_step_up_rejections` rows only.

**Pinning tests:** prompts 4 with reprompts 1 is accepted; any reason other than `attempts_exhausted` is rejected.

### L2. Verified count combinations are not checked for consistency

**Where:** `voice-smoke.ts:354-359`.

**Input (probe, both ACCEPTED):** prompts 1 with attempts 3, and prompts 5 with attempts 1. The runtime cannot produce either. Its invariant is `attempts <= prompts <= attempts + 2`.

**Consequence:** a buggy or invented query result passes.

**Fix:** enforce the invariant.

**Pinning test:** both inputs above are rejected; prompts 3 with attempts 3 is accepted.

### L3. The audit does not require distinct correlation IDs or event IDs across records

**Where:** `voice-smoke.ts:652-663`.

**Input (probe, ACCEPTED):** all six records carry `correlationId: 01j00000000000000000000000`. Separately, the refusal record reuses the inbound record's correlation ID and event ID.

**Consequence**
- One call, or one query result, can back several records. `unauthorized-caller` and `owner-step-up-refused` are both `rejected` with zero turns.
- The driver binds each record to its own receipt, but the audit is what runs over retained files.
- This existed before the PR; the new scenario widens it.

**Fix:** require six distinct `correlationId` values and pairwise-disjoint `eventIds`.

**Pinning test:** the two sets above are rejected.

### L4. No time plausibility checks

**Where:** `voice-smoke.ts:314-316`.

**Input (probe, ACCEPTED):**
- A refusal call lasting 3 hours, against a 60-second step-up window.
- A refusal dated 2099.

**Consequence:** timestamps prove nothing beyond start-before-end. This existed before the PR for the other records.

**Fix**
- For `owner-step-up-refused`, bound `endedAt - startedAt` (for example 5 minutes or less, since the window is 60 s plus setup).
- In the audit, reject any `startedAt` later than the audit time.

**Pinning test:** both inputs are rejected.

### L5. Policy, attestation and outcome labels do not match the runtime binding

**Where:** `voice-smoke.ts:329-336`. Test fixture `outboundAnswerEvidence` uses `ownerCallerIdPolicy: "waive_on_passed_a"`.

**Mismatches**
- The D1 binding for outbound owner calls is always `policy = 'passphrase_always'` and `attestation_class = 'not_applicable'` (`0018:128-130`).
- The validator accepts outbound records claiming `waive_on_passed_a` (probe: `outbound-no-answer` ACCEPTED) and requires `absent` rather than `not_applicable`.
- The runbook (`:330-332`) calls this "the configured caller-ID policy", meaning the environment value, not the binding.
- `outbound-no-answer` is labelled `ownerStepUpOutcome: "refused"` and `authenticationMode: "owner_passphrase"` although no step-up ever started.

**Consequence:** the query adapter has to translate values, and that translation is where H1's mixed-policy records come from.

**Fix**
- Evidence mirrors the binding values.
- Use a `not_started` outcome for a no-answer call.
- Or, at minimum, require outbound records to report `passphrase_always`.

### L6. The fix loop for a failed scenario is unbounded

**Where:**
- `runVoiceSmoke` in `voice-smoke.ts:607-650` keeps no ledger of failed runs.
- `cleanupVoiceEvidence` `:669-679` removes all six files.
- Runbook `:310-311` and `:362` ("run each scenario once") is the only control.

**Scenario:** re-run `inbound` until the p95 latency happens to pass, or re-run the refusal until an alert happens to be sent (see M1). Failed paid attempts leave no retained trace.

**Consequence:** a "lucky pass" cannot be detected. This existed before the PR.

**Fix**
- A retained attempt ledger (receipt per execution) that the audit reads.
- Or have the query adapter report the number of owner step-up sessions in the release window, and require it to match.

### L7. The release gate's fake stage leaves out the #46 step-up unit tests

**Where:** `scripts/voice-release-gate.mjs:5-27`.

**Detail**
- Included through the `tests/acceptance/fake/voice-` prefix: `tests/acceptance/fake/voice-owner-*`.
- Not included: `apps/cloud-gateway/test/voice/owner-call-step-up-alert.test.ts`, `test/persistence/owner-call-step-up-migration.test.ts` and `test/http/owner-passphrase-routes.test.ts`.
- These were inherited from #46 and are not changed here. They are relevant because this PR claims to expand the gate.

**Fix:** add them to the filter list and to `scripts/test/voice-release-gate.test.mjs`.

### L8. Two existing assertions were dropped, and one guard now depends on the validator's default branch

**Dropped tests**
- On main, `voice-smoke.test.ts:208-209` ("rejects the retired schema 1.1 contract") and `:202` (`authenticationMode: "guest_pin"` rejected for owner records) were deleted.
- Behaviour is unchanged (anything other than `"1.3"` or `owner_passphrase` is rejected), but no test pins it now.

**Removed per-scenario loop (`9a918fc`)**
- It is sound today.
- `records.length === 6`, `validateEvidence`'s closed `switch` rejects unknown scenarios (`:540-541`), and 6 distinct known values out of 6 means all six are present.
- The probe confirms duplicate-plus-missing, seven records and five records are all REJECTED.
- The new test at `voice-smoke.test.ts:595-602` kills a mutation that removes the size check.
- It is fragile: adding a `case` for a scenario that is not in `VOICE_SMOKE_SCENARIOS` would silently weaken the audit.

**Fix:** restore both assertions and the explicit `for … if (!scenarios.has(scenario))` loop as defence in depth.

### L9. The release-manifest plan still lists five voice keys

**Where:** `docs/superpowers/plans/2026-08-29-jarvis-telegram-memory-release.md:1065`, `:1070`. `REQUIRED_EVIDENCE` and `live` omit `owner_step_up_refused`.

**Consequence:** the later manifest tool, if built from the plan, would not require the sixth record.

**Fix:** update the plan, or add a note that manifest aggregation must use `VOICE_SMOKE_SCENARIOS`.

---

## Checked and sound

- **Scenario-set completeness.** Exactly six records, each validated, six distinct known scenarios, one `commitSha`. Probes reject duplicate-plus-missing (length 6), seven records, five records and the retired 1.2 five-record set.
- **Unknown scenarios and extra keys.** `validateEvidence` `default: unsafe()`. `exactRecord` requires a plain `Object.prototype` object, string own keys equal to the field list, and enumerable data descriptors. A JSON own key `__proto__` is rejected (probe). A duplicate JSON key resolves last-wins before validation and has no redaction effect.
- **Fail-closed parsing.** The CLI audit reads fixed filenames only, and any `JSON.parse` or validation error becomes `release_voice_evidence_incomplete` with exit 2 (`voice-smoke-cli.mjs:44-56`). The gate stops before the audit if the fake stage fails.
- **Correlation binding in the driver.** Preflight proof, then receipt (`scenario` plus ULID `correlationId`), then query with exactly `{scenario, deployedCommitSha, correlationId}`. The returned evidence is JSON-snapshotted, validated, frozen, and checked for scenario, commit and correlation equality (`voice-smoke-driver.ts:128-164`). `runVoiceSmoke` re-validates and re-checks the scenario.
- **No overwrite or reuse.** `exists` is checked before running. The store uses `open(wx)`, a digest-checked `link` that fails on `EEXIST`, and the temporary name is scenario-bound. The sixth name was added in three places consistently (store regexes, CLI `evidencePath`, cleanup).
- **Redaction.**
  - The refusal record is booleans, integers, fixed enums, ULIDs, SHA and UTC timestamps only. No free-text field can carry passphrase words, phone numbers, transcripts, SIDs or secrets.
  - Evidence files are ignored by `tests/acceptance/live/evidence/.gitignore` (`*`).
  - The secret list adds only a presence flag for `OWNER_PASSPHRASE_PEPPER_V1`, never a value.
- **Waiver per record.** `waived_passed_a` requires inbound, `passed_a`, `waive_on_passed_a`, `owner_attested_waiver`, 0 and 0, and authority. It is rejected for outbound. A refusal under passed_a plus waiver is rejected, matching the D1 binding guard `0018:131-137`. Owner authority always requires `ownerStepUpBeforeFirstModelTurn: true`. The set-level problem is H1.
- **Refused versus authority.** A `refused` outcome with `ownerAuthorityGranted: true`, or `verified` without authority, is rejected on every owner-path validator.
- **Executable discovery.** No driver discovery from PATH or environment. The gate spawns `process.execPath` with fixed arguments and `shell: false`. Unchanged by this PR.
- **The `fc9e773` retry relaxation.** The bounds (1-5 prompts, 1-3 attempts) match the runtime maximum for verified calls. No partial authority exists before a match, because the D1 match trigger commits the receipt, authority and phase atomically (`call-session-do.ts:1265-1268`). The missing consistency check is L2.
- **Other test changes.** The rest of the test diff strengthens coverage: the refusal negative table, the no-answer model and context checks, the legacy five-set rejection, and the runtime adapter-order test.
- **Runbook deletion.** The runbook removed "push" from the "deliberately not executed" list. That does not change any gate behaviour.
