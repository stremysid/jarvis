# PR #40 round-3 adversarial re-verification (fix 4dddf9c, head 07e1464)

- **Scope:** `git diff 337c290 07e1464`, read against the round-2 review (d217c55), pr40-reverify.md, the design spec and KNOWN_ISSUES.md.
- **Mode:** reading plus runtime probes. Worktree `C:/Users/Sid/jarvis-pr40-verify3` (since removed); Windows 11; one vitest process at a time. No commit, no push, nothing remote.
- **Line numbers** are at 07e1464. `csdo` = `apps/cloud-gateway/src/voice/call-session-do.ts`; `step-up` = `apps/cloud-gateway/src/voice/owner-call-step-up.ts`.
- **Probes:** `pr40-reverify2-probes.test.ts`, beside this file; it belongs in `tests/acceptance/fake/`. Each test asserts that the hole EXISTS, so a pass means the bug is real.
  - Run: `npx.cmd vitest --config vitest.workspace.ts run tests/acceptance/fake/pr40-reverify2-probes.test.ts`
  - Results: P1 (x2), P5 and P6 passed 4 of 4 in one run (10.0 s); P7 passed 1 of 1 in a second run (`-t P7`, 2.8 s).
  - The round-2 probes and contract-gap ports were NOT rerun here (the reviewer and another agent own those).

## Verdict

- **No path to owner authority without the phrase was found.**
- **N1 is fixed.** With no infrastructure fault, I found no sequence of frames, silence or alarm fires that leaves an unverified owner call open past its deadline, or that ends a verified call.
- **The "every unverified call ends at its deadline" guarantee still fails under transient D1 faults, in two ways.** Neither is attacker-triggerable.
  - **N5 (M, runtime-proven):** a deadline rejection interrupted after its durable write is never finished. There is no refusal line, no end frame, no `<Hangup/>` and no alert, and the relay stays open.
  - **B2 residual:** a throwing `alarm()` is retried only a bounded number of times, then dropped, and nothing re-arms it.
- **Blocks clearance?** Nothing an attacker can trigger blocks it. N5 directly breaks the stated v1.0 gate, and the fix is small, so I recommend fixing it before clearance, unless Sid explicitly accepts it as a recorded known issue. Record the B2 retry-exhaustion fallback, or fix it in the same change. Everything else below is Low.

## Round-2 items

### B1 (N1 High): one utterance then silence. FIXED.
- **Mechanism:** the handlers now own the key. `alarm()` (csdo 1709-1732) never deletes it on success, and every `handleOwnerStepUpAlarm` path (1271-1304) ends in exactly one of:
  - `clear()`: stale phase or interaction (1272-1274), no deadline or already rejected (1278-1280);
  - `#rejectOwnerStepUp`, which clears (1164);
  - re-arm window: early window fire (1287-1292), assembly re-prompt (1301-1303).
- **Cases checked:**
  - **Early window fire:** re-arms the window with the persisted deadline (1288).
  - **Mid-verify final (F7):** dropped at 1233. The window is re-armed at 1262-1267 before the verifier starts, so no assembly key can overwrite it during the KDF.
  - **Two alarms racing:** a DO holds one alarm. The alarm handler can interleave with prompt handlers at D1 awaits (external I/O opens the input gate). Every interleaving I traced leaves either a window key or an assembly key.
    - The assembly handler always re-arms the window or rejects, so the chain always reaches the deadline.
    - Side effect: P6, a double-counted re-prompt (Low, below).
  - **Eviction between put and setAlarm** (1700-1701): the key and the scheduled time can disagree. In either direction the next fire re-arms the window or, once past the deadline, rejects. The worst lateness is an assembly alarm armed just before the deadline: at most 1.5 s late (1255-1258).
  - **setAlarm with a past deadline:** fires immediately, and the handler rejects (1283-1285).
  - **DO restart losing the in-memory deadline (F6):** restored from D1 before the frame-path check (1235-1238).
  - **Verified call hit by a late alarm:**
    - The handler sees phase `active` and only clears (1272-1274).
    - `#rejectOwnerStepUp` refuses unless D1 says `rejected` (1159-1160).
    - An alarm racing a committed match fails in `expire()`'s pre_auth insert guard, throws, and on retry sees `active`, so it clears.
    - No path ends a verified call.
