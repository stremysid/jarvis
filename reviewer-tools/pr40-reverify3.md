# PR #40 round-4 adversarial re-verification (fix df394cb, head 623c64a)

- **Scope:** `git diff b0438d1 623c64a`, read against the round-3 review (AGENT_LOG 05:56), pr40-reverify2.md, the builder entry (06:21) and the design spec.
- **Mode:** reading plus runtime probes. Worktree `C:/Users/Sid/jarvis-pr40-verify4` (since removed); Windows 11; one vitest process at a time. No commit, no push, nothing remote. Round-3 probes and contract ports were not rerun (the reviewer owns them).
- **Line numbers** are at 623c64a. `csdo` = `apps/cloud-gateway/src/voice/call-session-do.ts`.
- **Probes** (beside this file):
  - `pr40-reverify3-core-probes.test.ts`: append to `apps/cloud-gateway/test/voice/call-session-do.test.ts` (uses `accessHarness`). Q1c, Q2c, Q3c and Q6c each assert that the hole EXISTS. **4 of 4 pass, so all four holes are real.**
  - `pr40-reverify3-probes.test.ts`: goes in `tests/acceptance/fake/`. Q4 and Q5 are observations that end in a deliberately failing `REPORT` assertion, which prints the measured values. Q1 is a DO-level attempt that the harness cannot run (concurrent `runInDurableObject` calls fail with "Cannot perform I/O on behalf of a different Durable Object"), so it was superseded by Q1c.
  - Run: `npx.cmd vitest --config vitest.workspace.ts run <file> -t reverify3` (or `-t Q6c`).

## Verdict

- **No path to owner authority without the phrase.**
- **No path that ends or alerts a verified call.**
- **No fail-open.**
- **No phrase-candidate leak** in the new paths.
- **B1 (N5) is fixed** for the reviewed scenario (cached core and after eviction), and S1, S3 and S2 are addressed.
- **New findings are all Low.** Every one fails closed and needs either a race with the deadline alarm or an infrastructure fault:
  - duplicate refusal/end/alert (runtime-proven);
  - alert lost under a double fault (runtime-proven);
  - close-handler ordering (runtime-proven).
- **Nothing blocks clearance.** I recommend the one-line idempotency guard (L1) before the attended smoke, because the race in L1 needs no fault: a caller speaking right at the deadline is enough.

## Round-3 items

### B1 (N5 Medium): interrupted deadline rejection. FIXED.
- **Cached core:** `handleOwnerStepUpAlarm` now accepts phase `pre_auth` or `rejected` (csdo 1280). When `state.rejectionReason !== null`, it completes via `#rejectOwnerStepUp(observedAt, true)` (1287-1291) instead of clearing.
- **After eviction:** the alarm resolves its core with `resumeRejected=true` (1746). `#resolveCore` then admits a `rejected` session (2045). A genuine mismatch now closes the socket 1008 before clearing (1748-1752).
- **Retry safety in `#rejectOwnerStepUp`:**
  - Every read that can throw (`getCallSession` 1159, `binding` 1163) happens before any send.
  - `expire()` is idempotent (`owner-call-step-up.ts` 240-249), and `alreadyDurable` skips it.
  - The rejection row is single by trigger (0018:386-391), so there is no second rejection row.
  - The alarm is cleared last (1189), so a failure anywhere leaves the key for the retry.
  - The refusal and end sends are wrapped (1166-1175), so a socket that already closed cannot stop the alert.
- **Idempotency:** holds for the tested sequence (fail, retry, second fire gives 1 refusal, 1 alert, 1 row). It does **not** hold for concurrent or partial-clear cases; see L1 and L2.
- **Reverting tests:**
  - `voice-owner-call-step-up.test.ts:286` "finishes a committed deadline rejection after a failed alarm (hibernate=false/true)" asserts 1 refusal, the end frame, 1 alert, key cleared, a second fire giving no duplicate, 1 rejection row and callback `<Hangup/>`.
  - `:320` "closes a live socket when an evicted alarm can no longer match its durable session".

