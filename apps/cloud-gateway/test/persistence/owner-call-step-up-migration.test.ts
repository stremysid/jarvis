import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyOwnerCallStepUpMigration } from "./migration.js";

describe("owner call step-up migration", () => {
  it("installs the durable step-up tables and trigger-backed owner authority boundary", async () => {
    await applyOwnerCallStepUpMigration();
    const tables = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'owner_call_step_up_bindings', 'owner_call_step_up_windows',
        'owner_call_step_up_attempts', 'owner_call_step_up_reprompts',
        'owner_call_step_up_successes', 'owner_call_step_up_rejections',
        'owner_call_step_up_repeat_checks', 'guest_call_pin_attempts',
        'owner_call_step_up_alerts'
      ) ORDER BY name`).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "guest_call_pin_attempts",
      "owner_call_step_up_alerts",
      "owner_call_step_up_attempts",
      "owner_call_step_up_bindings",
      "owner_call_step_up_rejections",
      "owner_call_step_up_repeat_checks",
      "owner_call_step_up_reprompts",
      "owner_call_step_up_successes",
      "owner_call_step_up_windows",
    ]);
    const authority = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'call_session_authorities_require_current_lineage'`)
      .first<{ sql: string }>();
    expect(authority?.sql).toContain("owner_call_step_up_successes");
    expect(authority?.sql).toContain("binding.requirement = 'waived_passed_a'");
    expect(authority?.sql).not.toMatch(/CASE[\s\S]*RAISE/iu);
  });
});
