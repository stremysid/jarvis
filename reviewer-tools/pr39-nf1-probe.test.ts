import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyCloudMemoryMigration } from "./migration.js";

// Reviewer probe for PR #39 NF1. Asserts CURRENT behaviour: a pass of the NF1
// test proves an explicit implicit-rowid REPLACE deletes a guarded row.
const P = "principal:nf1probe";
const A = "01k4z8m0q2a3b4c5d6e7f8g9h0";
const insert = (id: string, effectiveAt: string) => env.DB.prepare(
  `INSERT INTO memory_model_prices (price_id, principal_id, provider, model_id, effective_at,
     input_micros_per_million, output_micros_per_million, cache_read_micros_per_million,
     currency, source_receipt, created_at)
   VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', ?, 1, 2, 0, 'USD', 'probe', '2026-09-14T10:00:00.000Z')`,
).bind(id, P, effectiveAt);

describe("reviewer probe PR #39 NF1", () => {
  beforeAll(async () => {
    await applyCloudMemoryMigration();
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'service', 'active', 'probe', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')",
    ).bind(P).run();
    await insert(A, "2026-09-01T00:00:00.000Z").run();
  });

  it("plain DELETE and duplicate-key INSERT of a price row are refused", async () => {
    await expect(env.DB.prepare("DELETE FROM memory_model_prices WHERE price_id = ?").bind(A).run()).rejects.toThrow();
    await expect(insert(A, "2026-09-02T00:00:00.000Z").run()).rejects.toThrow(/memory_model_price_duplicate/u);
  });

  it("NF1: INSERT OR REPLACE with the existing rowid deletes the price row despite the guards", async () => {
    const row = await env.DB.prepare("SELECT rowid AS r FROM memory_model_prices WHERE price_id = ?").bind(A).first<{ r: number }>();
    expect(row?.r).toBeTypeOf("number");
    await env.DB.prepare(
      `INSERT OR REPLACE INTO memory_model_prices (rowid, price_id, principal_id, provider, model_id, effective_at,
         input_micros_per_million, output_micros_per_million, cache_read_micros_per_million,
         currency, source_receipt, created_at)
       VALUES (?, '01k4z8m0q2a3b4c5d6e7f8g9h2', ?, 'deepseek', 'deepseek:deepseek-v4-pro', '2026-09-03T00:00:00.000Z', 9, 9, 0, 'USD', 'probe', '2026-09-14T10:00:00.000Z')`,
    ).bind(row?.r, P).run();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM memory_model_prices WHERE price_id = ?").bind(A).first()).toEqual({ n: 0 });
  });
});