### S1: alarm retry exhaustion. FIXED. Matches the docs; no loop.
- **Cloudflare docs** (developers.cloudflare.com/durable-objects/api/base/, `alarm`): at-least-once delivery, retried on an uncaught exception with exponential backoff starting at 2 s, "for up to six retries"; `alarmInfo.retryCount` is the retry count.
- **Implementation:** `alarm(alarmInfo)` (csdo 1725-1734) rethrows while `retryCount < 5`. At retry 5, which is the sixth invocation, about 62 s of cumulative backoff, it closes every socket 1011, clears the key and returns normally. One documented retry is left unused as margin.
- **Looping:** it cannot loop. The exhaustion path never calls `setAlarm`, and it returns successfully, so the runtime schedules nothing further. A genuinely dead session (no socket) throws `!handled` (1759) through retries 0-4, and then retry 5 clears. Nothing keeps a slot or socket alive past that.
- **Twilio end:** after a 1011 close, the relay-ended callback carries no handoff data and gets a 204 (`http/voice-callbacks.ts` 177). The TwiML has nothing after `<Connect>` (`voice/twiml.ts` 93), so the call ends. Read only, not runtime-proven.
- **Residuals (Low, recorded in L4):**
  - The exhaustion close sends no refusal or alert, and leaves D1 `pre_auth` until the callback terminates the session.
  - That the runtime actually passes `retryCount` is not provable here: the harness passes it by hand (`voice-relay-system.ts` 257).
- **Reverting test:** `voice-owner-call-step-up.test.ts:337` "closes the relay before repeated alarm failures exhaust the runtime retry budget" (retry 4 rethrows with no close; retry 5 closes 1011 and clears).

### S3: strict success-path log assertion. RESTORED.
- `voice-owner-passphrase-security.test.ts:391` `expect(logs.slice(beforeCandidate)).toEqual([])`, directly after the successful candidate and before the phase checks.
- The word-index port (3d) would fail here. Code-confirmed only; the port rerun belongs to another agent.

### S2 lows
| Item | Status | Evidence | Reverting test |
|---|---|---|---|
| N6 refusal/end failure skips alert | FIXED | csdo 1166-1175: the refusal send is wrapped; `end` failure falls back to `close(1008)`, itself wrapped; the alert (1176-1188) always runs | `call-session-do.test.ts:1124` "alerts the owner when the relay disconnects during the third KDF (close throws=false/true)" |
| N7 alarm left after pre_auth hang-up | FIXED | csdo 1559: `handleSocketClose` clears first. Terminal-session alarm fires also clear (1280-1283). A new ordering hole: L3 | `voice-owner-call-step-up.test.ts:359` "clears a pre-auth hang-up's alarm without waiting for a retry (hibernate=…)" |
| N8 late fragment double re-prompt | FIXED (small residual race, L5) | csdo 1251-1256 re-arms the window before the format prompt | `:373` "re-arms the deadline after a late fragment…" |
| N9 late split repeat | RECORDED | `KNOWN_ISSUES.md:3` | n/a (accepted design tradeoff) |
| Leak sweep: words and base64/hex plaintext | FIXED | `voice-owner-passphrase-security.test.ts:307` `plaintextForms` (whole value plus each `[a-z]+` word, each as raw, base64 and hex, lower-cased); used on success (413) and mismatch (685). The mismatch fixtures were changed to distinctive words so a word-level leak can't hide | those sweeps |
| Explicit timeout on "commits the durable attempt ordinal…" | FIXED | `voice-owner-call-step-up.test.ts:437`, closing `}, 30_000);` at 461 | n/a |

## New findings

### L1: Low. RUNTIME-PROVEN (Q1c, Q2c). A rejection racing the deadline alarm is completed twice.
- **Where:** csdo 1287-1291. The new rejected branch has no in-memory "rejection already completed or in progress" guard. Because 1280 now admits phase `rejected`, and the alarm clear moved to after the alert (1189), the window is wide.
- **Scenario:**
  1. A frame-path rejection is running: the caller speaks at or after the deadline (1242-1243), or a third mismatch or re-prompt exhaustion occurs (1200, 1210, 1250).
  2. It is awaiting `binding()` or, more realistically, the alert sink, which is D1 plus a Telegram HTTP call.
  3. The deadline window alarm fires (it is scheduled exactly at the deadline). Workerd lets it interleave at non-storage I/O.
  4. The alarm sees `rejectionReason !== null` and runs `#rejectOwnerStepUp` again.
  - This needs no fault.
- **Result:** two refusal lines, two `end` calls (or `close(1008)`), and two alert calls.
  - The real `D1OwnerStepUpAlertSink` coalesces the second alert (claim still live), so Sid gets one Telegram message, but `observation_count` is inflated.
  - No authority is granted. The call is still rejected and ended.
- **Proof:**
  - Q1c: `binding()` blocked on the frame path, then the alarm fires.
  - Q2c: the alert mock blocked, the alarm fires, and `instance.phase === "rejected"`.
  - Both show refusals=2 and alerts=2.
