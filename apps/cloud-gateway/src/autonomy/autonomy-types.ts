/**
 * Tiered autonomy (plan section 4) and shadow mode (plan section 8).
 *
 * The tier belongs to the capability, never to the caller. "Send money" is
 * tier 3 whoever asks and however confident the model sounds, which is what
 * makes tier 3 a backstop rather than another thing a persuasive prompt can
 * talk its way past.
 *
 * What each tier means, since `0051` (Sid, 2026-09-24: only his five
 * actions get a "just to be sure"):
 *
 *  - Tier 1: runs without asking, in either mode.
 *  - Tier 2: not one of the five. Runs without asking once shadow mode is off
 *    (`/shadow off`), and is reported instead of run while it is on. It no
 *    longer means "reversible": `delete.data` and `write.production` are
 *    tier 2 because Sid did not name them.
 *  - Tier 3: exactly Sid's five -- spending money, sending an email, making a
 *    call, submitting school work, texting or calling someone for him. Always
 *    asks: a Telegram tap, or the PIN on a call.
 *
 * Every tier writes an audit row, so an action that does not ask is still
 * receipted.
 *
 * Shadow mode is a second, independent axis. A tier-2 capability is permitted
 * in principle and shadow mode says the system is still proving itself, so it
 * reports what it would have done instead of doing it. Keeping the two apart
 * is the point: if leaving shadow mode were the same act as granting tier 2,
 * the end of a trial period would silently unlock every tier-2 action at
 * once, and there would be no way to run live with only some of them enabled.
 */

import type { Ulid } from "../../../../packages/contracts/src/index.js";

export type AutonomyTier = 1 | 2 | 3;
export type AutonomyMode = "shadow" | "live";

/**
 * `withheld_shadow` is not a denial. It says the action was permitted in
 * principle and shadow mode reported it instead of running it, which is the
 * distinction the trial period is measured on -- collapsing it into `denied`
 * would make a healthy shadow run look like a wall of refusals.
 */
export type AutonomyOutcome =
  | "permitted"
  | "withheld_shadow"
  | "requires_confirmation"
  | "denied_unknown_capability";

export function isAutonomyTier(value: unknown): value is AutonomyTier {
  return value === 1 || value === 2 || value === 3;
}

export function isAutonomyMode(value: unknown): value is AutonomyMode {
  return value === "shadow" || value === "live";
}

/**
 * The tier written to the audit row when nobody classified the capability.
 *
 * The column is NOT NULL and the request really was treated at the most
 * restrictive tier, so 3 is the honest value. `outcome` is the field that
 * says the capability was never classified: a reader filtering on
 * `tier = 3` alone will also see these, which is why the outcome and not the
 * tier is the column to group an incident review by.
 */
export const UNCLASSIFIED_AUDIT_TIER: AutonomyTier = 3;

export interface AutonomyEvaluationRequest {
  /** Registry key. Anything not in `capability_tiers` is denied, not guessed at. */
  readonly capability: string;
  readonly principalId: string;
  /**
   * The system's own one-line description of what it is about to do -- never
   * the content it would act on. This table is read during an incident and
   * must not turn into a second copy of the archive.
   */
  readonly summary: string;
  /** An already-raised decision-queue handle, recorded only on a tier-3 outcome. */
  readonly decisionId?: string | null;
}

export interface AutonomyEvaluation {
  readonly evaluationId: Ulid;
  readonly capability: string;
  /**
   * Null exactly when the capability is not registered. An unclassified
   * capability has no tier, and handing the caller a number here would let it
   * be cached and read back later as a classification somebody made.
   */
  readonly tier: AutonomyTier | null;
  readonly mode: AutonomyMode;
  readonly outcome: AutonomyOutcome;
  readonly principalId: string;
  readonly summary: string;
  readonly decisionId: string | null;
  readonly evaluatedAt: string;
}

export interface AutonomyModeRecord {
  readonly mode: AutonomyMode;
  /** When the current mode was entered, not when the row was last written. */
  readonly enteredAt: string;
  readonly updatedAt: string;
}

export interface AppendEvaluationInput {
  readonly evaluationId: Ulid;
  readonly capability: string;
  readonly tier: AutonomyTier;
  readonly mode: AutonomyMode;
  readonly outcome: AutonomyOutcome;
  readonly principalId: string;
  readonly summary: string;
  readonly decisionId: string | null;
  readonly evaluatedAt: string;
}

export interface AutonomyRepositoryContract {
  readCapabilityTier(capability: string): Promise<AutonomyTier | null>;
  readMode(): Promise<AutonomyModeRecord>;
  setMode(mode: AutonomyMode, now: string): Promise<AutonomyModeRecord>;
  appendEvaluation(input: AppendEvaluationInput): Promise<void>;
}

export interface AutonomyServiceContract {
  evaluate(request: AutonomyEvaluationRequest): Promise<AutonomyEvaluation>;
}
