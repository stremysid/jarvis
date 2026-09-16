## 2026-09-16 00:50 UTC — Claude Opus 5, PR #54 round-2 max re-review at 407af7d: changes requested (small)

This re-review covers implementation `1243390` (fix commits `47cc831`, `a05cc72`) and the main merge `31f1f57`. Both round-1 blockers are fixed in code and proven fixed. What remains is three contract rules that no test pins, one of them introduced by this PR's own new branch, plus one clock-skew robustness item.

**Local checks on 407af7d** (Windows 11, `jarvis-pr39`): lint, typecheck, `typecheck:voice-access` and `test:voice-smoke` pass, and `pnpm test` passes 3,296/3,296 with 0 timeouts. `test:voice-access` reported 1 failure of 899, `owner-passphrase-routes.test.ts > generates inside the Worker and stores no plaintext while returning it once`. That is a load flake, not this PR: run alone the file passes 10/10 at `407af7d`, at #56's head `7c57d6c` and at main `4262024`.

**Mutation pass** (`reviewer-tools/pr54/round2/mut54b.json` and `run54b.txt`, 15 mutations aimed at the new audit and refusal rules, one change per run, every anchor unique). `BASE` passes and **12 of 15 are killed** by named tests, with 0 timeouts: the policy requirement, distinct correlation IDs, disjoint event IDs, the future-`startedAt` bound, the refusal duration bound, the rejection reason, the prompt/re-prompt sum, the alert disposition, the delivery-row count, both verified count invariants, the outbound `not_applicable` attestation and the no-answer `not_started` outcome. Two survivors are behaviour-equivalent and match the second reviewer's independent list: W2 (audit inbound-verified, already blocked by the policy check) and W15 (not-started outbound-only, already blocked by the refusal outcome check).

**B1 fixed.** `auditVoiceEvidence` now requires `ownerCallerIdPolicy: "passphrase_always"` on all four owner-path records and `ownerStepUpOutcome: "verified"` on inbound. The second reviewer's probes reject the round-1 mixed-policy set, a waived inbound substituted into a good set, a refusal under the waiver policy, a seventh waiver record, and a non-verified inbound. The waiver survives only as a per-record shape that the audit refuses.

**S1 fixed, and the replacements are genuinely queryable.** `fixedRefusalSentToProvider` and `cleanEndFrameSent` are gone. `rejectionRowCount` and `rejectionDeliveryRowCount` come from immutable per-session tables (`0018`, `0021`), and `ownerAlertDisposition` is derivable because `#deliverOwnerStepUpRejection` calls `alert()` and `recordRejectionDelivered()` with the same `observedAt`, so `last_sent_at = delivered_at` means this call's alert was sent, and a later rejection moving that timestamp yields `coalesced` and fails closed. The deferred per-session runtime work is recorded in `KNOWN_ISSUES.md`.

**F1 fixed.** All five of my round-1 mutation survivors (V03, V11, V12, V22, V25) now have named negative tests, and the second reviewer's sweep confirms each is load-bearing. V22, the real round-1 gap, is pinned twice over.

**L1–L9 fixed:** bounded re-prompts with `attempts_exhausted`, the verified `attempts <= prompts <= attempts + 2` invariant, distinct correlation IDs and disjoint event IDs, refusal duration and future-`startedAt` bounds, outbound values mirroring the D1 binding with `not_started` for no-answer, the failed-attempt ledger recorded, the three #46 test groups added to the release gate, the restored schema-1.1 and `guest_pin` assertions plus the per-scenario loop, and the manifest note.

**Owner decision correctly recorded, not implemented.** `KNOWN_ISSUES.md` states that a live answered-outbound step-up refusal costs another paid call and waits for Sid. `VOICE_SMOKE_SCENARIOS` is still six.

**Main merge `31f1f57` lost nothing** (225 AGENT_LOG headings against both sides; `KNOWN_ISSUES.md` byte-identical to `1243390` apart from the new section).

**Survivor claims: five upheld, one unverifiable.** V04, V05, V08, V13 and V22 are each genuinely implied by another checked path, verified by removing the guard and re-running the input it blocks. **N41 cannot be checked at all: the expanded 41-mutation spec is not in the repo or on `claude/reviewer-tools`.** Publish the spec with the evidence, or don't cite counts from it. A sweep reporting "all survivors behaviour-equivalent" is not evidence that nothing is unpinned, as S1 below shows.

**S1. The new `not_started` branch is the only thing stopping an answered outbound call from claiming owner authority with no step-up, and no test pins it.**
- **Where:** `tests/acceptance/live/voice-smoke.ts`, the `|| claimsOwnerAuthority` line in the `not_started` branch.
- **Proven:** an `outbound-answer` record with `ownerStepUpOutcome: "not_started"`, zero prompts, zero attempts and `ownerAuthorityGranted: true` is rejected today, but accepted with only that line removed, and all 50 tests in the file still pass. `validateOutboundAnswer` pins terminal state, turn counts, greeting and disclosure, but never the step-up outcome.
- **Why it matters:** "no owner authority without a verified step-up" is the central claim of the passphrase design. The other branches have tests pinning it; this PR's new branch does not, so a later edit could grant authority to an answered outbound call with zero prompts silently.
- **Fix:** keep the guard, add the named negative test.

**N1.** Inbound evidence may not use the outbound-only `not_applicable` attestation, and that rule has no test either. Add the one-line negative case to the existing attestation test.
**N2.** An invalid audit time silently disables the new `startedAt` bound: with `auditTimeMs` as `NaN`, every comparison is false and a set dated 2099 passes. The only production caller passes no argument, so this is latent. Keep the check and pin it.
**N3.** The audit compares `startedAt` against the operator's wall clock, so a PC clock behind the cloud clock refuses a legitimate set with no diagnostic. It fails closed, so this is diagnosis rather than security. Allow a bounded skew (for example `auditTime + 5 minutes`), which still rejects a 2099 date.
**N4 (operational, no code change).** The refusal record requires `attempts_exhausted`, so a live refusal that ends through a third re-prompt or the 60-second window is invalid evidence and costs another paid call. Add one runbook sentence saying why a re-run is needed and that it is a stop-and-review event.

The full second-reviewer report is `reviewer-tools/pr54b-adversarial.md`, with probes in `reviewer-tools/pr54/round2/`.

**Next.** A fresh calling-builder session adds the four tests (S1, N1, N2 and the skew case), applies the N3 tolerance, adds the N4 runbook sentence, publishes its mutation spec alongside the evidence, and requests a max re-review. This PR still makes no R1 release claim and authorizes no call, deploy, secret or migration.
