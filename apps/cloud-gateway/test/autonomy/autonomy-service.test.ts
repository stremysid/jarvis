import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import type { AutonomyMode, AutonomyOutcome } from "../../src/autonomy/autonomy-types.js";
import { applyFoundationMigration } from "../persistence/migration.js";

// `autonomy_evaluations.principal_id` carries no foreign key, so these tests
// need no `principals` row: the audit records who asked even if that principal
// is later removed, which is the point of an append-only table.
const OWNER = "principal:owner";
const NOW = new Date("2026-09-02T10:11:12.000Z");
/** Only a fixture reset. Nothing in this file asserts the migration's default. */
const MODE_RESET_AT = "2026-09-02T00:00:00.000Z";
const UNKNOWN_CAPABILITY = "capability.nobody.classified";

interface Registered { readonly tier: number; readonly live: AutonomyOutcome; readonly shadow: AutonomyOutcome; }

/**
 * Exactly what 0008_autonomy.sql registers, restated rather than derived.
 * Computing the expected outcome from the stored tier with the service's own
 * rule would pass whatever that rule became.
 */
const REGISTERED: Readonly<Record<string, Registered>> = Object.freeze({
  "notify.owner": { tier: 1, live: "permitted", shadow: "permitted" },
  "read.archive": { tier: 1, live: "permitted", shadow: "permitted" },
  "read.repository": { tier: 1, live: "permitted", shadow: "permitted" },
  "read.deadlines": { tier: 1, live: "permitted", shadow: "permitted" },
  "write.project_file": { tier: 2, live: "permitted", shadow: "withheld_shadow" },
  "write.calendar": { tier: 2, live: "permitted", shadow: "withheld_shadow" },
  "open.application": { tier: 2, live: "permitted", shadow: "withheld_shadow" },
  "vehicle.precondition": { tier: 2, live: "permitted", shadow: "withheld_shadow" },
  "spend.money": { tier: 3, live: "requires_confirmation", shadow: "requires_confirmation" },
  "contact.third_party": { tier: 3, live: "requires_confirmation", shadow: "requires_confirmation" },
  "delete.data": { tier: 3, live: "requires_confirmation", shadow: "requires_confirmation" },
  "write.production": { tier: 3, live: "requires_confirmation", shadow: "requires_confirmation" },
  "vehicle.unlock": { tier: 3, live: "requires_confirmation", shadow: "requires_confirmation" },
});

interface EvaluationRow {
  readonly evaluation_id: string;
  readonly capability: string;
  readonly tier: number;
  readonly mode: string;
  readonly outcome: string;
  readonly principal_id: string;
  readonly summary: string;
  readonly decision_id: string | null;
  readonly evaluated_at: string;
}

function service(overrides: { now?: () => Date; newEvaluationId?: () => Ulid } = {}): AutonomyService {
  return new AutonomyService({
    repository: new AutonomyRepository(env.DB),
    now: overrides.now ?? (() => NOW),
    ...(overrides.newEvaluationId === undefined ? {} : { newEvaluationId: overrides.newEvaluationId }),
  });
}

async function setMode(mode: AutonomyMode): Promise<void> {
  await new AutonomyRepository(env.DB).setMode(mode, NOW.toISOString());
}

async function rows(): Promise<readonly EvaluationRow[]> {
  const result = await env.DB.prepare(
    `SELECT evaluation_id, capability, tier, mode, outcome, principal_id, summary, decision_id, evaluated_at
     FROM autonomy_evaluations ORDER BY evaluation_id`,
  ).all<EvaluationRow>();
  return result.results;
}

async function onlyRow(): Promise<EvaluationRow> {
  const all = await rows();
  expect(all).toHaveLength(1);
  const row = all[0];
  if (row === undefined) throw new Error("fixture_missing_evaluation_row");
  return row;
}

/** The delete guard is production behaviour, so it is put back before the next test runs. */
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

