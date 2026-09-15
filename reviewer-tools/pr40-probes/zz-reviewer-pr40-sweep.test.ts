import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { createFakeCallingSystem, type FakeCallingSystem } from "../../../../tests/acceptance/fake/voice-call-system.js";
import { seedFakeGuest, FAKE_OWNER_PASSPHRASE } from "../../../../tests/acceptance/fake/voice-access-system.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { applyOwnerCallStepUpMigration } from "./migration.js";

// Reviewer probe for PR #40, finding "Sweep" (adv40.md B1 "REPLACE sweep").
//
// Enumerates every table 0018 creates FROM sqlite_master (so it survives table
// renames and reveals WITHOUT ROWID), then for a leaf/natural row of each tries:
//   - INSERT OR REPLACE with the existing natural key,
//   - INSERT OR REPLACE with the explicit existing rowid (skipped for WITHOUT ROWID),
//   - UPDATE OR REPLACE of each primary-key column,
// recording whether each form REPLACED/CHANGED a guarded row ("replaced"/"updated")
// or was blocked by a guard/RESTRICT ("blocked:<msg>"). The matrix is printed as JSON.
//
// ASSERTS THE BUG on 6b63d08: the INSERT OR REPLACE holes exist on
// owner_call_step_up_bindings, _windows and _repeat_checks (delete guards never fire
// under recursive_triggers=0), while the ordinal/phase-guarded tables (_attempts,
// _reprompts, guest_call_pin_attempts) reject the re-insert.
//
// Expected on a fix: the three hole rows flip to "blocked:<existing-key guard>", so
// the "replaced" assertions fail meaningfully (a guard RAISE), not "no such table".

const NOW = "2026-08-30T12:00:00.000Z";
const SAFE = /^[a-z0-9_]+$/u;

interface Matrix {
  [table: string]: {
    withoutRowid: boolean;
    rows: number;
    insertOrReplaceNaturalKey: string;
    insertOrReplaceExplicitRowid: string;
    updateOrReplacePkColumns: string;
    // repeat_checks only: identical re-insert is blocked by the outcome!=NULL shape
    // gate, so the real hole is a FRESH unresolved row replacing the resolved one.
    insertOrReplaceFreshUnresolved?: string;
  };
}

function calls(): CallRepository {
  return new CallRepository(env.DB, new EventRepository(env.DB));
}

