import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import {
  MEMORY_EXTRACTION_MONTH_ENTRIES_SQL,
  MemoryExtractionBudget,
  snapshotMemoryExtractionFailure,
  torontoBillingMonth,
} from "../../src/memory/memory-extraction-budget.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

async function principal(label: string): Promise<string> {
  const principalId = `principal:memory-budget:${label}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'memory budget test', ?, ?)`).bind(principalId, now, now).run();
  return principalId;
}

async function runningRun(
  principalId: string,
  priceId: Ulid,
  providerModelId: string,
  now: Date,
): Promise<Ulid> {
  const runId = newUlid(now);
  await env.DB.prepare(`INSERT INTO memory_runs (
    run_id, principal_id, run_key, job, provider_model_id, price_id, outcome, started_at
  ) VALUES (?, ?, ?, 'distillation', ?, ?, 'running', ?)`)
    .bind(runId, principalId, `budget-test:${runId}`, providerModelId, priceId, now.toISOString()).run();
  return runId;
}

describe("MemoryExtractionBudget", () => {
  beforeAll(applyMemoryDistillationMigration);

  it("reserves conservatively and refuses before a hard cap would be exceeded", async () => {
    const principalId = await principal("cap");
    const now = new Date();
    const budget = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      monthlyCapUsd: "0.000156",
      now: () => new Date(now),
    });
    const prepared = await budget.prepare(principalId);
    const runId = await runningRun(principalId, prepared.priceId, prepared.providerModelId, now);
    const first = await budget.reserve({
      principalId, runId, priceId: prepared.priceId, requestBytes: 1, maxOutputTokens: 1,
    });

    expect(first.reservedCostMicros).toBe(156);
    await expect(budget.reserve({
      principalId, runId, priceId: prepared.priceId, requestBytes: 1, maxOutputTokens: 1,
    })).rejects.toSatisfy((error: unknown) =>
      snapshotMemoryExtractionFailure(error) === "memory_extraction_monthly_cap_exceeded");
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_cost_ledger
      WHERE principal_id = ? AND entry_type = 'reservation'`).bind(principalId).first("count")).toBe(1);
  });

  it("binds every reservation to the prepared price id before writing the ledger", async () => {
    const principalId = await principal("price-id");
    const now = new Date();
    const budget = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      now: () => new Date(now),
    });
    const prepared = await budget.prepare(principalId);
    const runId = await runningRun(principalId, prepared.priceId, prepared.providerModelId, now);

    await expect(budget.reserve({
      principalId,
      runId,
      priceId: newUlid(now),
      requestBytes: 1,
      maxOutputTokens: 1,
    })).rejects.toSatisfy((error: unknown) =>
      snapshotMemoryExtractionFailure(error) === "memory_extraction_price_unavailable");
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_cost_ledger WHERE run_id = ?")
      .bind(runId).first("count")).toBe(0);
  });

  it("refuses an invalid cap and an unreviewed model with fixed codes", async () => {
    const principalId = await principal("configuration");
    const now = new Date();
    const invalidCap = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      monthlyCapUsd: "five",
      now: () => new Date(now),
    });
    const prepared = await invalidCap.prepare(principalId);
    const runId = await runningRun(principalId, prepared.priceId, prepared.providerModelId, now);
    await expect(invalidCap.reserve({
      principalId, runId, priceId: prepared.priceId, requestBytes: 1, maxOutputTokens: 1,
    })).rejects.toSatisfy((error: unknown) =>
      snapshotMemoryExtractionFailure(error) === "memory_extraction_cap_invalid");

    const unknown = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-unreviewed",
      now: () => new Date(now),
    });
    await expect(unknown.prepare(principalId)).rejects.toSatisfy((error: unknown) =>
      snapshotMemoryExtractionFailure(error) === "memory_extraction_model_unknown");
  });

  it("uses Toronto calendar months across UTC and daylight-saving boundaries", () => {
    expect(torontoBillingMonth(new Date("2026-04-01T03:59:59.999Z"))).toMatchObject({
      key: "2026-03",
      startAt: "2026-03-01T05:00:00.000Z",
      endAt: "2026-04-01T04:00:00.000Z",
    });
    expect(torontoBillingMonth(new Date("2026-04-01T04:00:00.000Z"))).toMatchObject({
      key: "2026-04",
      startAt: "2026-04-01T04:00:00.000Z",
      endAt: "2026-05-01T04:00:00.000Z",
    });
  });

  it("bounds the cap lookup at both ends of the current Toronto month and uses its ledger index", async () => {
    const principalId = await principal("query-plan");
    const month = torontoBillingMonth(new Date());
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${MEMORY_EXTRACTION_MONTH_ENTRIES_SQL}`)
      .bind(principalId, month.startAt, month.endAt)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join("\n");

    expect(detail).toContain("memory_cost_ledger_month_lookup");
    expect(detail).toMatch(/occurred_at>[?].*occurred_at<[?]/u);
  });

  it("delivers the 80 percent owner notice only once in a month", async () => {
    const principalId = await principal("notice");
    const now = new Date();
    const weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
    const hour = now.getUTCHours();
    const peak = weekday && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);
    const send = vi.fn(async (_text: string) => undefined);
    const budget = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      monthlyCapUsd: peak ? "0.004" : "0.002",
      now: () => new Date(now),
      notice: { send },
    });
    const prepared = await budget.prepare(principalId);
    for (let index = 0; index < 22; index += 1) {
      const runId = await runningRun(principalId, prepared.priceId, prepared.providerModelId, now);
      const reservation = await budget.reserve({
        principalId, runId, priceId: prepared.priceId, requestBytes: 1, maxOutputTokens: 1,
      });
      await budget.settle(reservation, { inputTokens: 513, outputTokens: 1, cacheReadTokens: 0 });
    }

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toContain("80%");
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM capacity_alert_crossings
      WHERE owner_principal_id = ? AND state = 'sent'`).bind(principalId).first("count")).toBe(1);
  });

  it("settles at the actual DeepSeek time-of-day rate while keeping the peak reservation", async () => {
    const principalId = await principal("time-of-day");
    const now = new Date();
    const budget = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      now: () => new Date(),
    });
    const prepared = await budget.prepare(principalId);
    const runId = await runningRun(principalId, prepared.priceId, prepared.providerModelId, now);
    const reservation = await budget.reserve({
      principalId, runId, priceId: prepared.priceId, requestBytes: 1, maxOutputTokens: 1,
    });
    const settled = await budget.settle(reservation, {
      inputTokens: 513, outputTokens: 1, cacheReadTokens: 0,
    });
    const startedAt = new Date(reservation.reservedAt);
    const weekday = startedAt.getUTCDay() >= 1 && startedAt.getUTCDay() <= 5;
    const hour = startedAt.getUTCHours();
    const peak = weekday && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);

    expect(reservation.reservedCostMicros).toBe(156);
    expect(settled.settledCostMicros).toBe(peak ? 156 : 78);
  });

  it("delivers one provider-credit owner notice per Toronto day", async () => {
    const principalId = await principal("provider-credit");
    const now = new Date();
    const send = vi.fn(async (_text: string) => undefined);
    const budget = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      now: () => new Date(now),
      notice: { send },
    });

    await budget.notifyCreditBlocked(principalId);
    await budget.notifyCreditBlocked(principalId);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toContain("provider credit");
  });
});