describe("AutonomyService", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearEvaluations();
    await env.DB.prepare("UPDATE autonomy_mode SET mode = 'shadow', entered_at = ?, updated_at = ? WHERE singleton = 1")
      .bind(MODE_RESET_AT, MODE_RESET_AT).run();
  });

  it("permits an observation capability while the system is still in shadow mode", async () => {
    const evaluation = await service().evaluate({ capability: "notify.owner", principalId: OWNER, summary: "tell the owner the build failed" });

    expect(evaluation.outcome).toBe("permitted");
    expect(evaluation.tier).toBe(1);
    expect(evaluation.mode).toBe("shadow");
  });

  it("permits an observation capability once the system is live as well", async () => {
    await setMode("live");

    const evaluation = await service().evaluate({ capability: "read.archive", principalId: OWNER, summary: "search the archive for last week's invoices" });

    expect(evaluation.outcome).toBe("permitted");
    expect(evaluation.tier).toBe(1);
    expect(evaluation.mode).toBe("live");
  });

  it("permits a reversible action once the system is live", async () => {
    await setMode("live");

    const evaluation = await service().evaluate({ capability: "write.project_file", principalId: OWNER, summary: "update the changelog in the tracked project folder" });

    expect(evaluation.outcome).toBe("permitted");
    expect(evaluation.tier).toBe(2);
  });

  it("withholds a reversible action in shadow mode rather than denying it", async () => {
    const evaluation = await service().evaluate({ capability: "write.calendar", principalId: OWNER, summary: "move tomorrow's standup an hour later" });

    expect(evaluation.outcome).toBe("withheld_shadow");
    expect(evaluation.tier).toBe(2);
    expect(evaluation.mode).toBe("shadow");
  });

  it("requires the owner's confirmation for a tier 3 capability in shadow mode", async () => {
    const evaluation = await service().evaluate({ capability: "spend.money", principalId: OWNER, summary: "renew the domain registration" });

    expect(evaluation.outcome).toBe("requires_confirmation");
    expect(evaluation.tier).toBe(3);
  });

  it("still requires the owner's confirmation for a tier 3 capability when the system is fully live", async () => {
    await setMode("live");

    const evaluation = await service().evaluate({ capability: "contact.third_party", principalId: OWNER, summary: "reply to the supplier about the delayed order" });

    expect(evaluation.outcome).toBe("requires_confirmation");
    expect(evaluation.mode).toBe("live");
  });

  it("denies a capability nobody has classified", async () => {
    const evaluation = await service().evaluate({ capability: UNKNOWN_CAPABILITY, principalId: OWNER, summary: "do the thing the model asked for" });

    expect(evaluation.outcome).toBe("denied_unknown_capability");
    // Null, not a number: an unclassified capability has no tier, and a
    // number here would be cached and read back as a classification.
    expect(evaluation.tier).toBeNull();
  });

  it("denies a capability nobody has classified even when the system is live", async () => {
    await setMode("live");

    const evaluation = await service().evaluate({ capability: UNKNOWN_CAPABILITY, principalId: OWNER, summary: "do the thing the model asked for" });

    expect(evaluation.outcome).toBe("denied_unknown_capability");
  });

  it("reaches the outcome each capability's registered tier calls for, in both modes", async () => {
    const registry = await env.DB.prepare("SELECT capability, tier FROM capability_tiers ORDER BY capability")
      .all<{ capability: string; tier: number }>();
    // Compared by whole-table equality, not by looking each expectation up:
    // membership checks pass over the capability nobody listed, which is the
    // only kind that goes missing. This also fails loudly if a later
    // migration classifies something without anyone revisiting this table.
    const stored: Record<string, number> = {};
    for (const row of registry.results) stored[row.capability] = row.tier;
    const expectedTiers: Record<string, number> = {};
    for (const [capability, entry] of Object.entries(REGISTERED)) expectedTiers[capability] = entry.tier;
    expect(stored).toEqual(expectedTiers);

    const observed: Record<string, Registered> = {};
    for (const mode of ["live", "shadow"] as const) {
      await setMode(mode);
      for (const row of registry.results) {
        const evaluation = await service().evaluate({ capability: row.capability, principalId: OWNER, summary: `exercise ${row.capability}` });
        observed[row.capability] = { ...(observed[row.capability] ?? { tier: row.tier, live: "permitted", shadow: "permitted" }), [mode]: evaluation.outcome };
      }
    }

    expect(observed).toEqual(REGISTERED);
  });

  it("writes one audit row carrying the outcome it returned", async () => {
    const evaluation = await service().evaluate({ capability: "open.application", principalId: OWNER, summary: "open the editor on the project" });

    expect(await onlyRow()).toEqual({
      evaluation_id: evaluation.evaluationId,
      capability: "open.application",
      tier: 2,
      mode: "shadow",
      outcome: "withheld_shadow",
      principal_id: OWNER,
      summary: "open the editor on the project",
      decision_id: null,
      evaluated_at: NOW.toISOString(),
    });
  });

  it("writes one audit row for a denied capability, at the tier it was actually treated at", async () => {
    await service().evaluate({ capability: UNKNOWN_CAPABILITY, principalId: OWNER, summary: "unclassified request" });

    const row = await onlyRow();
    expect(row.outcome).toBe("denied_unknown_capability");
    // The column is NOT NULL and the request was held to the strictest tier,
    // so 3 is what happened. `outcome` is what says it was never classified.
    expect(row.tier).toBe(3);
    expect(row.capability).toBe(UNKNOWN_CAPABILITY);
  });

  it("writes one audit row per evaluation and no more", async () => {
    const target = service();
    await target.evaluate({ capability: "notify.owner", principalId: OWNER, summary: "first" });
    await target.evaluate({ capability: "spend.money", principalId: OWNER, summary: "second" });
    await target.evaluate({ capability: UNKNOWN_CAPABILITY, principalId: OWNER, summary: "third" });

    expect((await rows()).map((row) => row.outcome).sort()).toEqual(
      ["denied_unknown_capability", "permitted", "requires_confirmation"],
    );
  });

  it("refuses an update to a written audit row and leaves the row as it stands", async () => {
    const evaluation = await service().evaluate({ capability: "spend.money", principalId: OWNER, summary: "renew the domain registration" });
    const before = await onlyRow();

    await expect(
      env.DB.prepare("UPDATE autonomy_evaluations SET outcome = 'permitted' WHERE evaluation_id = ?")
        .bind(evaluation.evaluationId).run(),
    ).rejects.toThrow(/autonomy_evaluation_update_forbidden/u);

    expect(await onlyRow()).toEqual(before);
  });

  it("refuses a delete of a written audit row and leaves the row as it stands", async () => {
    const evaluation = await service().evaluate({ capability: "delete.data", principalId: OWNER, summary: "clear the scratch folder" });
    const before = await onlyRow();

    await expect(
      env.DB.prepare("DELETE FROM autonomy_evaluations WHERE evaluation_id = ?").bind(evaluation.evaluationId).run(),
    ).rejects.toThrow(/autonomy_evaluation_delete_forbidden/u);

    expect(await onlyRow()).toEqual(before);
  });

  it("truncates an over-long summary rather than refusing the action it describes", async () => {
    const evaluation = await service().evaluate({ capability: "notify.owner", principalId: OWNER, summary: "n".repeat(600) });

    expect(evaluation.outcome).toBe("permitted");
    expect(evaluation.summary).toBe("n".repeat(512));
    const row = await env.DB.prepare("SELECT length(summary) AS length FROM autonomy_evaluations").first<{ length: number }>();
    expect(row?.length).toBe(512);
  });

  it("truncates a summary of astral characters without splitting one in half", async () => {
    const evaluation = await service().evaluate({ capability: "notify.owner", principalId: OWNER, summary: "\u{1F6F0}".repeat(600) });

    expect(Array.from(evaluation.summary)).toHaveLength(512);
    expect(evaluation.summary.isWellFormed()).toBe(true);
    const row = await env.DB.prepare("SELECT summary FROM autonomy_evaluations").first<{ summary: string }>();
    expect(row?.summary).toBe(evaluation.summary);
  });

  it("refuses an evaluation whose summary is blank, and writes nothing", async () => {
    await expect(service().evaluate({ capability: "notify.owner", principalId: OWNER, summary: "   " }))
      .rejects.toThrow("autonomy_summary_invalid");

    expect(await rows()).toHaveLength(0);
  });

  it("bounds an unregistered capability name before it reaches the audit table", async () => {
    const long = "x".repeat(300);

    const evaluation = await service().evaluate({ capability: long, principalId: OWNER, summary: "an unregistered name of unbounded length" });

    expect(evaluation.outcome).toBe("denied_unknown_capability");
    // What was asked is reported back in full, but the append-only table that
    // must not become a second archive stores a bounded name.
    expect(evaluation.capability).toBe(long);
    expect((await onlyRow()).capability).toBe("x".repeat(128));
  });

  it("refuses the action when its audit row cannot be written, rather than permitting it unrecorded", async () => {
    const fixedId = "01k4a0000000000000000000ab" as Ulid;
    const target = service({ newEvaluationId: () => fixedId });
    await target.evaluate({ capability: "notify.owner", principalId: OWNER, summary: "the first evaluation, recorded" });

    // The second append collides on the primary key. The capability is tier 1
    // and would otherwise have been permitted, so this is the case that
    // matters: a permitted action must not escape without a record.
    await expect(target.evaluate({ capability: "notify.owner", principalId: OWNER, summary: "the second evaluation, unrecordable" }))
      .rejects.toThrow("autonomy_audit_persistence_failed");

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.summary).toBe("the first evaluation, recorded");
  });

  it("records a decision handle only on the outcome that is waiting for one", async () => {
    const target = service();
    const waiting = await target.evaluate({ capability: "write.production", principalId: OWNER, summary: "deploy the gateway", decisionId: "decision:1" });
    const permitted = await target.evaluate({ capability: "notify.owner", principalId: OWNER, summary: "tell the owner it is queued", decisionId: "decision:2" });

    expect(waiting.decisionId).toBe("decision:1");
    // Dropped, not carried: a decision id on a permitted row would record a
    // confirmation that was never asked for.
    expect(permitted.decisionId).toBeNull();
    const stored = await env.DB.prepare("SELECT outcome, decision_id FROM autonomy_evaluations ORDER BY evaluated_at, evaluation_id").all<{ outcome: string; decision_id: string | null }>();
    expect(stored.results).toEqual([
      { outcome: "requires_confirmation", decision_id: "decision:1" },
      { outcome: "permitted", decision_id: null },
    ]);
  });

  it("stamps the evaluation with the injected clock rather than the wall clock", async () => {
    const injected = new Date("2027-01-02T03:04:05.678Z");

    const evaluation = await service({ now: () => injected }).evaluate({ capability: "read.deadlines", principalId: OWNER, summary: "read the deadline store" });

    expect(evaluation.evaluatedAt).toBe("2027-01-02T03:04:05.678Z");
    expect((await onlyRow()).evaluated_at).toBe("2027-01-02T03:04:05.678Z");
  });

  it("refuses to evaluate when the injected clock is not a usable date, and writes nothing", async () => {
    await expect(service({ now: () => new Date(Number.NaN) })
      .evaluate({ capability: "notify.owner", principalId: OWNER, summary: "tell the owner" }))
      .rejects.toThrow("autonomy_clock_invalid");

    expect(await rows()).toHaveLength(0);
  });

  it("refuses an evaluation with no principal to attribute it to, and writes nothing", async () => {
    await expect(service().evaluate({ capability: "notify.owner", principalId: "", summary: "tell the owner" }))
      .rejects.toThrow("autonomy_principal_invalid");

    expect(await rows()).toHaveLength(0);
  });
});
