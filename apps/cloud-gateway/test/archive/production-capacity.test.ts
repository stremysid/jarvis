import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { createProductionCapacityGuard, readCapacityConfiguration } from "../../src/archive/production-capacity.js";
import { createDecisionPrincipal } from "../decisions/decision-fixture.js";
import { applyVoiceRuntimeMigration } from "../persistence/migration.js";

const at = "2026-09-13T16:00:00.000Z";
const account = `AC${"a".repeat(32)}`;
const budgetFields = ["CAPACITY_D1_BUDGET_BYTES", "CAPACITY_R2_BUDGET_BYTES", "CAPACITY_MODEL_ALLOCATION_USD",
  "CAPACITY_MODEL_REQUEST_COST_ASSUMPTION_USD", "CAPACITY_TWILIO_DAILY_BUDGET_USD"] as const;
let configured: Env;
let credit = 15;
let spend = "1";
let reportedAt = "2026-09-13T16:00:00+00:00";
let sent: { chat_id: string; text: string }[];
let reads: string[];
beforeEach(async () => {
  await applyVoiceRuntimeMigration();
  const owner = await createDecisionPrincipal();
  credit = 15; spend = "1"; reportedAt = "2026-09-13T16:00:00+00:00"; sent = []; reads = [];
  configured = { ...env, OWNER_PRINCIPAL_ID: owner.principalId, DEEPSEEK_API_KEY: "synthetic-model-key",
    TWILIO_ACCOUNT_SID: account, TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`, TWILIO_API_KEY_SECRET: "synthetic-voice-key",
    TELEGRAM_BOT_TOKEN: `123456:${"x".repeat(32)}`, CAPACITY_D1_BUDGET_BYTES: "1000000000", CAPACITY_R2_BUDGET_BYTES: "1000000000",
    CAPACITY_MODEL_ALLOCATION_USD: "20", CAPACITY_MODEL_REQUEST_COST_ASSUMPTION_USD: "0.45", CAPACITY_TWILIO_DAILY_BUDGET_USD: "40" } as Env;
  vi.stubGlobal("fetch", function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    expect(this).toBe(globalThis);
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      sent.push(JSON.parse(init!.body as string) as { chat_id: string; text: string });
      return Promise.resolve(Response.json({ ok: true, result: { message_id: sent.length } }));
    }
    reads.push(url);
    if (url === "https://api.deepseek.com/user/balance") return Promise.resolve(Response.json({ is_available: true,
      balance_infos: [{ currency: "USD", total_balance: String(credit), granted_balance: "0", topped_up_balance: String(credit) }] }));
    if (url.includes("api.twilio.com")) return Promise.resolve(Response.json({ next_page_uri: null, usage_records: [{
      account_sid: account, category: "totalprice", price: spend, price_unit: "usd", start_date: "2026-09-13", end_date: "2026-09-13", as_of: reportedAt,
    }] }));
    throw new Error("unexpected synthetic endpoint");
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Production capacity composition", () => {
  it("uses both real provider readers and the durable Telegram sink across reconstruction", async () => {
    credit = 6;
    await createProductionCapacityGuard(configured, () => new Date(at)).assertAcceptingNewTurn();
    await createProductionCapacityGuard(configured, () => new Date(at)).assertAcceptingNewTurn();
    expect(reads.filter((url) => url.includes("deepseek"))).toHaveLength(2);
    expect(reads.filter((url) => url.includes("twilio"))).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Plan the switch");
    expect(sent[0]!.text).toContain("70%");
    expect(await env.DB.prepare("SELECT state FROM capacity_alert_crossings WHERE owner_principal_id = ?")
      .bind(configured.OWNER_PRINCIPAL_ID).first()).toEqual({ state: "sent" });
  });

  it("refuses credit at the floor and explains the 85 percent migration crossing", async () => {
    credit = 1;
    await expect(createProductionCapacityGuard(configured, () => new Date(at)).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("85%");
    expect(sent[1]!.text).toContain("Plan the switch");
  });

  it("enforces the separately configured voice spending cap", async () => {
    spend = "38";
    await expect(createProductionCapacityGuard(configured, () => new Date(at)).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("provider:voice");
    expect(sent[1]!.text).not.toContain("switch");
  });

  it("refuses a stale provider report even when the other reader and storage are fresh", async () => {
    reportedAt = "2026-09-13T15:59:00+00:00";
    await expect(createProductionCapacityGuard(configured, () => new Date(at)).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
    expect(sent).toHaveLength(0);
  });

  it("refuses a failed real credit request instead of collecting only the other resources", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("synthetic upstream failure"); });
    await expect(createProductionCapacityGuard(configured, () => new Date(at)).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
    expect(sent).toHaveLength(0);
  });

  it.each(budgetFields)("requires the owner's %s rather than installing a default", (field) => {
    delete configured[field];
    expect(() => createProductionCapacityGuard(configured)).toThrow("capacity_configuration_invalid");
    expect(reads).toHaveLength(0);
  });

  it.each(["0", "-1", "Infinity", "1e2", " 20", "20 ", "", "NaN"])("rejects malformed monetary configuration %s", (value) => {
    for (const field of budgetFields) {
      expect(() => readCapacityConfiguration({ ...configured, [field]: value })).toThrow("capacity_configuration_invalid");
    }
  });

  it("requires integer storage bytes and a reserve greater than twice the reviewed request assumption", () => {
    expect(() => readCapacityConfiguration({ ...configured, CAPACITY_D1_BUDGET_BYTES: "1.5" })).toThrow("capacity_configuration_invalid");
    expect(() => readCapacityConfiguration({ ...configured, CAPACITY_R2_BUDGET_BYTES: "1.5" })).toThrow("capacity_configuration_invalid");
    expect(() => readCapacityConfiguration({ ...configured, CAPACITY_MODEL_REQUEST_COST_ASSUMPTION_USD: "0.50" })).toThrow("capacity_configuration_invalid");
    expect(readCapacityConfiguration({ ...configured, CAPACITY_MODEL_REQUEST_COST_ASSUMPTION_USD: "0.49999999" }).modelAllocationUsd).toBe(20);
  });

  it.each(["DEEPSEEK_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TELEGRAM_BOT_TOKEN", "OWNER_PRINCIPAL_ID"] as const)
    ("keeps missing production binding %s closed before any provider request", (field) => {
      delete configured[field];
      expect(() => createProductionCapacityGuard(configured)).toThrow();
      expect(reads).toHaveLength(0);
    });
});
