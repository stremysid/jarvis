import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyCloudMemoryMigration } from "./migration.js";

// Reviewer probe for PR #39 S4 (L4, still partial): the cost-ledger insert
// guard bounds occurred_at only below (`NEW.occurred_at >= run.started_at`,
// 0016:2810) with no upper bound. A reservation stamped NEXT MONTH is accepted
// and lands in next month's bucket (memory_cost_ledger_month_lookup, 0016:1044),
// escaping this month's normal_monthly cap.
//
// PASS on 8b62e80 (the next-month reservation is accepted). On a fix that adds
// `NEW.occurred_at > now + 5 minutes` to the ledger guard, the insert is refused
// with `memory_cost_entry_lineage_invalid`, flipping the test.
//
// It also confirms the sibling run path is already closed: a run whose
// started_at is next month is rejected by memory_run_initial_state_invalid
// (0016:2650), which is why the open hole is the ledger, not the run.

const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
let serial = 1;
function nextUlid(): string {
  let value = serial;
  serial += 1;
  let suffix = "";
  for (let index = 0; index < 18; index += 1) {
    const digit = crockford[value % crockford.length];
    if (digit === undefined) throw new Error("ulid_digit_missing");
    suffix = `${digit}${suffix}`;
    value = Math.floor(value / crockford.length);
  }
  return `01k5s4t4${suffix}`;
}
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

describe.sequential("reviewer probe PR #39 S4 ledger month", () => {
  let principalId = "";
  let runId = "";
  let priceId = "";
  const nextMonth = iso(45 * 24 * 60 * 60 * 1000);
  let reservationThrew = "";
  let futureRunThrew = "";

  beforeAll(async () => {
    await applyCloudMemoryMigration();
    principalId = `principal:s4:${nextUlid()}`;
    const ts = iso(0);
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 's4', ?, ?)`).bind(principalId, ts, ts).run();

    priceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million, cache_read_micros_per_million,
      currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', '2026-09-01T00:00:00.000Z',
      1, 1, 0, 'USD', 's4 price', ?)`).bind(priceId, principalId, ts).run();

    runId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_runs (
      run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
      provider_model_id, price_id, outcome, started_at
    ) VALUES (?, ?, ?, 'distillation', NULL, NULL, 'deepseek:deepseek-v4-pro', ?, 'running', ?)`)
      .bind(runId, principalId, `s4:${runId}`, priceId, iso(0)).run();

    // The S4 hole: a reservation stamped next month is accepted.
    try {
      await env.DB.prepare(`INSERT INTO memory_cost_ledger (
        cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at
      ) VALUES (?, ?, ?, 'reservation', NULL, 'deepseek', 'deepseek:deepseek-v4-pro',
        'normal_monthly', NULL, 100, ?, ?)`)
        .bind(nextUlid(), principalId, runId, priceId, nextMonth).run();
    } catch (error) {
      reservationThrew = String(error);
    }

    // Control: a run whose started_at is next month is already refused.
    try {
      await env.DB.prepare(`INSERT INTO memory_runs (
        run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
        provider_model_id, price_id, outcome, started_at
      ) VALUES (?, ?, ?, 'distillation', NULL, NULL, 'deepseek:deepseek-v4-pro', ?, 'running', ?)`)
        .bind(nextUlid(), principalId, `s4-future:${nextUlid()}`, priceId, nextMonth).run();
    } catch (error) {
      futureRunThrew = String(error);
    }
  });

  it("accepts a next-month reservation that escapes this month's cap", async () => {
    const inNextMonth = await env.DB.prepare(
      "SELECT count(*) AS n FROM memory_cost_ledger WHERE principal_id = ? AND run_id = ? AND occurred_at = ?",
    ).bind(principalId, runId, nextMonth).first<{ n: number }>();
    console.log("S4_RESERVATION_THREW", reservationThrew === "" ? "(no error)" : reservationThrew);
    console.log("S4_NEXT_MONTH_ROWS", inNextMonth?.n, "S4_OCCURRED_AT", nextMonth);
    console.log("S4_FUTURE_RUN_THREW", futureRunThrew === "" ? "(no error)" : futureRunThrew);
    expect(reservationThrew).toBe("");
    expect(inNextMonth).toEqual({ n: 1 });
    // The run path is already bounded; document it stays closed on both heads.
    expect(futureRunThrew).toMatch(/memory_run_initial_state_invalid/u);
  });
});