- **Reverting tests:**
  - voice-owner-call-step-up.test.ts "keeps the original deadline after an assembly alarm and rejects silence (hibernate=false/true)" (asserts a window key after the assembly alarm, then rejection, refusal, end, one alert and Hangup)
  - "restores the persisted deadline before accepting a post-hibernation fragment" (F6)
  - call-session-do.test.ts "ignores a final arriving during KDF work instead of replacing the window alarm" (F7)
- **Test caveat (info):** `fireAlarm` calls `alarm()` directly (tests/acceptance/fake/voice-relay-system.ts:257), and the harness deletes the real alarm after every frame for pre-now clocks (:227-230). The tests therefore prove the durable key, not that `setAlarm` scheduled anything. Reading confirms `put` and `setAlarm` are always paired (csdo 1700-1701).

### B2: `#resolveCore` unavailable. PARTIAL.
- **Fixed:** `unavailable` now throws before any handling and keeps the key (csdo 1720). A socket loop that handles nothing also throws (1731).
  - Reverting test: "retains the deadline when an evicted alarm cannot reconstruct its core".
- **Residual: bounded retries.** Not runtime-provable in Miniflare. Cloudflare's documented behaviour, which I could not re-fetch (the doc search returned nothing), is exponential backoff from 2 s with a limited number of retries (6), then the alarm is abandoned.
  - The key stays in storage, but nothing re-schedules the alarm.
  - Scenario: D1 is unavailable for about 2 minutes during a silent spoofed pre_auth call. The deadline is lost.
  - The capacity query counts connected `pre_auth` sessions with no staleness bound (`call-repository.ts:883-893`), so the call holds an owner slot until the caller hangs up (the relay-ended callback calls `finishSession`, then `terminate()` clears it; `http/voice-callback-recorder.ts:175-201`, csdo 1816) or Twilio's own call time limit ends it. No `timeLimit` is set.
  - There is no terminal fallback.
  - Fix: take `alarm(alarmInfo)`. When `alarmInfo.retryCount` nears the limit, `setAlarm(Date.now() + 30_000)` and return instead of throwing. Or close the relay socket 1011 so Twilio ends the call.
- **Residual: fault after the durable expire.** See N5; the retry recovers the alarm but not the call.

### S1: contract tests. Read-only judgment; another agent reruns the ports.
- **2b, post-wake exhaustion. COVERED.** The hibernation test (voice-owner-call-step-up.test.ts "preserves mismatch ordinals across a Durable Object hibernation boundary") now asserts: exactly one refusal token, the end frame with handoff data, `stepUpAlerts()` equal to exactly one rejected alert, and callback `<Hangup/>`. The port (in-memory counter speaks the retry prompt after the wake) fails the refusal and end assertions.
- **3b, mismatch-path leak. COVERED for the described port.** The three-mismatch test (voice-owner-passphrase-security.test.ts, "uses clean ConversationRelay end...") spies on all 19 console methods and sweeps relay frames, close events, alerts, model requests, turns, DO KV, DO SQL and every D1 table (`d1Evidence`, :307-317). It checks for each full wrong candidate plus its SHA-256 hex and base64. The port's warn/info/error logs, retry-prompt echo and KV/SQL journal are all caught.
  - **Residual (L):** only whole candidate strings are searched. `evidenceText` joins separate strings with a newline, so a leak of `candidate.split(" ")`, a hyphen-joined form, or base64/hex of the plaintext stored as TEXT survives.
  - Only the three-mismatch path is swept, not re-prompt exhaustion, the deadline or post-wake.
  - Fix: also search the distinguishing words (`activist`, `activity`) and base64/hex of each plaintext.
- **3c, admitted-phrase encodings. COVERED.**
  - ArrayBuffers, views and 0-255 integer arrays are decoded to UTF-8 text, hex, base64 and CSV.
  - Matching is case-insensitive (lower-cased on both sides).
  - SHA-256 hex and base64 of the spoken and canonical forms are checked.
  - All console methods, including dir, trace and table, are spied.
  - The individual words are searched on this path.
  - **Residual (L):** base64 or hex of the plaintext stored as a TEXT value is not searched (those forms are generated only from byte values).
- **6b, outbound keypad. COVERED.** 8 cases (inbound and outbound, x 4827/0000/1357/9999) each assert `pre_auth`, 0 owner authority, 0 attempts and no model request.

