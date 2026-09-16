## 2026-09-15 HH:MM UTC — Claude Opus 5, PR #46 round-2 max re-review at 91fe8be: changes requested (small)

This re-review covers fix round `e6c42df`–`91fe8be`: migration `0021_voice_owner_delivery.sql`, durable disabled-head rejections, the rejection-delivery marker, the guest-grant notice outbox with its drain, resume gating, the Telegram near-miss routing and the private-chat check. It includes the merge of main `e0b5072`. **The branch no longer merges cleanly with main `1130694`.** `test/persistence/migration.ts` and `test/persistence/remote-d1-migration-syntax.test.ts` conflict with #48's `0022` entries, and so does the mailbox.

**Local checks on 91fe8be** (Windows 11, `jarvis-pr40`, run one at a time): GATES_RESULT

**Contract gap ports.** The nine gaps were re-ported to this head as `port46b-*.diff`: five applied cleanly and four needed a clean 3-way apply. GAPS_RESULT

**#40 round-4 probes.** PROBES_RESULT

**0021 trigger coverage** (`mut46b-triggers.json`, whole-block removal of all 10 triggers against the step-up, notice, access, call-session and syntax tests). TRIGGERS_RESULT

**Round-1 findings, verified by reading:**
- **B1 is fixed.** A cached or fresh core resumes a `rejected` session only when `canResumeRejectedOwnerStepUp` holds and D1 shows a required, non-activation owner binding. Guest and enrollment sessions keep the 1008 mismatch close.
- **S1 is fixed for `required` bindings.** `begin`, prompt, interrupt, reprompt and alarm all reconcile a disabled head into `owner_call_step_up_disabled_rejections`. The session terminalizes, the refusal and `end` go out, and one alert is sent.
- **S2 is fixed.** Each create, replace, rotate and revoke writes its `guest_grant_notices` row in the same D1 batch, with a checked change count. `#mutateAndNotice` consults the outbox even when the repository throws, and the `*/5` drain retries pending and expired claims.
- **S3 is fixed.** Addressed and case-variant forms get an empty argument and the fixed usage reply, with no model call.
- **N1, N2 and N3 are fixed.** A persisted delivery marker exists, the alert names the recovery command, and the command checks `chatId === telegramUserId`.

**Adversarial pass** (one Opus agent, round 2). The reviewer verified M1 and M2 against the code. Confirmed sound:
- same-batch notices;
- claim integrity and REPLACE safety for every `0021` table;
- crash recovery through the drain;
- masked notice content;
- mutual exclusion between disabled rejection, ordinary rejection and success;
- the resume gating;
- the private-chat check;
- remote-D1 trigger syntax.

**S1 (regression from the N1 fix). A failed rejection alert is now lost for good.**
- **Where:** in `#deliverOwnerStepUpRejection` (`call-session-do.ts:1214-1227`), any `alert()` failure is swallowed, and `recordRejectionDelivered` still runs. After that, every retry path returns early at `:1203` and the alarm is cleared. No job drains `owner_call_step_up_alerts`.
- **What goes wrong:** before this round, a missing marker meant eviction re-ran delivery and retried the alert. Now one spoofed or rejected call during a Telegram 5xx or timeout means Sid is never told.
- **Fix:** write the delivery marker only after the alert resolves, or when there is no binding or sink. Better, give step-up alerts the same drained outbox as guest notices.
- **Test:** the alert sink throws once. Expect the rejection to finish, then after eviction plus a close or alarm, exactly one Telegram alert.

MERGE_AND_TRIGGER_FINDINGS

**F1 (required before the waiver policy can ever be enabled).** With `waive_on_passed_a` set, an inbound passed-A owner call on a **disabled** head still ends with a 1011 close. `assertWaiverAvailable` throws `owner_step_up_unavailable` (`owner-call-step-up.ts:285`, called at `call-session-do.ts:914`), and `#recordDisabledRejection` and the `0021` guard accept only `requirement = 'required'`. There's no refusal, no `end`, no rejection row and no alert. The waiver ships off, so the default configuration can't reach this.

**Low (fix if small, otherwise record in KNOWN_ISSUES):**
- **L1.** Guest notices are at-least-once: `TelegramRestProvider` drops the idempotency key, and `drain` reuses one clock for every row.
- **L2.** A notice that can never be delivered blocks newer ones (`ORDER BY created_at LIMIT 10`), and there's no attempt count or dead-letter surfacing.
- **L3.** With the marker present, a resumed rejected socket isn't closed.
- **L4.** `/disable-owner-step-up@OtherBot --confirm`, `/disable-owner-step-up--confirm` and Unicode-hyphen forms still reach the model, and `private_chat_required` is posted into the group.
- **Rollout.** This code needs `0021` applied before deploy, because guest-grant batches and `begin()` query the new tables.

**Next.** In this same chat:
1. Merge `origin/main` (`1130694`). Keep both `0021` and `0022` in the test helper and the syntax inventory.
2. Fix S1 and the items above.
3. Rerun the serialized voice gate, the `port46b` gaps and the `0021` trigger removal.
4. Request re-review.

Merging turns nothing on. Sid retains deploy, inbound-calling and live-call authority.

---
