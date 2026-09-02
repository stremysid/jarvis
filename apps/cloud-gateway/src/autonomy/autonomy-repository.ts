/**
 * D1 access for the autonomy tables.
 *
 * Nothing here catches a write failure. That is deliberate and it is the
 * single rule the rest of the subsystem is built on: an evaluation that was
 * not recorded did not happen, so a failed append has to reach the caller as
 * a thrown error rather than a quietly dropped audit row on top of a
 * permitted action. Swallowing it would leave the one case an incident review
 * most needs -- the system acted and there is no record of why -- as the one
 * case that produces no evidence.
 */

import {
  isAutonomyMode,
  isAutonomyTier,
  type AppendEvaluationInput,
  type AutonomyMode,
  type AutonomyModeRecord,
  type AutonomyRepositoryContract,
  type AutonomyTier,
} from "./autonomy-types.js";

interface CapabilityTierRow { readonly tier: number; }
interface AutonomyModeRow { readonly mode: string; readonly entered_at: string; readonly updated_at: string; }

/** Owns reads and writes of capability tiers, the mode singleton, and the evaluation audit. */
export class AutonomyRepository implements AutonomyRepositoryContract {
  constructor(private readonly database: D1Database) {}

  /**
   * Null means the capability is not in the registry. That is a different
   * answer from any tier, and callers must not fold it into one: a capability
   * nobody classified is one nobody has thought about, and picking a tier for
   * it here would put the guess in the layer with the least context.
   */
  async readCapabilityTier(capability: string): Promise<AutonomyTier | null> {
    if (typeof capability !== "string") throw new TypeError("autonomy_capability_invalid");
    const row = await this.database.prepare("SELECT tier FROM capability_tiers WHERE capability = ?")
      .bind(capability).first<CapabilityTierRow>();
    if (row === null) return null;
    // The CHECK constrains what can be written, not what an older row or a
    // hand-edited database can hold, and a tier read as `undefined` would
    // compare unequal to 3 and fall through to permitted.
    if (!isAutonomyTier(row.tier)) throw new TypeError("autonomy_tier_invalid");
    return row.tier;
  }

  async readMode(): Promise<AutonomyModeRecord> {
    const row = await this.database.prepare("SELECT mode, entered_at, updated_at FROM autonomy_mode WHERE singleton = 1")
      .first<AutonomyModeRow>();
    // A delete trigger protects this row, so a missing one means the database
    // is not in a state this code understands. Defaulting to shadow would be
    // safe for the action and wrong for the operator, who would never find
    // out the singleton had gone.
    if (row === null) throw new Error("autonomy_mode_missing");
    if (!isAutonomyMode(row.mode)) throw new TypeError("autonomy_mode_invalid");
    return Object.freeze({ mode: row.mode, enteredAt: row.entered_at, updatedAt: row.updated_at });
  }

  /**
   * The value is checked here rather than left to the CHECK constraint. A
   * constraint violation arrives as an opaque D1 error at the far end of a
   * write, and the caller cannot tell it apart from a disk problem -- so the
   * one failure that means "you asked for a mode that does not exist" would
   * be indistinguishable from the one that means "try again".
   *
   * `entered_at` only moves when the mode actually changes. It answers "how
   * long has this been live", and rewriting it on a no-op re-set would reset
   * that clock every time a caller reasserted the mode it was already in.
   */
  async setMode(mode: AutonomyMode, now: string): Promise<AutonomyModeRecord> {
    if (!isAutonomyMode(mode)) throw new TypeError("autonomy_mode_invalid");
    if (typeof now !== "string" || now.length === 0) throw new TypeError("autonomy_timestamp_invalid");
    const result = await this.database.prepare(
      `UPDATE autonomy_mode
       SET mode = ?,
           entered_at = CASE WHEN mode = ? THEN entered_at ELSE ? END,
           updated_at = ?
       WHERE singleton = 1`,
    ).bind(mode, mode, now, now).run();
    if (result.meta.changes === 0) throw new Error("autonomy_mode_missing");
    return this.readMode();
  }

  async appendEvaluation(input: AppendEvaluationInput): Promise<void> {
    await this.database.prepare(
      `INSERT INTO autonomy_evaluations (
         evaluation_id, capability, tier, mode, outcome, principal_id, summary, decision_id, evaluated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.evaluationId, input.capability, input.tier, input.mode, input.outcome,
      input.principalId, input.summary, input.decisionId, input.evaluatedAt,
    ).run();
  }
}
