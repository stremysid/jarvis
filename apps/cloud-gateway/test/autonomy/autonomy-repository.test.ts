import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { applyFoundationMigration } from "../persistence/migration.js";

/**
 * Deliberately not the timestamp 0008_autonomy.sql seeds. Resetting the mode
 * row to the migration's own values would make the shadow-first assertion
 * below true of this file's fixture rather than of the migration.
 */
const RESET_AT = "2026-09-05T00:00:00.000Z";
const WENT_LIVE = "2026-09-10T09:00:00.000Z";
const LATER = "2026-09-11T09:00:00.000Z";

interface ModeRow { readonly mode: string; readonly entered_at: string; readonly updated_at: string; }
interface TierRow { readonly capability: string; readonly tier: number; readonly description: string; readonly updated_at: string; }

function repository(): AutonomyRepository { return new AutonomyRepository(env.DB); }

function readModeRow(): Promise<ModeRow | null> {
  return env.DB.prepare("SELECT mode, entered_at, updated_at FROM autonomy_mode WHERE singleton = 1").first<ModeRow>();
}

async function readTierRows(): Promise<readonly TierRow[]> {
  const result = await env.DB.prepare("SELECT capability, tier, description, updated_at FROM capability_tiers ORDER BY capability").all<TierRow>();
  return result.results;
}

async function clearEvaluations(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS autonomy_evaluations_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM autonomy_evaluations").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER autonomy_evaluations_reject_delete
      BEFORE DELETE ON autonomy_evaluations
      BEGIN
        SELECT RAISE(ABORT, 'autonomy_evaluation_delete_forbidden');
      END`).run();
  }
}

describe("AutonomyRepository", () => {
  let seeded: ModeRow | null = null;

  beforeAll(async () => {
    await applyFoundationMigration();
    // Read before any test in this file writes the row, so what lands here is
    // the migration's own seed and not a fixture's restatement of it.
    seeded = await readModeRow();
  });

  beforeEach(async () => {
    await applyFoundationMigration();
    await clearEvaluations();
    await env.DB.prepare("UPDATE autonomy_mode SET mode = 'shadow', entered_at = ?, updated_at = ? WHERE singleton = 1")
      .bind(RESET_AT, RESET_AT).run();
  });

  it("reads the tier the migration registered for a capability", async () => {
    expect(await repository().readCapabilityTier("read.archive")).toBe(1);
    expect(await repository().readCapabilityTier("write.calendar")).toBe(2);
    expect(await repository().readCapabilityTier("spend.money")).toBe(3);
  });

  it("returns null rather than a tier for a capability that is not in the registry", async () => {
    expect(await repository().readCapabilityTier("capability.nobody.classified")).toBeNull();
  });

  it("ships seeded into shadow mode, so the trial period is a gate to open rather than one to remember to close", () => {
    // No test writes this timestamp, so it can only have come from the
    // migration. Seeding live instead would make the observe-and-report
    // period something an operator has to remember to switch on.
    expect(seeded).toEqual({ mode: "shadow", entered_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z" });
  });

  it("reads back the mode, when it was entered, and when it was last written", async () => {
    expect(await repository().readMode()).toEqual({ mode: "shadow", enteredAt: RESET_AT, updatedAt: RESET_AT });
  });

  it("refuses a mode value that is neither shadow nor live and leaves the stored mode untouched", async () => {
    for (const invalid of ["Live", "live ", "off", "", "1"]) {
      await expect(repository().setMode(invalid as never, WENT_LIVE)).rejects.toThrow("autonomy_mode_invalid");
    }
    await expect(repository().setMode(2 as never, WENT_LIVE)).rejects.toThrow("autonomy_mode_invalid");
    await expect(repository().setMode(null as never, WENT_LIVE)).rejects.toThrow("autonomy_mode_invalid");

    expect(await readModeRow()).toEqual({ mode: "shadow", entered_at: RESET_AT, updated_at: RESET_AT });
  });

  it("refuses a mode change with no timestamp to date it by", async () => {
    await expect(repository().setMode("live", "")).rejects.toThrow("autonomy_timestamp_invalid");
    expect((await readModeRow())?.mode).toBe("shadow");
  });

  it("stamps entered_at when the mode actually changes", async () => {
    expect(await repository().setMode("live", WENT_LIVE)).toEqual({ mode: "live", enteredAt: WENT_LIVE, updatedAt: WENT_LIVE });
  });

  it("leaves entered_at alone when the mode is set to the value it already holds", async () => {
    await repository().setMode("live", WENT_LIVE);

    // entered_at answers "how long has this been live". Rewriting it on a
    // no-op re-set would restart that clock every time a caller reasserted
    // the mode, and the trial period would never appear to have elapsed.
    expect(await repository().setMode("live", LATER)).toEqual({ mode: "live", enteredAt: WENT_LIVE, updatedAt: LATER });
  });

  it("does not grant any capability a tier when it leaves shadow mode", async () => {
    const before = await readTierRows();
    expect(before).toHaveLength(13);

    await repository().setMode("live", WENT_LIVE);

    // Shadow mode and the tier are separate axes. If leaving shadow mode also
    // touched the registry, the end of a trial period would silently unlock
    // every reversible capability at once.
    expect(await readTierRows()).toEqual(before);
  });

  it("throws rather than assuming a mode when the singleton row is gone", async () => {
    const original = await readModeRow();
    if (original === null) throw new Error("fixture_missing_mode_row");
    await env.DB.prepare("DROP TRIGGER IF EXISTS autonomy_mode_reject_delete").run();
    try {
      await env.DB.prepare("DELETE FROM autonomy_mode WHERE singleton = 1").run();

      await expect(repository().readMode()).rejects.toThrow("autonomy_mode_missing");
      await expect(repository().setMode("live", WENT_LIVE)).rejects.toThrow("autonomy_mode_missing");
    } finally {
      await env.DB.prepare("INSERT OR REPLACE INTO autonomy_mode (singleton, mode, entered_at, updated_at) VALUES (1, ?, ?, ?)")
        .bind(original.mode, original.entered_at, original.updated_at).run();
      await env.DB.prepare(`CREATE TRIGGER autonomy_mode_reject_delete
        BEFORE DELETE ON autonomy_mode
        BEGIN
          SELECT RAISE(ABORT, 'autonomy_mode_delete_forbidden');
        END`).run();
    }
  });

  it("lets a failed evaluation append reach the caller instead of swallowing it", async () => {
    const input = {
      evaluationId: "01k4a0000000000000000000cd" as Ulid,
      capability: "notify.owner",
      tier: 1,
      mode: "shadow",
      outcome: "permitted",
      principalId: "principal:owner",
      summary: "tell the owner",
      decisionId: null,
      evaluatedAt: RESET_AT,
    } as const;
    await repository().appendEvaluation(input);

    // A repository that caught this would hand its caller a success and no
    // row, which is the one combination that leaves an action with no record.
    await expect(repository().appendEvaluation(input)).rejects.toThrow();

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM autonomy_evaluations").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("refuses to write an evaluation whose summary exceeds what the audit column will hold", async () => {
    // The service truncates before it gets here. This pins the last line of
    // defence for any other caller: the row is refused, never silently cut.
    await expect(repository().appendEvaluation({
      evaluationId: "01k4a0000000000000000000ef" as Ulid,
      capability: "notify.owner",
      tier: 1,
      mode: "shadow",
      outcome: "permitted",
      principalId: "principal:owner",
      summary: "n".repeat(513),
      decisionId: null,
      evaluatedAt: RESET_AT,
    })).rejects.toThrow();

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM autonomy_evaluations").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});