### S2: voice-gate timing. FIXED IN CONFIG, not measured by me.
- `scripts/voice-release-gate.mjs:31-34` adds `--maxWorkers=1`, pinned by `scripts/test/voice-release-gate.test.mjs:10`. The KDF-heavy tests carry explicit 15-30 s timeouts.
- The installed stack is vitest 4.1.11 with @cloudflare/vitest-pool-workers 0.22.0. The pool's dist has no maxWorkers handling of its own, so serialization relies on vitest core scheduling. The reviewer's gate run is the evidence.

### S2/N2: short word-list replies dropped after "Verified.". FIXED.
- `repeatStatus` (step-up ~295-313) now returns `fragment` only between 2.0 and 3.5 s (`OWNER_STEP_UP_REPEAT_FRAGMENT_MS`).
- `#guardOwnerRepeat` passes any final under 3 words once `available` (csdo 1115-1118).
- Reverting test: voice-owner-passphrase-security.test.ts "stops buffering short word-list replies after the bounded split-repeat window".
- Side effect: P5 (Low, below).

### Lows

| Item | Status | Evidence | Reverting test |
|---|---|---|---|
| F6 deadline restore on eviction | FIXED | csdo 1235-1238 | "restores the persisted deadline before accepting a post-hibernation fragment" |
| F7 mid-verify final | FIXED | csdo 1233 | call-session-do "ignores a final arriving during KDF work..." |
| F9 `resolved_at` pre-KDF | RECORDED | KNOWN_ISSUES.md, first owner-call section, bullet 1 | n/a |
| F10 verifier crash strands ordinal | RECORDED | bullet 2 | n/a |
| F11 outbound slot `2 = count(pre_auth)` | RECORDED | bullet 3 | n/a |
| F14 alert before refusal | FIXED | csdo 1166-1171 now precede the alert (1172-1185) | **none**: no test asserts ordering; the tests only check that both happened. See also N6. |
| N3 concurrent duplicate deliveries | RECORDED | bullet 4 | n/a |
| N4 unserialized post-success finals | RECORDED | bullet 5 | n/a |

KNOWN_ISSUES says the five must be resolved or explicitly accepted before inbound opening and the attended smoke. That is acceptable.

## New findings

### N5: M. RUNTIME-PROVEN (P1, both variants). A deadline rejection interrupted after the durable expire is never completed.
- **Where:**
  - csdo 1278-1281: `state.rejectionReason !== null` leads to `clear()` and return.
  - csdo 1721-1724: after eviction, `#resolveCore` sees a terminal session, returns `mismatch`, and the alarm is cleared.
  - Failure points after `expire()`: `getCallSession` (1159), `binding()` (1172), or a relay send.
- **Scenario:**
  1. A silent spoofed call reaches the deadline.
  2. The alarm runs `#rejectOwnerStepUp` and `expire()` commits (D1 phase `rejected`).
  3. The next D1 read fails transiently, so `alarm()` throws and keeps the key.
  4. The runtime retry finds a rejection row (or, if evicted, a terminal session) and only clears the key.
- **Result:** no refusal line, no `end` frame (so no callback `<Hangup/>`), no owner alert, and the relay socket stays open. The silent caller stays connected until they hang up. No authority is granted, and no slot is held (D1 is `rejected`).
  - A speaking caller on a cached core is recovered by the frame-path deadline check (1239-1240, idempotent `expire`).
  - After eviction, a speaking caller is closed 1008 at 1955-1957, without refusal or alert.
- **Proof:** P1 spies `OwnerCallStepUpService.prototype.expire` to commit, then throw once. After the retry: key gone, 0 refusal tokens, no end frame, 0 alerts, 0 close codes. Holds with and without hibernation.
- **Why M:** it violates the release-gate rule "every unverified call must end at its deadline", and the spec (lines 229-235, 285) requires refusal, end, Hangup and an alert. It is fault-triggered only.
- **Fix:**
  - In `handleOwnerStepUpAlarm`, when `rejectionReason !== null` and this core's `#session.phase` is still `pre_auth`, call `#rejectOwnerStepUp(observedAt, true)` instead of clearing.
  - In `alarm()`'s mismatch branch, for a `rejected` session with a live socket, send the refusal and end frame (or close 1008) before clearing.
  - Add P1 as a regression test.

