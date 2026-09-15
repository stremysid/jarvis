# PR #40 round-2 adversarial re-verification (fix head 337c290)

- **Scope:** `git diff 6b63d08 337c290`, read against adv40.md, pr40-adversarial.md and the design spec.
- **Mode:** reading plus 4 runtime probes (Miniflare fake harness, Windows 11, one vitest process). No commit, no push, nothing remote.
- **Line numbers** are at 337c290.
- **Probes:** `zz-verify-b2-alarm.test.ts` and `zz-verify-s1-repeat.test.ts`, beside this file. Each asserts that the bug exists, so a pass means the hole is real. They belong in `tests/acceptance/fake/`. Run from the repo root: `npx.cmd vitest --config vitest.workspace.ts run tests/acceptance/fake/zz-verify-b2-alarm.test.ts tests/acceptance/fake/zz-verify-s1-repeat.test.ts`. Result: 4 of 4 passed (bug confirmed), 6.0 s.

## Verdict

B1, B3, S1 and S2 are fixed. **B2 is only partly fixed, and the fix adds a new High regression (N1).** No authority bypass was found. The step-up still fails closed on every authority path I traced.

## Round-1 items

### B1: INSERT/UPDATE OR REPLACE on 0018 tables. FIXED.
- **WITHOUT ROWID:** all 9 tables are now `STRICT, WITHOUT ROWID` (0018:15, 25, 39, 49, 63, 70, 80, 87, 102). No rowid exists, and there are no secondary UNIQUE indexes.
- **Insert guards:** each guard now opens with an existing-primary-key `EXISTS` check, at bindings 106-109, windows 160-164, attempts 198-203, successes 276-279, reprompts 344-349, rejections 388-391, repeat_checks 435-438, guest PIN 475-479, and the new alerts guard 504-514. A BEFORE INSERT trigger fires before REPLACE conflict resolution, so REPLACE raises before the old row is deleted.
- **UPDATE OR REPLACE:** bindings, windows, successes, rejections, reprompts and guest PIN attempts reject every UPDATE. Attempts (233-237) and repeat_checks (459-460) pin their key columns. Alerts gained a key guard (516-523).
- **Read-then-insert:** `bind()` (owner-call-step-up.ts:143-161), `begin()` (169-192) and `expire()` (239-248) now read before inserting. A sequential retry returns the existing row. `bind()` throws `binding_conflict` if the snapshot differs.
- **Reverting tests (owner-call-step-up-migration.test.ts):**
  - "rejects INSERT OR REPLACE across every 0018 table and pins mutable alert keys"
  - "keeps bind, begin, and expiry retries idempotent with guarded inserts"
  - the `WITHOUT ROWID` assertion in the schema test
- **Caveat (not a hole):** the sweep isolates the existing-key clause only for bindings, windows, repeat_checks and alerts. On attempts, reprompts, successes, rejections and guest PIN attempts, the shape clause raises anyway: either the session is no longer `pre_auth`, or ordinal = count+1 cannot collide. The new clauses there are redundant, not untested gaps.
- **Not proven remotely:** `STRICT, WITHOUT ROWID` and the new `WHEN EXISTS ... OR ...` guards have not been run on remote D1. 0018 still has 0 `CASE` and 0 recursive CTEs.

### B2: alarm key deleted before handling. PARTIAL, with a new regression.
- **What is fixed:** `alarm()` (call-session-do.ts:1692-1705) now deletes the key after the socket loop (1704). If the handler throws, the key survives.
  - Reverting test: voice-owner-call-step-up.test.ts "retains the durable deadline alarm when the first handler attempt throws".
- **Still open (RUNTIME-PROVEN, probe 3):** `#resolveCore` returns `unavailable` on a D1 read error (1986-1987) or a factory error (1993, 2006). `alarm()` skips handling, returns normally, and still deletes the key. This is the exact step 3 of round-1 F5, and it was not addressed.
  - Probe: evict the core, make the `call_sessions` read fail (table renamed), fire the alarm past the deadline, then restore the table. The key is gone, a second alarm does nothing, and the phase stays `pre_auth`.
