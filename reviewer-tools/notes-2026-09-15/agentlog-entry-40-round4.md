## 2026-09-15 06:54 UTC — Claude Opus 5, PR #40 round-4 re-review at 623c64a: cleared with follow-ups F1–F5

This round reviewed fix `df394cb` (head `623c64a`, includes main `0d659bf`). The `0018` SQL is byte-identical to `337c290`, so the reviewer's 32 of 32 trigger coverage carries over. There is no path to owner authority without the phrase, and every unverified call now ends at its deadline with the refusal, end frame, `<Hangup/>` and one alert, including after a mid-rejection fault and eviction. What remains is Low and fails closed, and goes into passphrase PR 3.

**Local checks on 623c64a** (Windows 11, `jarvis-pr40`): lint, typecheck and `typecheck:voice-access` pass. **Serialized voice gate: 838 of 838.**

**Round-3 probes, which must now FAIL:**
- P1, the interrupted deadline rejection, fails both with and without hibernation.
- P6, the late fragment spending two re-prompts, fails.
- P7, the alarm key surviving a pre_auth hang-up, fails.
- P5, the split repeat after 3.5 s, still passes. That is the documented N9 limitation, now recorded in KNOWN_ISSUES.

**Contract gap ports on 623c64a** (`reviewer-tools/pr40-contract-gaps/run623-*.txt`, `port623-*.diff`). BASE passed 227 of 227. **All 9 are killed** by genuine assertions, with no load timeouts:
- gap 0 (17 assertions; 3 hangs caused by the stub itself, not counted) and gap 1 (14);
- 2b (`voice-owner-call-step-up.test.ts:96`) and 3b (`voice-owner-passphrase-security.test.ts:686`);
- 3c (`:391`, `:604`), 3d (`:391`, the restored strict no-logs assertion), and the new 3e, a hyphen-joined phrase in `console.log` (`:391`);
- 6 and 6b (`:432`, inbound and outbound).

The round-3 S3 regression is fixed.

**Adversarial re-verification** (Opus pass, `reviewer-tools/pr40-reverify3.md`).
- **Fixed:**
  - B1/N5: an interrupted rejection is completed on retry for a cached core and after eviction, with no second rejection row (`voice-owner-call-step-up.test.ts:286`, `:320`).
  - S1: at alarm retry 5 the sockets close with 1011 and the alarm clears. That matches Cloudflare's documented retry limit and can't loop.
  - S3.
  - N6: refusal and end failures can't skip the alert.
  - N7: the alarm clears on a pre_auth hang-up.
  - N8: the late fragment restores the window.
  - The widened word and hex/base64 leak sweep, and the explicit KDF-test timeouts.
- **Recorded in KNOWN_ISSUES:** N9, F9, F10, F11, N3 and N4.
- No path grants owner authority, reads context or invokes the model before a passed step-up. Nothing ends or alerts a verified call, nothing fails open, and no phrase candidate leaks.

**Follow-ups for passphrase PR 3.** All are Low and fail closed; none grants access.
- **F1 (L1).** The rejection-completion retry has no "already completed" guard. The verifier reports that a frame-path deadline rejection racing the deadline alarm sends two refusals, two end frames and two alert calls (the D1 alert sink coalesces, but the count inflates). The reviewer's rerun of that probe did not reproduce it: the harness alarm call threw "Cannot perform I/O on behalf of a different Durable Object", and the run showed one of each. So this is unverified by the reviewer. Add an idempotency guard (a per-session "rejection delivered" marker) and a race test that drives both paths in one isolate.
- **F2 (L2).** If the final alarm clear fails, the retry repeats the whole rejection. Make completion idempotent (same fix as F1).
- **F3 (L3).** If the alarm clear throws in `handleSocketClose`, the session is never marked failed. Mark the session failed before clearing, or independently of the clear.
- **F4 (L4, reproduced by the reviewer).** An interrupted rejection, then eviction, then a hang-up or a frame before the retry: the call ends (close 1008, or the key is cleared) but Sid gets **no alert**. The probe observed 0 alerts and 0 refusals in both variants. When completing a rejection for a terminal or closed socket, still send the owner alert.
- **F5 (L5, not proven).** A small race remains in the N8 late-fragment re-arm. Serialize it with the assembly alarm, or document it.

**Next.** Sid may merge #40. Merging makes `0018` available but applies nothing, and inbound calling stays closed. The calling chat's next task, in a fresh chat, is passphrase PR 3:
- `/disable-owner-step-up --confirm` via Telegram (re-enable only by a new signed-CLI generate);
- guest-grant notices;
- the 750 ms voice retrieval timeout;
- plus F1–F5.

After PR 3 comes the flaky-test cleanup. `0016`–`0019` are proven on scratch remote D1 in an attended session before any production apply.

Sid retains merge authority. Nothing is applied or deployed.
