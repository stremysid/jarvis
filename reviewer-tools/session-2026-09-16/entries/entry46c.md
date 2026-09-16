## 2026-09-15 18:11 UTC — Claude Opus 5, PR #46 round-2 max re-review at 16bf448: changes requested (small)

This re-review covers fix round `e6c42df`–`91fe8be` and the builder's merge of main `1130694` at `16bf448`. The fix round adds:
- migration `0021_voice_owner_delivery.sql`;
- durable disabled-head rejections and the rejection-delivery marker;
- the guest-grant notice outbox with its drain;
- resume gating;
- Telegram near-miss routing and the private-chat check.

GitHub reports MERGEABLE. `91fe8be`→`16bf448` adds only main's files plus `0022` lines in `test/persistence/migration.ts`, `remote-d1-migration-syntax.test.ts` and `index.ts`; #46's step-up source and its step-up tests are byte-identical to `91fe8be`. Main has since moved to `60ae90d` (#47, memory files only).

**Local checks** (Windows 11, `jarvis-pr40`, run one at a time):
- **On 16bf448:** lint, typecheck and `typecheck:voice-access` pass. `pnpm test` passes 3,148/3,148 with 0 timeouts. The serialized `pnpm test:voice-access` gate passes 6/6 runner checks and 866/866 tests with 0 timeouts.
- **On 91fe8be:** `pnpm test` 3,113/3,113 and the voice gate at 6/6 runner checks plus 866/866.

**Contract gap ports** (`port46b-*.diff`, run at `91fe8be` against the five step-up test files). The base passes 237/237. All nine gaps are killed:

| Gap | Failed tests |
|---|---|
| gap0 | 25 (2 of them timeouts) |
| gap1 | 14 |
| gap2b | 1 |
| gap3b | 1 |
| gap3c | 3 |
| gap3d | 2 |
| gap3e | 2 |
| gap6 | 2 |
| gap6b | 1 |

Those files and the source they exercise are unchanged at `16bf448`.

**#40 round-4 probes** (`91fe8be`):
- **Q1c, Q2c, Q3c and Q6c now fail,** so the double-completion and alarm-clear bugs stay fixed.
- **Q4 and Q5** report a single refusal, `end` and alert after eviction.
- **Q1** also reports a single refusal and alert. Its alarm calls threw a cross-object I/O error inside the test harness, though, so Q1 itself does not exercise the race; Q1c and Q2c do.

**0021 trigger coverage** (`mut46c-triggers.json`, whole-block removal of all 10 triggers at `16bf448`, against the step-up, notice, access, call-session, schema and syntax tests). `BASE` passes, and all ten removals fail at least one test, with 0 timeouts.
- **Caught by behaviour (4):** `owner_call_step_up_disabled_rejections_terminalize` fails four tests, including the fixed disabled refusal and the open-window rejection. The three insert guards fail the `INSERT OR IGNORE` / `INSERT OR REPLACE` collision sweep.
- **Caught only by the syntax inventory (6):** `pins every 0021 trigger as one complete named definition`, a text check that proves nothing about behaviour.
  - `owner_call_step_up_disabled_rejections_immutable`
  - `owner_call_step_up_disabled_rejections_delete_forbidden`
  - `owner_call_step_up_rejection_deliveries_immutable`
  - `owner_call_step_up_rejection_deliveries_delete_forbidden`
  - `guest_grant_notices_transition_guard`
  - `guest_grant_notices_delete_forbidden`

**Round-1 findings, verified by reading:**
- **B1 is fixed.** A cached or fresh core resumes a `rejected` session only when `canResumeRejectedOwnerStepUp` holds and D1 shows a required, non-activation owner binding. Guest and enrollment sessions keep the 1008 mismatch close.
- **S1 is fixed for `required` bindings.** `begin`, prompt, interrupt, reprompt and alarm all reconcile a disabled head into `owner_call_step_up_disabled_rejections`. The session terminalizes, the refusal and `end` go out, and one alert is attempted.
- **S2 is fixed.** Each create, replace, rotate and revoke writes its `guest_grant_notices` row in the same D1 batch, with a checked change count. `#mutateAndNotice` consults the outbox even when the repository throws, and the `*/5` drain retries pending and expired claims.
- **S3 is fixed.** Addressed and case-variant forms get an empty argument and the fixed usage reply, with no model call.
- **N1, N2 and N3 are fixed.** A persisted delivery marker exists, the alert names the recovery command, and the command checks `chatId === telegramUserId`.

**Adversarial pass** (one Opus agent, round 2; report `reviewer-tools/pr46b-adversarial.md`). The reviewer verified M1 and M2 against the code, and re-read M1 at `16bf448`. Confirmed sound:
- same-batch notices;
- claim integrity and REPLACE safety for every `0021` table;
- crash recovery through the drain;
- masked notice content;
- mutual exclusion between disabled rejection, ordinary rejection and success;
- the resume gating;
- the private-chat check;
- remote-D1 trigger syntax.

**S1 (regression from the N1 fix). A failed rejection alert is now lost for good.**
- **Where:** in `#deliverOwnerStepUpRejection` (`call-session-do.ts:1214-1227`), an `alert()` failure is swallowed, and `recordRejectionDelivered` still runs. After that, every retry path returns early at `rejectionDelivered` and the alarm is cleared. No job drains `owner_call_step_up_alerts`; `owner-call-step-up.ts` only inserts and claims them.
- **What goes wrong:** before this round, a missing marker meant eviction re-ran delivery and retried the alert. Now one spoofed or rejected call during a Telegram 5xx or timeout means Sid is never told.
- **Fix:** write the delivery marker only after the alert resolves, or when there is no binding or sink. Better, give step-up alerts the same drained outbox as guest notices.
- **Test:** the alert sink throws once. Expect the rejection to finish, then after eviction plus a close or alarm, exactly one Telegram alert.

**S2. Six `0021` guards have no behavioural test.**
- **What goes wrong:** remove any of the six triggers listed above and every behavioural test still passes; only the inventory check fails. A later edit could let a disabled-rejection row or a delivery marker be rewritten or deleted, or a delivered guest notice return to pending and be sent again, with no test failing.
- **Fix:** with `0021` applied, attempt an `UPDATE` and a `DELETE` on each rejection and delivery row, expecting `*_immutable` / `*_delete_forbidden`. Also attempt each invalid notice transition (a delivered row changed or moved back to pending, a key column changed) and a delete, expecting `guest_grant_notice_transition_invalid` / `guest_grant_notice_delete_forbidden`.
- **Test:** each whole-trigger removal must then be killed by a named behavioural test.

**F1 (required before the waiver policy can ever be enabled).**
- **What happens:** with `waive_on_passed_a` set, an inbound passed-A owner call on a **disabled** head still ends with a 1011 close.
- **Why:** `assertWaiverAvailable` throws `owner_step_up_unavailable` (`owner-call-step-up.ts:285`, called at `call-session-do.ts:914`), while `#recordDisabledRejection` and the `0021` guard accept only `requirement = 'required'`.
- **Result:** no refusal, no `end`, no rejection row and no alert.
- **Reach:** the waiver ships off, so the default configuration can't reach this.

**Low (fix if small, otherwise record in KNOWN_ISSUES):**
- **L1.** Guest notices are at-least-once: `TelegramRestProvider` drops the idempotency key, and `drain` reuses one clock for every row.
- **L2.** A notice that can never be delivered blocks newer ones (`ORDER BY created_at LIMIT 10`), and there's no attempt count or dead-letter surfacing.
- **L3.** With the marker present, a resumed rejected socket isn't closed.
- **L4.** `/disable-owner-step-up@OtherBot --confirm`, `/disable-owner-step-up--confirm` and Unicode-hyphen forms still reach the model, and `private_chat_required` is posted into the group.

**Rollout.** This code needs `0021` applied before deploy, because guest-grant batches and `begin()` query the new tables.

**Next.** In this same chat:
1. Pull first. Fix S1 and S2, plus F1 and L1–L4 (or KNOWN_ISSUES for any L that isn't small).
2. Rerun the serialized voice gate, the `port46b` gaps and the `0021` trigger removal.
3. Request re-review.

Merging turns nothing on. Sid retains deploy, inbound-calling and live-call authority.

---