- **New regression:** see N1.
- **Double-end, double-alert or double-count on retry:** not found.
  - `expire()` is read-then-insert.
  - A cached core that already moved to `rejected` returns early (1261).
  - A rebuilt core on a terminal session resolves to `mismatch` (1989-1991).
  - Attempts and reprompts are durable ordinals.
- **Residual (L, not proven):** if anything after `expire()` throws inside `#rejectOwnerStepUp`, the call is `rejected` in D1 but the refusal line and `end` are never sent. Examples: `clear()` at 1159, `binding()` at 1160, or `sendNeutralText` at 1174. A retry finds `rejected` and does nothing more. A rejected session no longer holds capacity.

### B3: waiver ignores a disabled or unconfigured verifier. FIXED.
- **SQL:** the authority trigger's waiver branch (0018:547-559) requires an active head for `NEW.principal_id/identity_id` joined to its current, active verifier.
- **DO:** `assertWaiverAvailable` (owner-call-step-up.ts:250-265) runs before `#mintWaivedOwner` (call-session-do.ts ~903).
- **Repository:** the rehydrate path (voice-access-repository.ts:1381-1391) and the current-authority path (1577-1587) both require an active head and verifier.
- **Race (head disabled between bind or assert and the authority insert):** the trigger re-checks inside the INSERT statement, so the insert RAISEs, `handleRelayEvent` throws, and the socket closes 1011 with 0 authority rows. A disable after minting is caught by the current-authority check on the next turn, before the model runs. Fails closed.
- **Reverting tests:**
  - voice-owner-passphrase-security.test.ts "refuses the Passed-A waiver when the current verifier is no longer active"
  - call-session-do.test.ts "checks the active verifier before a Passed-A waiver reaches authority minting"
  - the verifier-revoke block added to voice-access-repository.test.ts

### S1: split-final repeat after "Verified.". FIXED, with a Low side effect (N2).
- `#guardOwnerRepeat` (call-session-do.ts:1094-1144) runs before every sink (1310-1313) and assembles 1-3 word-list fragments within 1.5 s.
- An assembly that exceeds 3 words is dropped and never flushed.
- Reverting test: voice-owner-passphrase-security.test.ts "assembles and suppresses a split post-success phrase repeat before any sink".

### S2: voice-gate timing. FIXED (explicit timeouts), not measured.
- Timeouts of 15-20 s were added to the four named tests: voice-call-path (inbound 5xx cleanup), voice-guest-access (hibernation limit), the voice-owner-call-step-up success receipt, and the KAT in voice-owner-passphrase-security.
- The new migration tests have 15 s and 30 s timeouts.
- Gate concurrency is unchanged. I did not rerun the full gate.

### Lows from adv40.md: all STILL OPEN. None is fixed or documented.
The resubmit entry does not mention them, and KNOWN_ISSUES.md is unchanged by the fix commit.
- **F6, eviction deadline restore:** the constructor (748-763) does not load the deadline. `#ownerStepUpDeadlineAt` is set only at 805, 907 and 1265. Open.
- **F7, mid-verify final:** `#handleOwnerStepUpPrompt` (1225-1240) has no in-flight check. The final is pushed and arms an assembly alarm, which overwrites the window key. Open.
- **F9, `resolved_at` before the KDF:** `resolvedAt = iso(now)` (owner-call-step-up.ts:219) uses the pre-KDF clock. Open.
- **F10, verifier crash:** there is no `finally` resolving the stranded ordinal (212-222), so the call ends 1011 with no refusal, alert or `<Hangup/>`. Open.
- **F11, outbound slot reservation:** it still requires exactly `2 = count(pre_auth)` (call-repository.ts:901-907). Open.
- **F14, alert awaited before the refusal:** 1161-1174. Open.

## New findings

### N1: H (availability, no authority granted). RUNTIME-PROVEN (probes 1-2). One short utterance makes the 60 s deadline unenforceable.
- **Where:**
  - call-session-do.ts:1244-1247 (the assembly alarm overwrites the single alarm key)
  - 1284-1286 (the assembly handler re-arms the window with put key + setAlarm)
  - 1704 (`alarm()` then deletes the key unconditionally)
  - 1270-1275 (the same pattern on an early window fire)
