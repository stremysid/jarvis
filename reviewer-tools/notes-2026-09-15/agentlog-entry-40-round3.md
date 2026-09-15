## 2026-09-15 05:56 UTC — Claude Opus 5, PR #40 round-3 re-review at b0438d1: changes requested (small)

This round reviewed fix `4dddf9c` (head `07e1464`). It also covers the follow-up commits through `b0438d1`:
- `aec0da4`, a new test pinning refusal before alert delivery;
- `d51b9dd`, merging main `0d659bf`, which brings only the already-cleared #39;
- `KNOWN_ISSUES.md` labels.

The `0018` SQL is byte-identical to `337c290`.
- N1 (silent caller never hung up) and the B2 unavailable-core path are fixed and runtime-proven.
- S1's four contract gaps are closed. N2, F6, F7 and F14 are fixed.
- There is still no path to owner authority without the phrase.
- **One Medium remains:** N5, fault-triggered. A deadline rejection interrupted right after its durable write is never finished, so the caller hears no refusal and is never hung up on. The fix is small.

**Local checks on 07e1464** (Windows 11, `jarvis-pr40`; reviewer agents and the builder chats shared the machine).
- Lint, typecheck and `typecheck:voice-access` pass.
- **Serialized voice gate: run 1 passed 828 of 828, and run 2 passed 828 of 828.** S2 is fixed for the gate.
- `pnpm test` (parallel workspace): 2,768 of 2,771 passed. Two tests timed out: "commits the durable attempt ordinal before starting the 600,000-round verifier" at the 5 s default, and "keeps the dormant waiver exact, explicit, and inbound-only" at 30 s. One cascade followed in the same file (`call_session_transition_conflict`). Rerun alone, both files passed: 19/19 and 38/38.
- On the merged head `b0438d1` (`jarvis-pr39`), each run alone: `call-session-do.test.ts` 120/120 (including `aec0da4`'s ordering test), `voice-owner-call-step-up.test.ts` 19/19 and `cloud-memory-migration.test.ts` 133/133.

**Old probes, which must now FAIL:** all do.
- Round-2 verifier probes: the N1 assembly-alarm key deletion (both variants), B2 unavailable core, and N2 dropped short reply each fail, 4 of 4.
- Round-1 probes: B1, B3 and S1 stay fixed.

**Trigger coverage.** The `0018` SQL is unchanged since `337c290`, so the complete result carries over (`reviewer-tools/notes-2026-09-15/pr40-coverage-337c290.md`): **32 of 32 killed, 0 survived.**

**Contract gap ports on 07e1464** (`reviewer-tools/pr40-contract-gaps/RESULTS-07e1464.md`). BASE passed 217 of 217, and no run timed out except one that the gap-0 stub itself hung, which the kill doesn't depend on.
- Killed by genuine assertions: gap 0 (19), gap 1 (14), 2b (`voice-owner-call-step-up.test.ts:94`), 3b (`:675`), 3c (`:404` and `:593`), 6 (`:421`) and 6b (`:421` outbound).
- **Survived: 3d**, an extra variant. See S3.

**Adversarial re-verification** (Opus pass, `reviewer-tools/pr40-reverify2.md`). The reviewer reran its 5 runtime probes on `07e1464` (5 of 5 pass, so the bugs are real) and read the cited code for N5.
- **Fixed:**
  - B1/N1: the handlers own the key, and every path re-arms, clears or rejects, including early fires, finals during the KDF, eviction and races.
  - N2: short replies pass after the 3.5 s window.
  - F6 and F7.
  - F14: refusal now precedes the alert, and `aec0da4` pins the order.
- **Recorded in KNOWN_ISSUES** (acceptable before the attended smoke): F9, F10, F11, N3 and N4.

**B1 (N5, Medium, runtime-proven). A deadline rejection interrupted after the durable expire is never completed.**
- Silent spoofed call → deadline alarm → `#rejectOwnerStepUp` → `expire()` commits → the next D1 read (`getCallSession` 1159 or `binding()` 1172) or a relay send throws → `alarm()` throws and keeps the key.
- The runtime retry then sees `rejectionReason !== null` (`call-session-do.ts` 1278–1281), or after eviction a terminal session (1721–1724), and only clears the key.
- Result: no refusal line, no `end` frame (so no callback `<Hangup/>`), no owner alert, and the relay stays open until the caller hangs up. No authority is granted and no slot is held.
- This breaks the v1.0 rule that every unverified call ends at its deadline with the refusal line, `end`, `<Hangup/>` and an alert (design 229–235, 285).
- Proven by P1: `expire` commits then throws once, with and without hibernation.
- Fix: in `handleOwnerStepUpAlarm`, when `rejectionReason !== null` and this core is still `pre_auth`, complete `#rejectOwnerStepUp(observedAt, true)` idempotently instead of clearing. In `alarm()`'s mismatch branch, for a `rejected` session with a live socket, send the refusal and end frame, or close 1008, before clearing. Add P1 as a regression test.

**S1 (B2 residual, Low). Alarm retry exhaustion.** Durable Object alarms are retried a limited number of times with backoff, then abandoned. The reviewer did not re-verify the exact count. A D1 outage of about 2 minutes during a silent spoofed call would lose the deadline, and no `timeLimit` is set on the call. Fix: read `alarmInfo.retryCount` in `alarm()`, and near the limit re-arm `setAlarm(Date.now() + 30 000)` instead of throwing, or close the relay socket 1011 so Twilio ends the call. Test the fallback.

**S3 (test regression, runtime-proven by port 3d).** The fix removed the success-path sweep's strict `expect(logs.slice(beforeCandidate)).toEqual([])` (`voice-owner-passphrase-security.test.ts`, removed at diff line 139 against `337c290`). It was replaced by encoding-specific searches. A port that logs the admitted phrase as word-list indexes (`console.info("owner_step_up_verified_word_indexes 0-1-2")`) passes the whole contract in both directions. Restore the strict "no log records after the candidate" assertion alongside the encoding sweeps, so any log in any encoding fails.

**S2 (Lows).**
- N6, not proven: with refusal before the alert, a hang-up during the third check can throw on send and skip the alert. Wrap the refusal and end sends so the alert still runs when the send throws, and add a hang-up-during-KDF test.
- N7, proven by P7: after a pre_auth hang-up the alarm keeps its key and throws on every fire, which masks real outages. Clear the alarm in `handleSocketClose`, or clear on a terminal D1 session.
- N8, proven by P6: a late fragment plus the pending assembly alarm spend two re-prompts. Re-arm the window in the late branch.
- N9, proven by P5: a split phrase repeat after 3.5 s reaches the model and transcript. That is within the design's single-compare contract, so record it in KNOWN_ISSUES or keep assembling until the repeat check is spent.
- S1 test residual: leak sweeps search whole candidates only. Add the distinguishing words and base64/hex of the plaintext stored as text.
- The parallel workspace run still times out two KDF-heavy tests. Give "commits the durable attempt ordinal…" an explicit timeout like its siblings.

**Next.** Fix B1 (N5) and S1, address S2, and request re-review. The reviewer will rerun P1 and P5–P7, the contract ports and the gate. Expected to be the last round for #40 if nothing new appears. Then comes passphrase PR 3.

Sid retains merge authority. Merging makes `0018` available but applies nothing. Inbound calling stays closed. Nothing is applied or deployed.