- **Fix:** add a `#ownerStepUpRejection: Promise<void> | null` field in `#rejectOwnerStepUp`. Callers await the in-flight or completed promise, and the promise resets to null only on throw. The alarm's rejected branch then just awaits it or clears.

### L2: Low. RUNTIME-PROVEN (Q3c). A failed final alarm clear repeats the whole rejection on retry.
- **Where:** csdo 1189. `clear()` throwing, after the refusal, end and alert, makes `alarm()` rethrow. The retry (cached core, phase `rejected`) re-enters 1287-1291.
- **Result:** a second refusal, end and alert call. Needs a DO storage `delete` or `deleteAlarm` failure.
- **Fix:** the same guard as L1: once completed, the retry only clears.

### L3: Low. RUNTIME-PROVEN (Q6c). A throwing alarm clear in `handleSocketClose` skips the `failed` transition.
- **Where:** csdo 1559. `clear()` runs before `#socketClosed = true` and before the transition.
- **Result:**
  - A storage failure leaves D1 `pre_auth` after the hang-up. That counts against the connected pre_auth owner slot until the relay-ended callback terminates the session.
  - The alarm, still keyed, then throws `!handled` through retry 5.
- **Fix:** wrap the clear (`try { … } catch {}`) or move it after the transition.

### L4: Low. RUNTIME-OBSERVED (Q4, Q5). An interrupted rejection plus eviction plus the socket closing before the retry means no alert ever.
- **Where:** `webSocketMessage` and `webSocketClose` call `#resolveCore(socket)` without `resumeRejected` (csdo 1982, 2006). A `rejected` session is therefore a `mismatch`:
  - a frame is closed 1008 with no refusal, and the alarm is not cleared;
  - a close skips `handleSocketClose`, so the alarm is not cleared.
  - The next alarm finds no socket and throws `!handled` (1759) until retry 5 clears silently.
- **Observed:**
  - Q4 (hang-up): key present after close; retry 1 threw `owner_step_up_alarm_runtime_unavailable`; retry 5 returned; alerts=0, refusals=0.
  - Q5 (caller speaks): closeCodes=[1008]; retry 1 threw; alerts=0, refusals=0, key still present.
- **Impact:** the caller is gone either way (a 1008 close gives a 204 callback, so Twilio ends the call). Only Sid's alert is lost, and only under a double fault (a D1 error right after `expire` commits, plus eviction, plus a frame or hang-up within the ~2 s retry gap). The same class covers exhaustion: the retry-5 close (S1) sends no alert.
- **Fix (optional):** in `alarm()`, when no socket is handled and D1 says `rejected` for this session, send the alert (the binding is in D1) before clearing. Otherwise record it in KNOWN_ISSUES.

### L5: Low. Not proven (reading). A small N8 residual.
- **Where:** csdo 1249-1252. The late branch awaits `recordReprompt` (D1) before re-arming. An assembly alarm firing inside that await still records a second re-prompt.
- **Impact:** fails closed; the window is only the D1 round trip.
- **Fix:** re-arm the window before `recordReprompt`.

## Hunted, no new hole
- **Verified call ended or alerted by the retry:** impossible.
  - A rejection row requires `pre_auth` and no success row (0018:386-396), and the success path requires no rejection row (0018:225, 360), so the two verdicts exclude each other in D1.
  - `#rejectOwnerStepUp` refuses unless D1 phase is `rejected` (1160).
  - The rejected branch only runs when a rejection row exists.
  - A verified core has interaction `conversation`, so 1280-1283 only clears.
- **Authority before a passed step-up:** none. `resumeRejected` is used only by `alarm()`, and a core built from a `rejected` session can reach only `handleOwnerStepUpAlarm`. `#handlePrompt` requires `pre_auth` for step-up (1322) and `active` for conversation (1340). Frame and close paths still treat `rejected` as a mismatch.
- **Fail-open:** none. The new catches (1166-1175, 1726-1733) either keep rejecting or close 1011. Retry exhaustion closes rather than keeping anything open.
- **Candidate text:** the new code handles only the session ID, alarm kind, deadline, refusal constant, handoff constant and binding metadata. The alarm error paths (1747, 1759) carry fixed strings. Nothing new logs, stores or alerts candidate text.
- **Slots and sockets after exhaustion:** retry 5 closes every socket and clears; no re-arm. The D1 `pre_auth` row stays until the callback, as before (F11 and B2, recorded).