- **Scenario:**
  1. A spoofed owner-number call reaches `pre_auth`.
  2. The caller says one word (for example "hello" or "ablaze").
  3. At +1.5 s the assembly alarm records re-prompt 1, speaks "Please say only your passphrase.", and re-arms the window alarm.
  4. `alarm()` deletes the key it just wrote.
  5. At T+60 the scheduled alarm finds no key and clears itself (1694-1697).
  6. The caller stays silent, so the frame-path deadline check (1228) never runs.
- **Result:** the call stays `pre_auth` with no rejection. Two such calls hold both owner call-session slots, so Sid's own inbound calls are refused, with no D1 failure needed. This is round-1's B2 harm, made trivially triggerable by the fix. Before the fix, the handler's re-arm survived because the delete came first.
- **Proof:** with and without hibernation, the key is missing after the assembly alarm, and after +60 s the phase is still `pre_auth` with no rejection row.
- **Not proven:** real Twilio or Durable Object alarm scheduling. No call `timeLimit` is set in the source.
- **Missed by tests:** "caps non-candidate assembly re-prompts" always reaches 3 re-prompts and never checks the deadline after one or two.
- **Fix:**
  - In `alarm()`, delete the key only if storage still holds the exact record read at entry. Better, let the handlers own the key.
  - On `unavailable`, throw so the runtime retries.
  - Add a test with 1 assembly alarm, silence, and a deadline that rejects.

### N2: L (functional). RUNTIME-PROVEN (probe 4). Short owner utterances made only of word-list words are silently dropped after "Verified.".
- **Where:** `#guardOwnerRepeat` 1115-1122, 1133-1139.
- **Scenario:**
  1. While the one repeat check is unspent, any 1-2 word final made only of the 2048 list words is buffered and returned `null`.
  2. If no fragment follows within 1.5 s, the buffer is dropped, never flushed to the model.
  3. The repeat check stays unspent, so this lasts for the whole call.
- **Proof:** "good" (a list word), said twice 5 s apart, produced 0 model requests.
- **Not a leak:** it is the S1 fix over-suppressing. "confirm", "cancel" and the spoken PIN digits are not in the list, so owner access flows are unaffected.
- **Fix:** bound the repeat guard to a short post-success window. Or flush a timed-out buffer as ordinary speech.

### N3: L. NOT PROVEN. Concurrent duplicate delivery of bind now errors instead of no-op.
- **Where:** owner-call-step-up.ts:143-155 and 239-247.
- **Scenario:** two overlapping webhook deliveries both read null. The second INSERT RAISEs (`binding_invalid` or `rejection_invalid`), so the caller gets a 5xx. `ON CONFLICT DO NOTHING` used to absorb this.
- **Impact:** fails closed. Availability only.
- **Fix:** catch the guard error, re-read, and return the row if it matches.

### N4: L. NOT PROVEN. Out-of-order resumption can pass mis-ordered phrase words to the model.
- **Where:** `#guardOwnerRepeat` 1096 then 1125.
- **Scenario:**
  1. D1 is an I/O await, so two post-success fragment finals can interleave.
  2. If the second resumes first, the assembly holds the real words in the wrong order.
  3. The single repeat compare mismatches and `continue` returns the joined text to the model and transcript.
- **Condition:** needs STT split finals plus reordered D1 responses. Speculative.
- **Fix:** serialize prompt handling per core (a promise chain) before reading the fragment buffer.

## Checked, no new hole found
- **Before a passed step-up:** no owner authority, model call, personal context or owner-only command.
  - `#handlePrompt` routes `pre_auth` to step-up (1290).
  - Conversation needs phase `active` (1308).
  - The waiver mints only through the trigger-checked insert.
- **Attempt and re-prompt counters:** durable ordinals. Neither eviction nor alarm retry resets them.
- **Candidate text:** reaches no DO storage, events, logs or alerts on the wrong-phrase or rejection paths. Repeat fragments stay in memory only and are cleared on interrupt and terminal transitions. A mismatched candidate-shaped final still reaches the model by design (spec 247-252).
- **Alert sink rewrite:** the INSERT...SELECT...WHERE NOT EXISTS then UPDATE is single-statement atomic on D1, so the new alerts guard does not break coalescing.
- **Remote D1 rules:** 0 `CASE`, 0 `RECURSIVE`, and `RAISE` appears only in `SELECT RAISE` trigger bodies.