async function stepUpTables(): Promise<{ name: string; withoutRowid: boolean }[]> {
  const rows = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_schema WHERE type = 'table'
       AND (sql LIKE '%owner_call_step_up%' OR name = 'guest_call_pin_attempts')
     ORDER BY name`,
  ).all<{ name: string; sql: string }>();
  return rows.results
    .filter((row) => SAFE.test(row.name))
    .map((row) => ({ name: row.name, withoutRowid: /WITHOUT\s+ROWID/iu.test(row.sql) }));
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /(owner_call_step_up_[a-z_]+|guest_call_pin_attempt[a-z_]*|[A-Z_]+ constraint failed[^:]*|FOREIGN KEY[^:]*)/u.exec(message);
  return `blocked:${match?.[1] ?? message.slice(0, 60)}`;
}

/** Probe the three OR REPLACE forms against a single guarded row of `table`. */
async function probeForms(table: string, withoutRowid: boolean): Promise<Matrix[string]> {
  if (!SAFE.test(table)) throw new Error("unsafe_table");
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string; pk: number }>();
  const columns = info.results.map((column) => column.name);
  const pkColumns = info.results.filter((column) => column.pk > 0).map((column) => column.name);
  // WITHOUT ROWID tables have no implicit rowid column; select natural columns only.
  const selection = withoutRowid ? "*" : "rowid AS __rowid, *";
  const row = await env.DB.prepare(`SELECT ${selection} FROM ${table} LIMIT 1`).first<Record<string, unknown>>();
  const count = (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
  const result: Matrix[string] = {
    withoutRowid, rows: count,
    insertOrReplaceNaturalKey: "not_probed_no_row",
    insertOrReplaceExplicitRowid: "not_probed_no_row",
    updateOrReplacePkColumns: "not_probed_no_row",
  };
  if (row === null) return result;

  const values = columns.map((name) => row[name]);
  const placeholders = columns.map(() => "?").join(", ");

  // Form A: INSERT OR REPLACE with the existing natural key (identical values).
  try {
    await env.DB.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`)
      .bind(...values).run();
    const after = (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;
    result.insertOrReplaceNaturalKey = after === count ? "replaced" : `replaced_count_${after}`;
  } catch (error) {
    result.insertOrReplaceNaturalKey = shortError(error);
  }

  // Form B: INSERT OR REPLACE with the explicit existing rowid.
  if (withoutRowid) {
    result.insertOrReplaceExplicitRowid = "skipped_without_rowid";
  } else {
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO ${table} (rowid, ${columns.join(", ")}) VALUES (?, ${placeholders})`,
      ).bind(row.__rowid, ...values).run();
      result.insertOrReplaceExplicitRowid = "replaced";
    } catch (error) {
      result.insertOrReplaceExplicitRowid = shortError(error);
    }
  }

  // Form C: UPDATE OR REPLACE each primary-key column (to its own value).
  const where = pkColumns.length > 0
    ? pkColumns.map((name) => `${name} = ?`).join(" AND ")
    : "rowid = ?";
  const whereBindings = pkColumns.length > 0 ? pkColumns.map((name) => row[name]) : [row.__rowid];
  const outcomes: string[] = [];
  for (const column of pkColumns.length > 0 ? pkColumns : columns.slice(0, 1)) {
    try {
      await env.DB.prepare(`UPDATE OR REPLACE ${table} SET ${column} = ? WHERE ${where}`)
        .bind(row[column], ...whereBindings).run();
      outcomes.push(`${column}:updated`);
    } catch (error) {
      outcomes.push(`${column}:${shortError(error)}`);
    }
  }
  result.updateOrReplacePkColumns = outcomes.join(" | ");
  return result;
}

async function withSystem<T>(
  fn: (system: FakeCallingSystem) => Promise<T>,
  options: Parameters<typeof createFakeCallingSystem>[0] = {},
): Promise<T> {
  const system = await createFakeCallingSystem(options);
  try { return await fn(system); } finally { await system.cleanup(); }
}

describe("reviewer probe PR #40 — 0018 INSERT OR REPLACE sweep", () => {
  it("maps which 0018 tables let INSERT OR REPLACE delete a guarded row", async () => {
    await applyOwnerCallStepUpMigration();
    const tables = await stepUpTables();
    expect(tables.map((table) => table.name)).toEqual([
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

    const matrix: Matrix = {};
    const info = new Map(tables.map((table) => [table.name, table.withoutRowid]));
    const wr = (name: string): boolean => info.get(name) ?? false;

    // owner_call_step_up_bindings: leaf required binding (no window child).
    await withSystem(async () => {
      const repo = calls();
      const session = await repo.getOrCreateInboundSession({
        callSid: `CA${"9".repeat(32)}`, callerE164: "+14165550123",
        ownerIdentityId: "identity:voice", currentChallengeHmacKeyVersion: "hmac-v1", now: new Date(NOW),
      });
      await env.DB.prepare(`INSERT INTO owner_call_step_up_bindings (
        session_id, call_sid, owner_principal_id, owner_identity_id, direction,
        lifecycle_generation, requirement, attestation_class, policy, created_at
      ) VALUES (?, ?, ?, ?, 'inbound', 1, 'required', 'absent', 'passphrase_always', ?)`)
        .bind(session.sessionId, session.callSid, session.binding.principalId,
          session.binding.identityId, session.createdAt).run();
      matrix.owner_call_step_up_bindings = await probeForms("owner_call_step_up_bindings", wr("owner_call_step_up_bindings"));
    });

    // owner_call_step_up_windows: pre_auth window, no attempts (leaf).
    await withSystem(async (system) => {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      expect(await call.phase()).toBe("pre_auth");
      matrix.owner_call_step_up_windows = await probeForms("owner_call_step_up_windows", wr("owner_call_step_up_windows"));
    });

    // owner_call_step_up_attempts: one resolved mismatch attempt.
    await withSystem(async (system) => {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt("ablaze abrasion active");
      matrix.owner_call_step_up_attempts = await probeForms("owner_call_step_up_attempts", wr("owner_call_step_up_attempts"));
    });

    // owner_call_step_up_reprompts: one durable non-candidate re-prompt.
    await withSystem(async (system) => {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt("please ablaze abrasion abrasive"); // non-candidate → re-prompt
      matrix.owner_call_step_up_reprompts = await probeForms("owner_call_step_up_reprompts", wr("owner_call_step_up_reprompts"));
    });

    // owner_call_step_up_successes + owner_call_step_up_repeat_checks: verified + resolved repeat check.
    await withSystem(async (system) => {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      expect(await call.phase()).toBe("active");
      matrix.owner_call_step_up_successes = await probeForms("owner_call_step_up_successes", wr("owner_call_step_up_successes"));
      const reservedAt = "2026-08-30T12:00:03.000Z";
      await env.DB.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
        session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
      ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(call.sessionId as Ulid, reservedAt).run();
      await env.DB.prepare(`UPDATE owner_call_step_up_repeat_checks
        SET outcome = 'matched', resolved_at = ? WHERE session_id = ?`).bind(reservedAt, call.sessionId as Ulid).run();
      matrix.owner_call_step_up_repeat_checks = await probeForms("owner_call_step_up_repeat_checks", wr("owner_call_step_up_repeat_checks"));
      // The real hole: a fresh UNRESOLVED row (outcome NULL) replaces the resolved one,
      // re-opening the one-time repeat check.
      try {
        await env.DB.prepare(`INSERT OR REPLACE INTO owner_call_step_up_repeat_checks (
          session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
        ) VALUES (?, 1, 1, '2026-08-30T12:00:09.000Z', NULL, NULL)`).bind(call.sessionId as Ulid).run();
        const reopened = await env.DB.prepare("SELECT outcome FROM owner_call_step_up_repeat_checks WHERE session_id = ?")
          .bind(call.sessionId as Ulid).first<{ outcome: string | null }>();
        matrix.owner_call_step_up_repeat_checks.insertOrReplaceFreshUnresolved =
          reopened?.outcome === null ? "replaced" : `unexpected_${String(reopened?.outcome)}`;
      } catch (error) {
        matrix.owner_call_step_up_repeat_checks.insertOrReplaceFreshUnresolved = shortError(error);
      }
    });

    // owner_call_step_up_rejections + owner_call_step_up_alerts.
    await withSystem(async (system) => {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      for (const candidate of ["ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity"]) {
        await call.prompt(candidate);
      }
      expect(await call.phase()).toBe("rejected");
      matrix.owner_call_step_up_rejections = await probeForms("owner_call_step_up_rejections", wr("owner_call_step_up_rejections"));
      // Seed one alert row directly (the fake alert sink is a no-op, so the table is empty otherwise).
      await env.DB.prepare(`INSERT INTO owner_call_step_up_alerts (
        owner_principal_id, alert_class, direction, attestation_class,
        first_observed_at, last_observed_at, observation_count, last_sent_at, claim_id, claim_expires_at
      ) VALUES ('principal:owner', 'rejected', 'inbound', 'absent', ?, ?, 1, NULL, NULL, NULL)`)
        .bind(NOW, NOW).run();
      matrix.owner_call_step_up_alerts = await probeForms("owner_call_step_up_alerts", wr("owner_call_step_up_alerts"));
    });

    // guest_call_pin_attempts: one durable guest PIN attempt.
    await withSystem(async (system) => {
      const guest = await seedFakeGuest("a");
      expect((await system.inbound(guest.caller)).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.pin(new TextEncoder().encode("2468"));
      matrix.guest_call_pin_attempts = await probeForms("guest_call_pin_attempts", wr("guest_call_pin_attempts"));
    });

    // eslint-disable-next-line no-console
    console.log("PR40_SWEEP_MATRIX " + JSON.stringify(matrix, null, 2));

    // Known INSERT OR REPLACE holes (a guarded leaf row is silently replaced).
    expect(matrix.owner_call_step_up_bindings.insertOrReplaceNaturalKey).toBe("replaced");
    expect(matrix.owner_call_step_up_bindings.insertOrReplaceExplicitRowid).toBe("replaced");
    expect(matrix.owner_call_step_up_windows.insertOrReplaceNaturalKey).toBe("replaced");
    // repeat_checks: identical re-insert is blocked by the outcome!=NULL shape gate,
    // but a fresh unresolved row still replaces the resolved one (the real hole).
    expect(matrix.owner_call_step_up_repeat_checks.insertOrReplaceNaturalKey).toMatch(/^blocked:/u);
    expect(matrix.owner_call_step_up_repeat_checks.insertOrReplaceFreshUnresolved).toBe("replaced");

    // Ordinal/phase-guarded tables reject the identical re-insert.
    expect(matrix.owner_call_step_up_attempts.insertOrReplaceNaturalKey).toMatch(/^blocked:/u);
    expect(matrix.owner_call_step_up_reprompts.insertOrReplaceNaturalKey).toMatch(/^blocked:/u);
    expect(matrix.guest_call_pin_attempts.insertOrReplaceNaturalKey).toMatch(/^blocked:/u);

    // UPDATE OR REPLACE is blocked everywhere on the immutable hole tables.
    expect(matrix.owner_call_step_up_bindings.updateOrReplacePkColumns).toMatch(/blocked:/u);
    expect(matrix.owner_call_step_up_windows.updateOrReplacePkColumns).toMatch(/blocked:/u);
  }, 120_000);
});
