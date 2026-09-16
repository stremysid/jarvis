## 2026-09-15 22:40 UTC — Claude Opus 5, PR #54 max review at bf16699: changes requested

This review covers the R1 live-evidence contract at `bf16699` (code `fc9e773`), based on main `1cae97b`. It adds no migration.

**Local checks on bf16699** (Windows 11, `jarvis-pr39`):
- lint, typecheck and `typecheck:voice-access` pass;
- `pnpm test` passes 3,280/3,280 with 0 timeouts;
- `pnpm test:voice-access` passes 35 files / 874 tests.

**Mutation pass** (`reviewer-tools/pr54/mut54.json` and `run54.txt`, one change per run, every anchor unique). `BASE` passes, and 22 of 29 mutations are killed by named tests, with 0 timeouts. Killed:
- the waiver guards (inbound-only, zero prompts, no waiver while the policy applies);
- verified prompt and attempt minimums, and step-up before the first model turn;
- all six refusal delivery and count checks;
- no-answer model and context reads;
- the audit record count and single commit;
- the owner-passphrase pepper presence check and the sixth store name.

Two survivors can't change behaviour:
- **V05:** `!claimsOwnerAuthority` inside the waiver branch. Every caller passing `false` is outbound or requires `refused`.
- **V13:** the refusal record's `ownerStepUpOutcome !== "refused"`. With authority `false`, the shared check already rejects `verified` and `waived_passed_a`.

Five survivors are real gaps (F1).

**F1. No test pins five contract rules.** A record breaking any of these still passes every test:
- **V11:** a refusal record with `terminalState` other than `rejected`.
- **V12:** a refusal record with `authenticatedTurns > 0`, an internally contradictory refusal.
- **V22:** an `outbound-no-answer` record with non-zero step-up prompts or attempts.
- **V03:** an outbound record with `callerIdAttestation` other than `absent`.
- **V25:** a record at `schemaVersion: "1.2"` carrying the 1.3 fields.

Add a named negative case for each (V03 changes if L5 mirrors the binding values).

**Sound:**
- **Six-record audit.** Removing the per-scenario loop is sound. `records.length === 6`, and `validateEvidence` rejects unknown scenarios, so six distinct values must be all six. Duplicate-plus-missing, seven records, five records and the retired 1.2 set are all rejected.
- **Binding.** The single-commit binding holds, and so does the driver's correlation binding.
- **Record contents.** Records are exact-key with no free-text fields, so they can't carry passphrase words, numbers, transcripts or secrets.
- **Failure handling.** Parsing fails closed, and no driver is discovered from PATH.
- **Per-record waiver checks.** They match the `0018` binding guard.

**B1. The gate can certify v1.0 without a live inbound passphrase check, from records made under different caller-ID policies.**
- **Where:**
  - `validateOwnerStepUp` accepts `waived_passed_a` for `inbound`.
  - `auditVoiceEvidence` never compares `ownerCallerIdPolicy` across records.
  - The policy is a runtime environment value, not part of `commitSha`.
- **Proven:** the second reviewer's probe (`reviewer-tools/pr54/adversarial-probe.mjs`) passes the audit with this set:
  - a waived inbound record (`waive_on_passed_a`, 0 prompts);
  - an `owner-step-up-refused` record made under `passphrase_always`;
  - the other four records unchanged, same commit.
- **Why it matters:**
  - With the waiver on, Sid's phone can't produce the refusal record, so flipping the policy for that one call is the natural path.
  - Sid's decision is that the waiver exists but ships switched off, and the spec says initial deployment uses `passphrase_always`.
  - A release could pass with the inbound phrase path never run live.
- **Fix:**
  - Require `ownerCallerIdPolicy: "passphrase_always"` on every owner-path record, and `ownerStepUpOutcome: "verified"` on `inbound`.
  - Keep the per-record waiver validator for a later, separate, optional waiver record. Never let a waiver record replace verified inbound.
  - Add audit tests: the mixed set above, waived inbound, and two records that disagree on policy.

**S1. Three refusal-record fields claim facts the runtime never stores per call.**
- **Where:** `call-session-do.ts` `#deliverOwnerStepUpRejection`, `owner-call-step-up.ts:481-543`.
- **`fixedRefusalSentToProvider`:** a `sendNeutralText(OWNER_STEP_UP_REJECTED)` failure is swallowed, and nothing records that the refusal was sent.
- **`cleanEndFrameSent`:** a `relay.end()` failure falls back to `close(1008)`, and `recordRejectionDelivered` writes the same row either way.
- **`ownerAlertCount`:** alerts are keyed `(owner, class, direction)` with no session ID, and repeats within 15 minutes are merged without a Telegram send. So a second refusal run within 15 minutes of any owner rejection gets no alert of its own.
- **Consequence:** no honest aggregate query can derive these three fields. A query adapter would either make them up, which is untrustworthy evidence, or never produce a passing record. (No adapter exists yet, so this part is an estimate. The storage gap is proven from the code.)
- **Fix, in this PR:**
  - Replace them with fields the stored rows support: `rejectionDeliveryRowCount: 1` and `ownerAlertDisposition: "sent" | "coalesced"`, requiring `sent`.
  - State in the runbook that the refusal scenario must start at least 15 minutes after any earlier owner rejection.
  - Record in `KNOWN_ISSUES.md` the runtime follow-up to store per-session `refusal_sent`, end mode and alert disposition.

**Owner decision (not a blocker for this PR): no live evidence covers an answered outbound call that fails step-up** (voicemail, or someone other than Sid answers).
- `owner-step-up-refused` is inbound-only, and `outbound-no-answer` is now pinned to zero prompts, which removes the coverage research §6.7 expected.
- Adding an `outbound-step-up-refused` scenario costs one more short paid live call. It belongs with Sid's existing outbound-voicemail decision.
- Record it in `KNOWN_ISSUES.md` as an owner decision. Don't add the scenario until Sid chooses.

**Low (fix if small, otherwise record):**
- **L1:** refusal counts are pinned to 3/3, but a real refusal with one "say only your passphrase" re-prompt has 4 prompts. There is also no rejection-reason field, so a deadline rejection with three attempt rows passes. Add `ownerStepUpRepromptCount` and `ownerStepUpRejectionReason: "attempts_exhausted"`.
- **L2:** verified counts accept impossible pairs, such as 1 prompt with 3 attempts. Enforce `attempts <= prompts <= attempts + 2`.
- **L3:** the audit accepts six records sharing one `correlationId` or event IDs. Require distinct correlation IDs and disjoint `eventIds`.
- **L4:** there are no time plausibility checks (a 3-hour refusal call, a 2099 date). Bound the refusal duration and reject future `startedAt`.
- **L5:** outbound records can claim `waive_on_passed_a` and `absent` even though the D1 binding is always `passphrase_always` / `not_applicable`, and `outbound-no-answer` is labelled `refused` with no step-up started. Mirror the binding values.
- **L6** (existed before this PR): there is no ledger of failed paid attempts, so re-running until a lucky pass can't be detected.
- **L7:** the release gate's fake stage leaves out the #46 step-up unit, migration and route tests.
- **L8:** the dropped "schema 1.1 rejected" and `guest_pin` assertions should come back, and so should the explicit per-scenario loop as a backstop.
- **L9:** the release-manifest plan still lists five voice keys.

The full second-reviewer report is `reviewer-tools/pr54-adversarial.md`.

**Next.** A fresh calling-builder session fixes B1, S1 and F1, records the outbound-refusal owner decision, handles L1–L9, and requests a max re-review. This PR still makes no R1 release claim, and it authorizes no call, deploy, secret or migration.
