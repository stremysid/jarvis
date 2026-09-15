## 2026-09-15 04:40 UTC — Claude Opus 5, PR #40 re-review at 337c290: changes requested

This is the max re-review of fix commit `337c290` against the round-1 review (`8b56b13`, corrected by `587d884`). The branch merges cleanly with main at `2619f02`. No path to owner authority without the phrase was found, and B1, B3 and S1 are fixed and runtime-proven. The B2 alarm fix is incomplete and opens a new availability hole (N1): one spoken word followed by silence keeps a spoofed call open with no deadline. The contract tests also still accept four deliberately broken implementations.

**Local checks on 337c290** (Windows 11, `jarvis-pr40`). The machine was never truly idle: the builder chats' own test runs were active in the ChatGPT app.
- Lint, typecheck and `typecheck:voice-access` pass.
- `pnpm.cmd test:voice-access`: run 1 passed 813 of 815. Both failures were "Test timed out in 5000ms" in `voice-owner-call-step-up.test.ts`: the three-mismatch handoff test and "does not carry a rejected call's three attempts". Run 2 passed 815 of 815.
- `pnpm.cmd test`: 2,734 of 2,758 passed. Of the 24 failures, 18 were 5 s timeouts and 6 were cascades from them (`fake_call_not_initialized`, an undefined phase, `call_session_transition_conflict`, 503 vs 204), across 7 files.
- Each of those files rerun alone passed: archival 46/46, step-up migration 11/11, call-session-do 118/118, guest access 10/10, owner step-up 15/15 and passphrase security 30/30. The exception was `voice-call-path`, 17 of 18, with one 5 s timeout while trigger removals were running.
- S2 is therefore only partly fixed. Other KDF-heavy step-up tests beyond the four given explicit timeouts still hit the 5 s default. Either raise their timeouts or lower the gate's file concurrency, so `release:voice-gate` doesn't flake.

**Old probes, which must now FAIL** (`reviewer-tools/pr40-probes/`; each passed on `6b63d08`):
- B1a/b/c REPLACE on bindings, windows and repeat_checks: refused (`owner_call_step_up_{binding,window,repeat}_invalid`).
- The 9-table REPLACE sweep matrix is clean.
- B3, waiver with the head removed: the authority insert RAISEs `call_session_authority_requires_current_lineage`.
- S1, split-final repeat: fragments no longer reach the model.
- **B2 still passes** (see below).

**Contract gap patches** (`reviewer-tools/pr40-contract-gaps/`). The 7 #33 gap patches don't apply to #40's code, so each was ported by hand as the smallest faithful change, with 4 extra variants. A kill counts only on a genuine assertion failure; no run timed out. BASE passed on both heads (198/198, then 204/204).
- Killed: gap 0 (never-accepting stub), 1 (success-path leak into the model), 2a (attempt count in memory only), 3a (success-path copy in the journal text), 4 (padded " TN-Validation-Passed-A" waiving), 5 (missing policy masked) and 6 (inbound keypad bypass).
- Survived on `6b63d08`: 2b, 3b, 3c and 6b.
- Rerun on `337c290`: gap 1 was re-anchored on `#guardOwnerRepeat` and is still killed (13 failures). Gaps 2b, 3b, 3c and 6b **still survive**, with 164 of 164 contract tests green and each survivor's probe confirming the broken behaviour (S1 below).

**Trigger coverage** (`mut40c-c1..c2.json`, regenerated from the 337c290 SQL with `gen-trig.mjs`; 32 triggers; each removal runs `owner-call-step-up-migration.test.ts` and `call-session-do.test.ts`).
- **Partial:** BASE passed. The first 5 removals were all killed with 0 timeouts: bindings insert, immutable and delete, and windows insert and immutable.
- None matched a test by name, so each was checked by hand. The binding snapshot pin, the 60-second window guard and the REPLACE sweep tests failed in 0.8–4 s.
- The run was stopped so the voice gate could be timed on an idle machine. **The other 27 triggers are not yet measured.** They will be before any clearance; the B1/B2 fixes should not need SQL changes.

**Adversarial re-verification** (Opus pass, `reviewer-tools/pr40-reverify.md`). The reviewer reran its 4 runtime probes on `337c290` (4 of 4 pass, so the bugs are real) and read the cited code for N1 and B2.
- **Fixed:** B1 (all 9 tables `STRICT, WITHOUT ROWID`, an existing-key clause on every insert guard, keys pinned on attempts, repeat_checks and alerts, read-then-insert `bind/begin/expire`), B3 (active head and verifier required in the authority trigger, `assertWaiverAvailable` and both repository paths; a disable mid-setup makes the trigger RAISE) and S1.
- **S2:** explicit timeouts. See the local checks for the gate count.

