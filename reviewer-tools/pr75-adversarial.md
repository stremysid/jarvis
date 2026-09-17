# PR #75 adversarial review: Telegram reply durability (head 8e9dbc3, base 20b7b64)

**Verdict: no blocking defects. Replies still go out exactly once and nothing is lost silently. High 0, Medium 0, Low 2.**

I tested every changed call against the scenarios in the brief, on both head and base: the same update replayed, a concurrent duplicate, a batch that commits but loses its response, a lost model claim, a lost delivery lease, an expired lease, `retry_wait` before and after `available_at`, three attempts, and an inactive identity or principal. None of them gives Sid a reply twice, leaves him with no reply while the state says delivered, or leaves a new stuck state compared with base.

Evidence:
- `apps/cloud-gateway/test/conversation/adversarial-pr75.test.ts`: 12 tests.
  - At head: 12 of 12 pass.
  - At base (main's `src` with the head tests): 11 of 12 pass. A11 differs, and head is the better behaviour (see below).
- The 10 relevant existing files pass at head: 114 of 114 tests.

---

## Low

### L1. Nothing in the existing suite protects the three new replay branches
**Where:**
- `apps/cloud-gateway/src/conversation/conversation-repository.ts:461` (`getOrCreateTurn`: `replayed ? readTurn : singleBatchRow`)
- `:619` (`stageAssistantDelivery`: the same pattern)
- `:958` (`recordDeliverySuccess`: `returned ?? readDeliveryRow`)

**Proven:** I deleted all three at once:
- `false && replayed` at `:461` and at `:619`
- `returned ?? null` at `:958`

Then I ran 12 existing files: conversation/*, conversation-repository, event-repository, conversation-transaction-faults, worker-telegram-reply, telegram-turn-observability, telegram-memory, school-catchup-telegram.integration and university-tracker-telegram.integration.
- **Existing files:** 170 of 170 tests pass.
- **Adversarial tests:** only these four fail:
  - A1 and A2 fail with `conversation_turn_missing_after_commit`.
  - A3 fails with `assistant_stage_missing_after_commit`.
  - A5 gets `outcome: 'unknown'` where it expected `'delivered'`.

The PR's code is correct today. The gap is that nothing would catch a later edit that removes these branches.

**Effect for Sid:** If a later edit dropped one of these branches, a D1 response lost after commit, or a duplicate race, would do one of two things:
- **Admission or staging:** Sid never gets a reply, and the turn stays stuck.
- **Settlement:** the message is sent, but the log says `delivery_unknown`.

**Fix:** Add A1, A2, A3 and A5 (or equivalent tests) to the PR. They use a D1 proxy that either throws after a real batch commits, or runs a competing write just before the batch.

### L2. The new reply failure reasons can point at the wrong cause
**Where:**
- `apps/cloud-gateway/src/index.ts:268` wraps all of `service.handleTurn` as `"d1"`.
- `:246` and `:260` label failures as `"dispatcher"`.
- `conversation-service.ts:1033` catches every dispatch throw and returns `delivery_unknown`.

**Proven:** by reading.
- `"d1"` is logged for any `handleTurn` throw, including ones that have nothing to do with D1: `ingest_redaction_failed` (`conversation-service.ts:787`), `conversation_stage_invalid` (`:1019`) and input `TypeError`s.
- `"dispatcher"` can only come from constructing `DefaultOutboxDispatcher`. A dispatch that fails never reaches the outer catch.

**Effect for Sid:** Delivery behaviour doesn't change. A `telegram_reply_failed reason=d1` log line could send a debugging session after D1 when the real cause was redaction or validation.

**Fix:** Pick one:
- Narrow `"d1"` to the repository calls.
- Rename it to something like `"conversation"`.
- Document that `"dispatcher"` means construction only.

---

## Checked and sound
- **Batch indexing.**
  - `slice(3, 3 + n)` matches the fixed event, idempotency and outbox prefix in all three callers.
  - Settlement of a system notice has one dependency and reads `postResults[0]`. A10 passes.
  - In both `appendAtomic` layouts (dependencies first, or After), the trailing SELECT is last, so `results.at(-1)` is right.
- **`RETURNING *` gives the same rows as a re-read.**
  - Every trigger on `conversation_turns`, `conversation_deliveries` and `events` is BEFORE plus RAISE. The only AFTER trigger on `events` (0015) touches `outbound_call_attempts`.
  - A batch cannot commit with a zero-row guarded UPDATE:
    - `conversation_deliveries_stage_guard` requires the turn to be `model_claimed`, and the claim token cannot change once claimed.
    - `events_conversation_transition_guard` requires the delivery to be `claimed`, and a claimed lease hash cannot change.
  - A4 (claim expires between the check and the batch) commits nothing.
  - A6 (lease expires to unknown before the settlement batch) records no delivered history, and the delivery and turn both end unknown.
  - So the new `singleBatchRow` throws only guard states that cannot happen.
- **Skipping the idempotency preflight read.** A duplicate fails on the unique idempotency row, and the existing catch re-reads it and replays. A1, A2, A3 and A5 pass at head and at base. The `replayed` flag matches base in every case, including `true` after a lost response.
- **New `claimDelivery` order.** Each outcome matches base:

  | Case | Outcome |
  |---|---|
  | Expired lease | terminal unknown, turn `delivery_unknown`, no send (A7) |
  | `retry_wait` before `available_at` | in progress, attempt count unchanged (A8) |
  | `retry_wait` at `available_at` | claims attempt 2 with the staged text (A8) |
  | Inactive identity or principal | stays pending with attempt count 0 and no send (A9) |

  The existing six-way concurrent claim test and the three-attempt cap test also pass.
  Side note on latency only: the paths that don't claim (in progress, terminal, unavailable) now run a write batch and return the staged envelope. A duplicate or late dispatch costs 2 D1 round trips instead of 1.
- **Cached staged text.**
  - `staged_event_id` is immutable (`conversation_deliveries_immutable_guard`).
  - The text is fully validated at claim, it is the exact string sent to Telegram, and `sanitizeRedaction` still runs at settlement.
  - A11: if the staged row is altered after the claim, head records the text Sid actually received. Base throws `contentHash does not match payload` after the message is already sent, so head is strictly better.
- **`claimModelTurn` without its preflight read.** Conflict, in-progress and expiry outcomes are unchanged, and the existing tests pass.
- **The round-trip counting test.**
  - It counts every `prepare`/`bind` → `run`/`first`/`all`/`raw` call and every `batch` on the same D1 the production classes use.
  - Run against main's `src`, it fails with `expected 11 to be less than or equal to 8`.
  - It covers only the successful path. Replay and duplicate paths are uncounted.
- **Dispatcher.** A synchronous throw from the provider now becomes a rejection inside the same `try`, so the circuit breaker and `settleFailure` path are unchanged.
- **Not introduced by #75, unchanged by it.** `claimDelivery` has one caller: the dispatcher, used by the service inside the same request. Nothing re-dispatches a `retry_wait` delivery or a lease orphaned by a lost claim response. A replay of the same update returns `telegram_staged` without sending.

## Unverified
- **Production D1 batch results.** I proved that `batch()` returns `RETURNING` rows and SELECT rows only on local workerd. No code on main reads rows from inside a batch today.
- **Real lost responses.** I simulated them with a proxy that throws after the real batch commits, not with real D1 network faults.
- **Latency.** I did not measure the PR's claimed production latency gains.
- **Full gates.** I did not re-run lint, typecheck or the full suite myself. The reviewer's earlier gates at 8e9dbc3 passed: 186 files, 4869 tests.

## Where things are
- **Test file:** `adversarial-pr75.test.ts`, in both worktrees below, untracked in each.
- **Scratchpad worktree:** `<scratchpad>/pr75/agent/tree` (8e9dbc3). workerd would not start from that long path (`Timeout starting cloudflare-pool runner`, the same failure pr82 hit).
- **Short-path worktree:** all runs were done in `C:\Users\Sid\jarvis-pr75-adv` (8e9dbc3). It has been restored to head and left in place.
- **Logs:** in `<scratchpad>/pr75/agent/`:
  - `adv-head.log`
  - `head-suite.log`
  - `mut-suite.log`
  - `base-run.log`
