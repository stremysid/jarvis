import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyLivenessSchema, clearLivenessTables } from "./liveness-schema.js";

describe("watchdog bindings", () => {
  beforeEach(async () => {
    await applyLivenessSchema();
    await clearLivenessTables();
  });

  it("runs against a real D1 binding of its own, not the gateway's", async () => {
    expect((await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>())?.value).toBe(1);
  });

  it("creates both liveness tables and nothing else the gateway owns", async () => {
    const tables = await env.DB
      // d1_migrations and _cf_METADATA are Miniflare's own bookkeeping for
      // applied migrations; which of the two appears depends on whether the
      // pool reused storage from an earlier run.
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name")
      .all<{ name: string }>();

    // Compared by equality. If the watchdog's test database ever gained the
    // gateway's tables it would mean the two apps had been wired together
    // somewhere, and a membership check would not notice.
    expect(tables.results.map((row) => row.name)).toEqual(["component_liveness", "liveness_alerts"]);
  });
});