### N6: L. NOT PROVEN. The F14 reorder lets a hang-up suppress the rejection alert.
- **Where:** csdo 1166-1171 now run before the alert (1172-1185). `socketRelay.send` calls `socket.send` synchronously (csdo `function socketRelay`), so a send on a closed socket throws out of `sendNeutralText` and the alert is skipped.
- **Scenario:** a spoofer says a third wrong phrase and hangs up during the ~600k-round KDF. `verifyCandidate` returns `rejected`, the refusal send throws, and the alert is never attempted. At 337c290 the alert went first and would have been sent. Spec 285 says rejected step-ups alert Sid.
- **Unproven:** whether workerd's `send` throws after a peer close.
- **Fix:** wrap the refusal and end sends in try/catch (fall back to close) so the alert always runs; add an order/hang-up test.

### N7: L. RUNTIME-PROVEN (P7). After a pre_auth hang-up, the alarm keeps its key and throws on every fire.
- **Where:** `handleSocketClose` (csdo 1542-1565) marks the session `failed` but never clears the alarm key. At the deadline, `alarm()` handles no socket, so `handled` stays false and it throws `owner_step_up_alarm_runtime_unavailable` (1731) until the runtime gives up.
- **Proof:** P7, in the harness: after `call.close()` the phase is `failed` and the key is present; after +60 s `alarm()` throws `owner_step_up_alarm_runtime_unavailable` and the key is still present.
- **Impact:** no security impact (the session is terminal; the relay-ended callback's `terminate()` normally clears first, csdo 1816). Every abandoned call whose callback is late produces a run of alarm exceptions that look identical to a real B2 outage and will mask it.
- **Fix:** clear the alarm in `handleSocketClose`. Or, in `alarm()` with no ready socket, re-read D1 and clear if the session is terminal.

### N8: L. RUNTIME-PROVEN (P6). A late fragment plus the pending assembly alarm spend two re-prompts.
- **Where:** the late-fragment branch (csdo 1244-1249) records a re-prompt but neither re-arms the window nor replaces the `assembly` key. The already-scheduled assembly alarm then records a second re-prompt (1294-1300).
- **Impact:** fails closed. The real owner can be rejected after fewer genuine pauses (the cap is 3). The race window is the alarm's delivery lag.
- **Fix:** re-arm the window in the late branch, as 1301-1303 does.

### N9: L. RUNTIME-PROVEN (P5). A split phrase repeat after 3.5 s reaches the model and transcript.
- **Where:** csdo 1115-1118. After 3.5 s, an `available` final under 3 words passes through unassembled.
- **Proof:** after "Verified.", advance 4 s, then say the first two phrase words. The model request's `userText` equals those two words, so they would be committed to the turn and transcript.
- **Contract:** the spec (247-252) promises only a single whole-candidate compare, so this is within contract. The round-2 split-repeat protection now covers only 2.0-3.5 s.
- **Fix:** accept and record it in KNOWN_ISSUES, or keep assembling (with a flush) until the one repeat check is spent.

## Hunted, no new hole
- **Before a passed step-up:** no authority insert, personal-context read, model call or owner-only command.
  - `#handlePrompt` routes `pre_auth` owner calls to step-up (1307-1309).
  - Conversation requires `active` (1325).
  - DTMF during `owner_step_up` is a no-op (1416-1450).
  - The new `state()` read at 1236 sits before any sink.
  - The new clear branches (1272-1280, 1721-1724) never grant.
  - Waiver minting is unchanged.
- **Fail-open:** none. Every new throw (1186, 1720, 1731) fails toward retry or closure. `alarmClearFailed` rethrows only after the refusal, end and alert; its retry sees phase `rejected` and clears.
- **Counters:** attempt ordinals come from a D1 count, and re-prompts from `state()`. Eviction, alarm retry and the in-flight flag (reset in `finally`, 1228; false on a new core) do not reset them.
- **Candidate text:** the alarm record holds only session ID, generation, kind and deadline. Dropped mid-verify finals are never stored. The repeat fragments stay in memory. Nothing new is logged.
- **Spoofer holding owner slots:** N1 is closed. The only remaining route is the B2 retry exhaustion above, which requires a D1 outage of about 2 minutes or more.
