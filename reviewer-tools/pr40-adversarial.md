# PR #40 adversarial review: owner passphrase step-up

- **PR:** [PR #40](https://github.com/ksid1229-ops/jarvis/pull/40)
- **Branch and commit:** `codex/r1-owner-passphrase-step-up` at `6b63d08`
- **Mode:** read-only. No tests were run.
- **Held against:** `docs/superpowers/specs/2026-09-14-owner-call-passphrase-design.md`

Line numbers refer to `6b63d08`. Lines marked `~` are approximate.

## Verdict

No authority bypass is confirmed with the shipped configuration (waiver off).

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 4 |
| Low | 10 |
| Info | 2 |

I recommend fixing F1 (with F2 and F3, which take the same fix) and F5 before merge. Each is small and each breaks a stated requirement. F4 must be fixed before the waiver can ever be enabled.

## What held up

These were traced and found correct:

- **Refusal when the verifier is missing.** On the required path, `begin()` (owner-call-step-up.ts:168-174) and the window guard (0018:155-175) refuse when the verifier is disabled or was never configured.
- **Attempt ordinal before the KDF.** The ordinal is inserted before the KDF (owner-call-step-up.ts:204-209). It must equal `count+1`, and only one attempt may be unresolved at a time (0018:203-211).
- **Third mismatch.** The third mismatch and the `rejected` phase commit in the same UPDATE, through triggers at 0018:319-325 and 391-396.
- **Re-prompts and guest PINs.** Re-prompts are durable and capped (0018:327-364). Guest PIN ordinals are durable and reserved before the PIN KDF (call-session-do.ts:~589).
- **"Verified."** It is spoken only after the D1 commit and the move to `active` (call-session-do.ts:1147-1156).
- **Waiver exactness.** The attestation match is exact, a duplicated attestation gets 403, the environment value must match exactly, and the waiver applies to inbound calls only.
- **Trigger syntax.** 0018 has no `CASE…RAISE` and no recursive CTE.
- **`UPDATE OR REPLACE`.** It is blocked everywhere. The tables are either fully immutable or their guards pin every key column.
- **`INSERT OR REPLACE` on some tables.** It is impossible on attempts, re-prompts and guest PIN attempts, because ordinal = count+1 never collides. The phase guard blocks it on successes and rejections.
- **Reconnects.** A reconnect cannot reset state. A live socket gets 409, and closing the socket makes the phase terminal.
- **Candidate text.** No `console.*`, error message, alert, DO storage write or frame carries candidate text.
- **Triggers.** No trigger writes across sessions or principals.

## Findings

### F1 — Medium — CONFIRMED (FK detail SUSPECTED). `INSERT OR REPLACE` on bindings can switch a required call to waived

- **Where:**
  - `0018_owner_call_step_up.sql:104-141` (bindings insert guard)
  - `0018:495-498` (waiver branch of the authority trigger)
  - `call-session-do.ts:898-899`
- **Requirement broken:** bindings are immutable, and the D1 trigger stops an application writer from minting owner authority without step-up. The dormant waiver can also be switched on in D1 without `OWNER_CALLER_ID_POLICY`, because the row supplies its own `policy` and `attestation_class`.
- **Why it happens:**
  - The insert guard checks the new row against `call_sessions` but never rejects a key that already exists.
  - `REPLACE` deletes the old row. With `recursive_triggers` off, which is the SQLite and D1 default, the delete guard does not fire.
  - Before a window row exists, there is no foreign-key child to trip `ON DELETE RESTRICT`.
- **Reproduction:** take an inbound owner session S after TwiML and before relay setup, with its binding set to `required`. Run:

  ```sql
  INSERT OR REPLACE INTO owner_call_step_up_bindings
    (session_id, call_sid, owner_principal_id, owner_identity_id, direction,
     lifecycle_generation, requirement, attestation_class, policy, created_at)
  VALUES (:S, :callSid, :ownerP, :ownerI, 'inbound', 1,
          'waived_passed_a', 'passed_a', 'waive_on_passed_a', :sessionCreatedAt);
  ```

  At relay setup, the DO reads `waived_passed_a` and calls `#mintWaivedOwner`. The authority trigger's waiver branch passes, and the call goes `active` with no phrase.
- **Fix:** have the guard raise when a row for `NEW.session_id` already exists. Then make `bind()`, `begin()` and `expire()` read first and insert only when the row is absent. `ON CONFLICT DO NOTHING` alone stops working once the guard raises, because BEFORE INSERT triggers fire before conflict resolution.
- **Test coverage:** none. `owner-call-step-up-migration.test.ts` has no REPLACE case.

### F2 — Low — CONFIRMED. `INSERT OR REPLACE` on windows pushes the 60 s deadline out

- **Where:** `0018:155-175`
- **Requirement broken:** the 60 s window, and window immutability.
- **Reproduction:**
  1. Session S is in `pre_auth` with its window at `prompted_at=T` and no attempts or re-prompts.
  2. Run `INSERT OR REPLACE INTO owner_call_step_up_windows VALUES (:S,1,:v,:now,:now+60s)`. The guard passes and no child blocks the delete. The deadline moves, and this can be repeated until the first attempt.
  3. The alarm handler reads the new deadline from `state()` (call-session-do.ts:1201-1213) and re-arms instead of ending the call.
- **Fix:** the same existing-key rejection as F1.
- **Test coverage:** none.

### F3 — Low — CONFIRMED. `INSERT OR REPLACE` on repeat checks resets the one-time check

- **Where:** `0018:410-429`
- **Requirement broken:** the repeat check runs exactly once, and receipts are append-only.
- **Reproduction:** once `owner_call_step_up_repeat_checks` holds a resolved row, `INSERT OR REPLACE` a fresh row with `outcome NULL`. It has no FK children, so it succeeds, and another KDF-backed compare becomes possible.
- **Fix:** the same existing-key rejection.
- **Test coverage:** none.

### F4 — Medium (dormant) — CONFIRMED. The waiver ignores a disabled or never-configured verifier

- **Where:**
  - `call-session-do.ts:898-899, 919-931`
  - `0018:495-498`
  - `voice-access-repository.ts:~1380-1388, ~1573-1582` (the waiver arm of `stepUpCurrent`)
- **Requirement broken:** a disabled verifier (0017) must make every owner call refuse. Today only the `required` path checks the head and verifier status.
- **Reproduction:**
  1. Set `OWNER_CALLER_ID_POLICY=waive_on_passed_a`.
  2. The owner disables the phrase through Telegram (0017 disable commit). The head becomes `disabled` and the verifier `revoked`. Alternatively, no head row ever existed.
  3. An inbound call arrives with `StirVerstat=TN-Validation-Passed-A`.
  4. The binding is `waived_passed_a`, `#mintWaivedOwner` runs, and the trigger's waiver branch does no head check. The call goes `active` with conversation authority and private context.
  5. `rehydrate` and `requireCurrentAuthority` also accept it.

  The disable kill switch therefore does not stop waived calls.
- **Fix:** require `head.status='active' AND verifier.status='active'` in the trigger's waiver branch, in the `stepUpCurrent` waiver arm, and in `#mintWaivedOwner`.
- **Test coverage:** none. The waiver tests always have an active verifier.

### F5 — Medium — CONFIRMED (needs one transient failure). Alarm key deleted before handling; expiry lost and the call is never ended

- **Where:** `call-session-do.ts:1627-1640`. The key is deleted at 1634, before `#resolveCore` and `handleOwnerStepUpAlarm` run.
- **Requirement broken:**
  - The 60 s deadline must end the call.
  - A spoofer must not be able to lock the owner out.
- **Reproduction:**
  1. A spoofed owner-number call reaches `pre_auth`, and the caller stays silent.
  2. At T+60 the alarm deletes the key.
  3. `#resolveCore`'s D1 read fails and returns `unavailable`, so `alarm()` returns normally and the runtime does not retry. If `handleOwnerStepUpAlarm` throws instead, the retry finds no key and clears the alarm.
  4. No frame ever arrives, so the prompt-path deadline check (1166) never runs.
  5. The session stays `pre_auth` and holds a capacity slot until the spoofer hangs up or Twilio's call time limit ends it.
  6. With two such calls, the owner's own inbound calls are refused with `call_session_capacity`.
- **Fix:** delete the key only after handling succeeds. On `unavailable` or an exception, keep the key and throw so the runtime retries, or re-arm.
- **Test coverage:** none. The existing alarm test covers only the happy path after hibernation.

### F6 — Low — CONFIRMED. Deadline not restored after eviction; the assembly alarm overwrites the window alarm and burns re-prompts

- **Where:**
  - `call-session-do.ts:751-759` (the constructor does not load the deadline)
  - `1181-1186` (arms the assembly alarm)
  - `1189-1194` (re-arms the window only if the in-memory deadline is not null)
  - `1198-1224` (the assembly handler has no fragment check)
- **Requirement broken:**
  - "Eviction reconstructs the step-up state, deadline…"
  - The re-prompt cap should apply to real non-candidates only.
- **Reproduction:**
  1. After hibernation, `#ownerStepUpDeadlineAt` is null.
  2. The caller sends the final "ablaze abrasion", which arms an assembly alarm and replaces the window alarm.
  3. 0.5 s later "active" arrives. The candidate is complete, but the window alarm is not re-armed, and the KDF starts.
  4. At +1.5 s the assembly alarm fires. The phase in memory is still `pre_auth`, so `recordReprompt` inserts a re-prompt and "Please say only your passphrase." is spoken.
  5. If that is the third re-prompt, a rejection commits, the in-flight correct match fails the phase guard at 0018:235, and a correct phrase is refused. The damage stays within that call; nothing carries into the next one.
- **Fix:** load `deadlineAt` from `state()` on the first step-up frame and on core construction. Make the assembly alarm a no-op when no fragments are buffered or a verification is in flight.
- **Test coverage:** none. The hibernation test does not split finals.

### F7 — Low — CONFIRMED. Finals during an in-flight verification still enter the fragment buffer and arm alarms

- **Where:** `call-session-do.ts:1163-1186`. The in-flight flag is checked only at 1121.
- **Requirement broken:**
  - "Finals received while verification is in flight … are discarded."
  - Fragments must be cleared after assembly and on lifecycle change.
- **Reproduction:**
  1. The correct phrase starts the KDF.
  2. The caller says "ablaze". Line 1178 pushes it and 1182 arms the assembly alarm.
  3. If the verification mismatches, the alarm spends a re-prompt, or the next retry is merged into a 4-token non-candidate.
  4. If it matches, "ablaze" stays in memory for the rest of the call. The success path never clears fragments.
- **Fix:** at the top of `#handleOwnerStepUpPrompt`, return when `#ownerStepUpVerificationInFlight` is set. Also clear fragments on success.
- **Test coverage:** none.

### F8 — Medium — SUSPECTED (depends on STT segmentation; also a gap in the design itself). A phrase repeated as split finals after success reaches the model and transcript

- **Where:**
  - `owner-call-step-up.ts:249-251` (a fragment fails canonicalization and returns "continue")
  - `call-session-do.ts:1248-1250`
- **Requirement broken:** candidate text never reaches model input, transcripts or memory. The spec says repeat suppression exists to stop exactly that.
- **Reproduction:**
  1. Verification succeeds.
  2. More than 2 s later, STT emits "ablaze abrasion" and then "active" as two finals.
  3. Each final fails canonicalization, `verifyRepeat` returns "continue", and both reach `conversation.handleTurn`.

  A second whole-phrase repeat also reaches the model once the single claim is used. The spec allows that, but it is still a leak.
- **Fix:** in a short post-success window, assemble fragments exactly as in pre-auth before the repeat compare, and suppress any candidate-shaped assembly.
- **Test coverage:** none. The repeat test uses a single final.

### F9 — Low — CONFIRMED. `resolved_at` carries the pre-KDF time, so the deadline check measures when the attempt started

- **Where:**
  - `owner-call-step-up.ts:211-214` (`resolvedAt = iso(now)`, where `now` was captured before the KDF)
  - `0018:227, 235`
- **Requirement broken:** the 60 s window, and honest `verified_at` / `authenticated_at` audit times.
- **Reproduction:**
  1. An attempt starts at T+59.9 s.
  2. The KDF and commit finish at T+61 s, before the alarm's `expire()` wins the race.
  3. `NEW.resolved_at` (T+59.9) < deadline, so success and owner authority commit after the window closed.
- **Fix:** give the service a clock and stamp `resolved_at` after `verify()` returns.
- **Test coverage:** none.

### F10 — Low — CONFIRMED. An attempt left unresolved ends the call dirty

- **Where:**
  - `owner-call-step-up.ts:204-214` (no resolution in a `finally`)
  - `0018:207-211`
  - `call-session-do.ts:1871-1876`
- **Requirement broken:** a clean end, meaning the refusal line, then the `end` frame, then `<Hangup/>`, plus a rejection receipt and an alert.
- **Reproduction:**
  1. `verify()` throws (a record decode failure, or a D1 error in `#requiredBinding`), or the DO is evicted mid-KDF. The attempt row keeps `outcome NULL`.
  2. The next candidate fails the insert guard ("unresolved exists"). `handleRelayEvent` throws, and the socket closes with 1011.
  3. The phase becomes `failed`. There is no refusal line, no handoff, no rejection receipt and no alert.
  4. If ordinal 3 is the stranded one, the next candidate gets "rejected" with `alreadyDurable=true`, `getCallSession` is not `rejected`, and it throws the same way.

  This fails closed and grants no extra tries.
- **Fix:** in a `finally`, resolve a stranded ordinal as `mismatched`, or add an `abandoned` outcome. Send errors through `#rejectOwnerStepUp`.
- **Test coverage:** none.

### F11 — Low/Medium — SUSPECTED. The outbound-owner reservation only works in the exact "2 inbound in pre_auth" state

- **Where:** `call-repository.ts:~881-909`
- **Requirement broken:** "Inbound `pre_auth` relays cannot consume every outbound-owner admission slot."
- **Reproduction:**
  1. During a spoofing flood, one inbound owner session is in `created` or `connecting` (TwiML served, relay not yet set up, `relay_setup_expires_at` not reached) and the other is in `pre_auth`.
  2. The total is 2, but the `pre_auth` count is 1 ≠ 2.
  3. The Telegram `/call` outbound is refused.
- **Fix:** leave inbound owner sessions that are not yet `authenticated` or `active` out of the count used for outbound-owner admission. Drop the exact-count special case.
- **Test coverage:** partial. The acceptance test covers only the exact two-in-`pre_auth` case.

### F12 — Low — CONFIRMED (spec and test gap). Lifecycle-generation checks are constant

- **Where:**
  - `0018` `CHECK (lifecycle_generation = 1)` on every table
  - `call-session-do.ts:1199` (compares literal 1 with literal 1)
- **Requirement broken:** "Tests … prove the alarm's lifecycle-generation check, including an old alarm arriving after a newer lifecycle began." No such test exists, and the check cannot fail. Stale-frame and out-of-sequence discarding is not implemented either. Nothing is exploitable today, because a session never re-enters `pre_auth`.
- **Fix:** either record in the spec that the generation is always 1 for each session, or carry the core's `#lifecycleGeneration` into the stored alarm and compare against it.
- **Test coverage:** not applicable.

### F13 — Low — CONFIRMED. Voice routes now fail to construct without `OWNER_PASSPHRASE_PEPPER_V1`

- **Where:** `production-routes.ts:~609-615`
- **What breaks:** availability. A missing pepper, or a bad Telegram token, makes every voice route throw. That includes guest inbound calls and the relay-ended and status callbacks, so sessions stop being terminalized by callbacks and capacity slots stay held.
- **Fix:** confirm the deploy order sets the secret first, or build the owner step-up pieces lazily so callbacks keep working.
- **Test coverage:** the construction test was updated with the secret present; the missing-secret case is untested.

### F14 — Low — SUSPECTED. The alert is awaited before the refusal and hang-up

- **Where:** `call-session-do.ts:1099-1115`
- **What breaks:** a clean, prompt end. A slow Telegram or D1 call keeps an unauthenticated caller connected. No authority is exposed.
- **Fix:** speak the refusal and send `end` first, then deliver the alert. Use `ctx.waitUntil` or an outbox.
- **Test coverage:** none.

### Info

- **I1:** dead duplicate `OwnerCallStepUpService.reserveGuestPinAttempt` at `owner-call-step-up.ts:296-305`. The live copy is in `voice-access-repository.ts`.
- **I2:** `claimOutboundTwiML` binds `required` for every outbound session, including a guest binding, which the bindings guard would reject with RAISE. No producer of outbound guest sessions was found, so this is latent only.

## Test coverage summary

No existing test would catch any of F1–F14. Tests to add:

- REPLACE cases on bindings, windows and repeat checks.
- The waiver with a disabled or absent head.
- Alarm handling when D1 fails.
- Split finals after hibernation.
- A final arriving during an in-flight verification.
- A split-final repeat after success.
- A deadline crossed during the KDF.
- A stranded attempt.
- The outbound reservation with one inbound session in `connecting`.
