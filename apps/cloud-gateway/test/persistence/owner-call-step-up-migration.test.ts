import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyOwnerCallStepUpMigration } from "./migration.js";

/**
 * The step-up tables remain after the per-call passphrase gate was removed.
 *
 * Sid, 2026-09-24: an ordinary owner call goes straight to Jarvis, so nothing
 * writes these tables any more. They stay because the brief that removed the
 * gate says not to drop them, and a later credential design may want them. What
 * is still worth pinning is the schema's own shape, and the fact that `0047`
 * has replaced `0018`'s owner-authority guard.
 *
 * The service that used to be tested here -- `OwnerCallStepUpService` and its
 * bind/begin/expire retries -- is deleted with the gate, so those tests are
 * gone rather than rewritten around a code path that no longer exists.
 */
describe("owner call step-up migration", () => {
  it("installs durable step-up tables and only remote-safe authority trigger syntax", async () => {
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
    for (const { name } of tables.results) {
      const schema = await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .bind(name).first<{ sql: string }>();
      expect(schema?.sql, name).toContain("WITHOUT ROWID");
    }
  });

  it("replaces the owner-authority guard with one no step-up row can satisfy", async () => {
    await applyOwnerCallStepUpMigration();
    const authority = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'call_session_authorities_require_current_lineage'`)
      .first<{ sql: string }>();
    // The two clauses that could only ever be satisfied by a passphrase match
    // are gone. An owner call mints its authority from relay setup, so a guard
    // that still named them would abort every owner call.
    expect(authority?.sql).not.toContain("owner_call_step_up_successes");
    expect(authority?.sql).not.toContain("owner_call_step_up_bindings");
    expect(authority?.sql).not.toContain("owner_passphrase_");
    // What remains is still the real lineage check, and the guest branch is
    // untouched: a guest authority still needs the exact bound grant.
    expect(authority?.sql).toContain("voice_owner_identity");
    expect(authority?.sql).toContain("voice_access_grants");
    expect(authority?.sql).toContain("session.guest_grant_id = NEW.grant_id");
    expect(authority?.sql).not.toMatch(/CASE[\s\S]*RAISE/iu);
  });
});
