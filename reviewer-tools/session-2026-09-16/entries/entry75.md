## 2026-09-17 00:36 UTC — Claude Opus 5, PR #75 max review at 8e9dbc3: cleared with follow-ups

**Cleared.** Each Telegram reply makes fewer database round trips, and exactly-once delivery is unchanged: no duplicate reply, no lost reply, no new stuck state.
- **Gates at `8e9dbc3`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **186 files / 4,869 tests**.
- **My guard mutations, 4 of 8 killed:**
  - post-dependency result offset;
  - claim expiry path;
  - cached staged text;
  - failure-reason mapping.

  Survivors are the send and staging timing wiring in `index.ts`, plus the settlement and turn replay reads (F1).
- **Adversarial second reviewer:** `reviewer-tools/pr75-adversarial.md`, 12 tests in `reviewer-tools/pr75/agent/adversarial-pr75.test.ts`. They cover:
  - replay and concurrent duplicates;
  - a batch that commits but loses its response;
  - a lost model claim and a lost lease;
  - an expired lease and retry_wait timing;
  - the attempt cap and an inactive identity.

  All 12 pass at head. At base, only A11 differs, and head is better: a staged row altered after the claim no longer throws after the message is already sent.
- **Read:**
  - Batch indexing (`slice(3, 3 + n)`, trailing SELECT) matches every caller, including a system notice.
  - Every trigger on turns, deliveries and events is a BEFORE RAISE guard, so a batch can't commit with a zero-row guarded UPDATE. `RETURNING *` therefore equals a re-read.
  - A duplicate without the preflight read still fails on the unique idempotency row and replays through the existing catch.
  - D1 `batch()` returns per-statement rows in production (Cloudflare D1 Worker API docs), which main already relies on (`device-repository.ts:313`).

**F1 (Low). The new replay branches are unpinned.** Removing any of these passes all 170 related tests:
- `replayed ? readTurn : singleBatchRow` (`conversation-repository.ts:461`, `:619`);
- `returned ?? readDeliveryRow` (`:958`);
- the `observeTelegramSend` / `observeStaging` wiring in `index.ts`.

Add the reviewer's A1, A2, A3 and A5 (a D1 proxy that throws after a real commit, or races a write first), plus a composition test that the timings reach `telegram_turn_outcome`, in the next Telegram PR.

**F2 (Low). The failure reasons can mislead.** `index.ts:268` labels any `handleTurn` throw `d1`, including redaction and validation errors. `dispatcher` can only mean construction, because dispatch errors are caught inside the service. Rename `d1` to `conversation`, or narrow it to repository calls.

**Note.** Non-claiming dispatches (in progress, terminal or unavailable) now cost 2 round trips instead of 1. That's rare and acceptable.

— Claude Opus 5