**B1 (N1, High, runtime-proven). One word, then silence, disables the 60-second deadline.**
- The call-session DO keeps a single alarm key.
- An assembly alarm (after one short utterance) records re-prompt 1, speaks the format prompt and re-arms the window: `handleOwnerStepUpAlarm` 1284–1286 puts the key and calls setAlarm.
- `alarm()` then deletes that key unconditionally at `call-session-do.ts:1704`.
- At the deadline, the scheduled alarm finds no key and just clears itself (1694–1697). The caller stays silent, so the frame-path deadline check never runs, and the call stays `pre_auth` with no rejection.
- An early window fire has the same shape (1270–1275).
- Consequence: two spoofed calls from Sid's number hold both owner call slots and refuse Sid's own inbound calls, with no D1 failure needed. That is round-1's B2 harm, now trivially triggerable. The existing "caps non-candidate assembly re-prompts" test always reaches 3 re-prompts and never checks the deadline after 1.
- Fix: have `alarm()` delete the key only if storage still holds the exact record it read at entry, or let the handlers own the key.
- Test: 1 assembly alarm, then silence, and the call must be rejected with the refusal line and `<Hangup/>` at the deadline, with and without hibernation.

**B2 (round-1 B2 residual, runtime-proven). An unavailable core still loses the deadline.** When `#resolveCore` returns `unavailable` after eviction (a D1 read error at 1986–1987, or a factory error at 1993 or 2006), `alarm()` skips handling, returns normally and deletes the key. No retry follows, and the call stays open. Fix: throw from `alarm()` when any socket's core is not `ready`, so the runtime retries, and keep the key. Test: evict, make the session read fail once, fire past the deadline, restore, then the retry must end the call.

**S1: four broken implementations still pass the contract.** Each port is in `reviewer-tools/pr40-contract-gaps/port337-gap*.diff` or `port-gap6b.diff`. Each needs a test that fails on its port.
- **2b: exhaustion after a wake is silent.** The attempt rows stay durable, but the rejection is decided from an in-memory counter. After a hibernation wake, the third wrong phrase marks the call rejected in D1, yet the caller hears the retry prompt. No refusal line, end frame or owner alert follows, even after the 60-second alarm. The hibernation test (`voice-owner-call-step-up.test.ts:70`) must also assert the refusal speech, the end frame with its handoff, and exactly one alert.
- **3b: wrong candidates leak.** No test sweeps the mismatch or rejection path. With the port logging every wrong candidate (console warn, info and error), echoing it in the retry prompt, and journaling it to DO KV and SQLite, all contract tests pass. The run printed `owner_step_up_rejected <cand> | <cand> | <cand>`. The three-mismatch test (`voice-owner-passphrase-security.test.ts:563`) must spy on every console method and sweep relay frames, DO storage (KV and SQL) and D1 for each candidate.
- **3c: the admitted phrase can hide in encodings.** The port stores the phrase as bytes, a base64 SHA-256, uppercase text, SQLite and D1 blobs, and a `console.dir` call. The sweep (`:297`/`:342`) passes because `evidenceText` renders bytes as number arrays, matches case-sensitively and doesn't spy on `console.dir`, `trace` or `table`. The sweep must decode byte arrays and blobs to text, match case-insensitively, check the digest forms, and spy on every console method.
- **6b: keypad bypass on outbound calls.** The port admits an outbound owner on keypad `4827` while inbound stays gated. The keypad test (`:351`) covers inbound only. Run it for both directions and several codes.

**S2 (N2, Low, runtime-proven). Short owner replies can be silently dropped after "Verified."** `#guardOwnerRepeat` (1094–1144) buffers any 1–2 word final made only of passphrase-list words while the single repeat check is unspent. That can last the whole call, and a timed-out buffer is discarded, not flushed. The list contains everyday words ("good" at word-list line 859, "next" at 1170); saying "good" twice produced 0 model requests. Fix: bound the repeat guard to a short post-success window, or flush a timed-out buffer as ordinary speech. Add a test.

**Lows** (still open from round 1 and not mentioned in KNOWN_ISSUES; fix or record each):
- F6: eviction doesn't restore the deadline (constructor 748–763).
- F7: a mid-verify final arms an assembly alarm over the window key (1225–1240). N1's fix must cover this.
- F9: `resolved_at` is stamped before the KDF (owner-call-step-up.ts:219).
- F10: a verifier crash strands the ordinal and ends with 1011, with no refusal line, alert or `<Hangup/>` (212–222).
- F11: the outbound slot reservation requires exactly `2 = count(pre_auth)` (call-repository.ts:901–907).
- F14: the alert is awaited before the refusal (1161–1174).

**New lows, not proven:**
- N3: overlapping duplicate webhook deliveries now get a guard RAISE (5xx) instead of a no-op. Catch it, re-read, and return a matching row.
- N4: interleaved post-success fragments can be assembled out of order and passed to the model on mismatch. Serialize prompt handling per core.

**Remote D1.** 0 `CASE`, 0 recursive CTEs, and `RAISE` appears only in `SELECT RAISE` bodies. `STRICT, WITHOUT ROWID` and the new `WHEN EXISTS … OR …` guards are unproven on remote D1, so add them to the attended scratch proof before any apply.

**Next.** Fix B1 and B2 first; they are the call-must-end guarantee. Then add the S1 contract tests and fix S2 plus the lows or record them. Request re-review; it reruns every probe above (N1 and B2 must fail) and the contract gap ports (all must be killed).

Sid retains merge authority. Merging makes `0018` available but applies nothing. Inbound calling stays closed. Nothing is applied or deployed.
