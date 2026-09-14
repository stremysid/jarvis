# PR #31 adversarial suite, re-run against 327ddda

[PR #31](https://github.com/ksid1229-ops/jarvis/pull/31) head `327ddda` (`origin/codex/r1-owner-phone-enrollment`).
The harness came from `origin/claude/pr31-adversarial-tests` at `ea1bc1c`, which was written against `fc84bdb`.
Worktree: `C:/Users/Sid/jarvis-pr31-adv2`, detached at 327ddda. Only the 8 adversarial test files are changed. No product code was changed, nothing was committed or pushed, no production command was run, and only synthetic numbers were used.

## Summary

| Suite | Original tests | Pass | Fail | New tests (inverted + classify) | New pass |
|---|---|---|---|---|---|
| Gateway (`apps/cloud-gateway/test/adversarial`) | 90 | 62 | 28 | 30 | 30 |
| CLI (`tests/test_pr31_adversarial_cli.py`) | 31 | 29 | 2 | 2 | 2 |

Before adaptation the same code gave: gateway 76 fail / 14 pass, CLI 9 fail / 22 pass. The 14 gateway passes proved nothing. With `OWNER_PRINCIPAL_ID` missing, those requests took the unconfigured branch, and each of the 14 only asserted a refusal or a non-200.

**FINDINGs fixed.** Every one fails on its own claim and has a passing inverted test.
- 1d' (S1): a second human principal can no longer claim the owner singleton.
- 3c ×4 (S2): malformed `OWNER_VOICE_IDENTITY_ID` is refused before any write.
- 4b: an overtaken begin no longer reports a dead response.
- 5a (B1): a same-phone retry after expiry now returns 200 with the live challenge.
- 5a' (B1 variant): a first begin beside an unrelated expired challenge now returns 200.
- INFO 8c (N1): configuration state is no longer visible before authentication.
- Finding 5: a non-canonical signed body is now 400, not 500. This finding is embedded in 1k and 7a.
- CLI N8: a connection reset while reading the begin response now exits 4 with fixed output, not a traceback.
- CLI S4: configuration errors are no longer reported as a device-key mismatch.

**Still present.**
- FINDING 5d: the number-guess oracle. `327ddda` records it in `KNOWN_ISSUES.md` as an open design choice.
- OBSERVATION 9c: spoofed calls still lock the owner out for the attempt window. This is tied to the caller-ID known issue.
- MECHANISM: D1 still counts trigger-deleted rows in `meta.changes`. The product no longer relies on that count (it uses `RETURNING challenge_id`), so 5a/5a' are fixed.

**Regressions.** No security property regressed in any test run. Three non-FINDING tests fail only because they pinned behaviour that the fixes deliberately changed:
- **3a ×13:** a `request_nonces` row is now written. The route authenticates before answering 503, which is the 8c fix. No enrollment row is written, and CLASSIFY 3a shows that nonce blocks a replay after configuration is repaired.
- **3b:** now 503 instead of 500. The test's own name described the 500 as a defect.
- **8a:** an expired envelope now gets `{"error":"signed_request_expired"}` instead of the shared mismatch body. CLASSIFY 8a shows the freshness check runs before any device, key or principal lookup (`signed-request.ts:308` vs `:310-318`). Every expired variant gets the same body, so it reveals nothing about devices, keys or principals.

In four mixed tests the embedded finding assertion flipped because the finding is fixed: 1k, 5a, 7a and 9c. Their split tests pass.

**Unclassified:** none.

## Every test on 327ddda

Kinds: **correct** means the test asserts correct behaviour. **mixed** means a correct-behaviour test that embeds a finding assertion. FINDING, INFO, MECHANISM and OBSERVATION tests passed at fc84bdb by demonstrating a problem.
Line numbers refer to the final files in `pr31-adversarial-v2/`. Parametrized rows (×N) had the same result for every case.

### pr31-route-auth.test.ts

| Test | Kind | Result | Verdict | Evidence |
|---|---|---|---|---|
| 1a unsigned begin refused | correct | PASS | holds | 401 mismatch, no state; now via the configured route |
| 1b forged signature | correct | PASS | holds | 401 |
| 1c revoked device | correct | PASS | holds | 401 |
| 1d cross-principal envelopes (4 combos) | correct | PASS | holds | all 401 |
| FINDING 1d' second human principal claims singleton | FINDING | FAIL | **fixed** | `:78` expected 401 to be 200. The intruder is refused by the owner-principal pin (`device-repository.ts:215` `d.principal_id = ownerPrincipalId`). INVERTED 1d' passes. |
| 1e tampered body | correct | PASS | holds | 400 |
| 1f byte-identical replay | correct | PASS | holds | first 200, replay 401, challenge untouched |
| 1g ×4 signature for another path | correct | PASS | holds | 401 |
| 1g' look-alike paths | correct | PASS | holds | never 200 |
| 1h other audience | correct | PASS | holds | 401 |
| 1i stale / future envelope | correct | PASS | holds | 401 |
| 1j POST signed as GET | correct | PASS | holds | 401 |
| 1k non-canonical signed bodies | mixed | FAIL | embedded finding 5 **fixed**; not a regression | `:174` got `[400,400,400]`, asserted `[500,500,400]`. Earlier assertions passed: harness self-check, no 200, no state. INVERTED 1k passes. |
| 2a ×9 extra body fields | correct | PASS | holds | 400, nothing created |
| 2b phone in preflight/status | correct | PASS | holds | 400 |
| 2c own `__proto__` member | correct | PASS | holds | non-200, no identity |
| 2d identity from env, principal from device | correct | PASS | holds | row matches env id + principal:owner |
| 2e ×6 non-E.164 phones | correct | PASS | holds | 400, no state |
| 3a ×13 misconfiguration fails closed | correct | FAIL | **changed by the 8c fix (benign)**; not a fail-open | `:283` differs only in `nonces: 1` vs `0`. Status 503 and body passed. CLASSIFY 3a ×15 shows identities/owners/challenges 0 and nonces 1; replaying the same request after fixing configuration gives 401. |
| 3b non-NFC identity id | mixed | FAIL | embedded "500, not 503" note **fixed** (now 503) | `:290` expected 503 to be 500. CLASSIFY 3b passes: 503, no enrollment state. |
| FINDING 3c ×4 malformed identity id accepted | FINDING | FAIL ×4 | **fixed** | `:298` expected 503 to be 200. The route `IDENTIFIER` (`owner-phone-enrollment-routes.ts:11`) now equals inbound `SAFE_ID` (`voice-access-repository.ts:266`). INVERTED 3c ×4 pass. |
| 3c-control well-formed id admitted inbound | correct | PASS | holds | activation-only session bound to the challenge |
| 8a byte-identical preflight refusals | correct | FAIL | **contract changed by the fix; no oracle** | `:371` 7 of 8 refusals identical; the expired envelope returns `signed_request_expired`. CLASSIFY 8a: 6 expired variants identical, 6 fresh refusals identical. |
| 8b successful preflight is two fixed fields | correct | PASS | holds | same text before/after begin, no-store |
| INFO 8c 503 vs 401 before authentication | INFO | FAIL | **fixed** | `:394` got `[401,401]`. INVERTED 8c passes. |

### pr31-state-races.test.ts

| Test | Kind | Result | Verdict | Evidence |
|---|---|---|---|---|
| 4a three concurrent same-phone begins | correct | PASS | holds | 1 identity, 1 singleton, 1 live challenge that a caller received |
| FINDING 4b overtaken begin reports a dead response | FINDING | FAIL | **fixed** | `:115` the slow begin throws `owner_phone_enrollment_state_changed` (receipt check, `owner-phone-enrollment.ts:209`). INVERTED 4b passes. |
| 4c different-phone race inside batch window | correct | PASS | holds | loser gets state_changed; one phone bound |
| 4c' unsynchronised different-phone route race | correct | PASS | holds | invariants kept; only the bound request is pending |
| 4d fault injected into resume batch | correct | PASS | holds | live challenge unchanged and usable |
| 4e crash after commit | correct | PASS | holds | complete pending state; resume works |
| 5a expired resume only for same phone | mixed | FAIL | embedded FINDING 5a **fixed** | `:204` the first retry resolved pending instead of rejecting. Earlier assertions passed: expired, other phone conflict. INVERTED 5a (split) passes the remainder. |
| 5b ×2 phone bound elsewhere | correct | PASS | holds | atomic refusal, opaque 500 |
| 5c begin after activation | correct | PASS | holds | `active`, no challenge issued or rotated |
| FINDING 5d number-guess oracle | FINDING | PASS | **still present** | right number returns pending/active, wrong returns conflict; a pending right guess rotates the live code. Recorded in `KNOWN_ISSUES.md` at 327ddda. |
| 5e second device of same principal | correct | PASS | holds | `conflict`, nothing rotated |
| 5f key rotation strands old response | correct | PASS | holds | old response refused; same-phone resume activates |
| 5g replacement device row | correct | PASS | holds | `conflict`, begin cannot repair |

### pr31-expired-resume.test.ts

| Test | Kind | Result | Verdict | Evidence |
|---|---|---|---|---|
| MECHANISM reclaiming INSERT reports `meta.changes = 2` | MECHANISM | PASS | **still present in D1; no longer reaches product behaviour** | the product now reads `RETURNING challenge_id`; 5a/5a' fail and their inversions pass |
| FINDING 5a retry after expiry gets 409 | FINDING | FAIL | **fixed** | `:66` expected 200 to be 409. INVERTED 5a passes. |
| FINDING 5a' first begin beside expired challenge gets 409 | FINDING | FAIL | **fixed** | `:101` expected 200 to be 409. INVERTED 5a' passes. |

### pr31-challenge-privacy.test.ts

| Test | Kind | Result | Verdict | Evidence |
|---|---|---|---|---|
| 6a accepted 1 ms before 5 min | correct | PASS | holds | |
| 6a' refused at exactly 5 min | correct | PASS | holds | |
| 6b single use | correct | PASS | holds | |
| 6c wrong response does not consume | correct | PASS | holds | |
| 6d bound to device A; refused after revoke | correct | PASS | holds | |
| 6e no response or bare hash persisted | correct | PASS | holds | |
| 6f phone only in `provider_subject` | correct | PASS | holds | |
| 7a privacy of logs, bodies, events, outbox, D1 | mixed | FAIL | embedded finding 5 **fixed**; privacy holds | `:252` the status map differs only in `"non canonical": 400` vs `500`. The console-leak checks before it passed. CLASSIFY 7a runs the full sweep and passes. |

### pr31-e2e-activation.test.ts

| Test | Kind | Result | Verdict | Evidence |
|---|---|---|---|---|
| 9a enroll → activation call → active → owner conversation | correct | PASS | holds | |
| 9b three spoofed wrong guesses, then resume | correct | PASS | holds | |
| OBSERVATION 9c spoofed calls exhaust composite budget | OBSERVATION | FAIL (on embedded 5a line) | **observation still present**; embedded FINDING 5a **fixed** | `:277` expected 200 to be 409. The lockout assertions before it passed. CLASSIFY 9c: owner still blocked in the window; after it, the first begin is 200 and the owner completes. |
| 9d guests / unknown callers cannot use pending identity | correct | PASS | holds | |
| 9e resume during in-progress call | correct | PASS | holds | |
| 9f revoke enrolling device closes activation | correct | PASS | holds | |
| 9g activation-only session unusable after expiry | correct | PASS | holds | |

### pr31-e2e-production-do.test.ts

| Test | Kind | Result | Verdict | Evidence |
|---|---|---|---|---|
| 9p route challenge consumed by production CallSession | correct | PASS | holds | no network call |
| 9p' pepper rotated without key-version bump | correct | PASS | holds | identity stays pending |

### apps/local-agent/tests/test_pr31_adversarial_cli.py

The real Windows DPAPI store tests ran on this PC; none were skipped.

| Test | Kind | Result | Verdict | Evidence |
|---|---|---|---|---|
| test_real_store_missing_key_is_refused_and_creates_no_file ×3 | correct | PASS | holds (message adapted) | exit 1, no file, no path, no prompts; new fixed message |
| test_real_store_refuses_an_unusable_key_file_without_overwriting_it ×3 | correct | PASS | holds (message adapted) | exit 1, file untouched |
| test_cli_source_has_no_key_creation_path | correct | PASS | holds | |
| test_real_sealed_key_begin_sends_the_number_only_inside_the_signed_body | correct | PASS | holds (salt + second prompt adapted) | number only in the signed body; signature verifies |
| test_begin_never_prints_or_logs_the_number ×13 | correct | PASS | holds | |
| test_finding_unhandled_read_error_escapes_run_phone_enrollment_without_leaking_the_number | FINDING | FAIL | **fixed** | `:331` DID NOT RAISE; stdout `owner phone enrollment request is unavailable` (`cloud_client.py` now maps `OSError`). Inverted test passes. |
| test_begin_writes_nothing_to_disk | correct | PASS | holds | |
| test_status_and_preflight_never_prompt_for_or_send_a_number | correct | PASS | holds | |
| test_non_canonical_phone_input_is_refused_before_sending_and_not_echoed ×6 | correct | PASS | holds | |
| test_finding_configuration_errors_are_reported_as_a_device_key_mismatch | FINDING | FAIL | **fixed** | `:451` got `(2, 1)`; stdout `owner phone enrollment configuration is incomplete`. Inverted test passes. |

## Harness changes

Construction and contract details only. No assertion in an original test was removed or loosened. The full diff against `ea1bc1c` is in `pr31-adversarial-v2/harness-v2-vs-ea1bc1c.patch`.

1. `pr31-helpers.ts`
   - Adds `OWNER_PRINCIPAL = "principal:owner"`, and `enrollmentEnvironment()` now sets `OWNER_PRINCIPAL_ID`.
   - Adds `REQUEST_SALT`, a fixed canonical base64url 32-byte value (`BRAbJjE8R1JdaHN-iZSfqrXAy9bh7PcCDRgjLjlET1o`, no digit runs), and `BEGIN` now carries it. A fixed value was chosen because the server only checks its format, and it keeps `{ ...BEGIN, phoneNumber }` and the replay test byte-stable.
2. `pr31-state-races.test.ts` and `pr31-challenge-privacy.test.ts`: the direct `OwnerPhoneEnrollmentService` construction passes `ownerPrincipalId`.
3. `pr31-route-auth.test.ts`
   - The raw-text bodies in 1k (`CANONICAL_BEGIN_TEXT`, whitespace, duplicate key) and 2c (`__proto__`) include `requestSalt`, so the only defect is still the attack itself.
   - 1k gained one self-check line: `CANONICAL_BEGIN_TEXT` bytes equal `canonicalize(BEGIN)`.
4. `pr31-challenge-privacy.test.ts`: the 7a "non canonical" raw text includes `requestSalt`.
5. CLI
   - Adds `import re` and a `KEY_UNAVAILABLE` constant. The two real-store tests expect it exactly, where they previously expected the old mismatch text. The old text was itself the S4 misdiagnosis for a missing key.
   - Sealed-key begin test: the random salt makes exact body equality impossible. It is replaced by an exact key set, exact values for the three original fields, and the salt shape (43-char base64url, 32 bytes, no phone fragment).
   - The expected getpass prompts now include `Re-enter the same phone number (input hidden): `.
6. Unchanged: `pr31-e2e-production-do.test.ts` (already set `OWNER_PRINCIPAL_ID`), and every FINDING, INFO, MECHANISM and OBSERVATION test body.

## Inverted and classification tests (all new, all PASS on 327ddda)

INVERTED tests assert the negation of the finding at the same step, so each fails if its finding returns. They were not mutation-tested, because product code may not change. Running them against fc84bdb would prove nothing: its body schema rejects `requestSalt`, so they would fail for a contract reason.

| Test | File | Inverts / classifies | Result | Fails if the bug returns because |
|---|---|---|---|---|
| INVERTED 1d' | route-auth | FINDING 1d' | PASS | the intruder's BEGIN/STATUS/PREFLIGHT would get 200, and an unset `OWNER_PRINCIPAL_ID` would not 503 |
| INVERTED 3c ×4 | route-auth | FINDING 3c | PASS ×4 | a permissive id check returns 200 and writes the singleton |
| INVERTED 8c | route-auth | INFO 8c | PASS | a configuration check before authentication turns unconfigured unsigned/forged requests into 503 ≠ 401 |
| INVERTED 1k | route-auth | finding 5 (embedded in 1k/7a) | PASS | non-canonical bodies would get 500 |
| INVERTED 4b | state-races | FINDING 4b | PASS | without the `challenge_id` receipt check the slow begin resolves pending |
| INVERTED 5a (split from 5a) | state-races | embedded FINDING 5a | PASS | the first retry would reject with state_changed |
| INVERTED 5a | expired-resume | FINDING 5a | PASS | retry → 409; it also confirms the returned response activates |
| INVERTED 5a' | expired-resume | FINDING 5a' | PASS | first begin → 409 |
| test_inverted_read_error_after_begin_returns_the_fixed_unavailable_output | CLI | CLI traceback finding | PASS | `ConnectionResetError` would escape |
| test_inverted_configuration_errors_have_their_own_message_and_are_not_a_key_mismatch | CLI | CLI S4 | PASS | exit 1 plus the mismatch text |
| CLASSIFY 3a ×15 (13 original configs + `OWNER_PRINCIPAL_ID` unset/malformed) | route-auth | 3a | PASS ×15 | — |
| CLASSIFY 3b | route-auth | 3b | PASS | — |
| CLASSIFY 8a | route-auth | 8a | PASS | — |
| CLASSIFY 7a | challenge-privacy | 7a | PASS | — |
| CLASSIFY 9c | e2e-activation | OBSERVATION 9c | PASS | — |

## Artifacts and commands

- Adapted files: `scratchpad/pr31-adversarial-v2/` in repo-relative layout, plus `harness-v2-vs-ea1bc1c.patch`.
- Raw output: `scratchpad/baseline-gateway.txt`, `baseline-cli.txt` (unadapted), `run1-*.txt` (adapted), `run2-*.txt` (adapted plus new tests; the numbers above).
- Commands, in PowerShell:
  - `cd C:/Users/Sid/jarvis-pr31-adv2` then `npx vitest --config vitest.workspace.ts run apps/cloud-gateway/test/adversarial --reporter=verbose`
  - `cd C:/Users/Sid/jarvis-pr31-adv2/apps/local-agent` then `uv run pytest -v -p no:cacheprovider tests/test_pr31_adversarial_cli.py`
