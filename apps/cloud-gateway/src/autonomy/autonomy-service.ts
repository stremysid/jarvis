/**
 * Decides what the system is allowed to do, and records that it decided.
 *
 * Two rules hold whatever else is true of the request:
 *
 * Tier 3 always asks the owner. Not "unless the system is trusted", not
 * "unless the model is confident" -- always. This is the control that still
 * works after a prompt injection has successfully steered everything upstream
 * of it, because it does not consult anything the injection can reach.
 *
 * An unregistered capability is denied rather than assigned a tier. A
 * capability nobody classified is a capability nobody has thought about, and
 * inferring a tier from its name is exactly the guess this design exists to
 * refuse.
 *
 * Every evaluation writes exactly one row, and the row is written before the
 * outcome is returned. A returned outcome therefore always has a record
 * behind it, and a failed audit write is a denial: it throws, so no caller
 * can mistake it for permission. Returning a synthetic "audit failed" outcome
 * instead would put a fifth value in a contract whose four values are the
 * only ones the audit table can hold, and would leave the caller holding an
 * outcome with no row.
 */

import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import {
  UNCLASSIFIED_AUDIT_TIER,
  type AutonomyEvaluation,
  type AutonomyEvaluationRequest,
  type AutonomyMode,
  type AutonomyOutcome,
  type AutonomyRepositoryContract,
  type AutonomyServiceContract,
  type AutonomyTier,
} from "./autonomy-types.js";

export type {
  AutonomyEvaluation,
  AutonomyEvaluationRequest,
  AutonomyMode,
  AutonomyOutcome,
  AutonomyTier,
} from "./autonomy-types.js";

/** Mirrors `CHECK (length(summary) <= 512)` in 0008_autonomy.sql. */
const MAX_SUMMARY_CHARACTERS = 512;

/**
 * The schema puts no bound on `capability`, and the audit row copies whatever
 * it was asked about. Every registered capability is under twenty characters,
 * so this only ever truncates a name that could not have matched one -- and
 * without it, an unregistered capability is an unbounded caller-supplied
 * string being written into the table that must not become a second archive.
 */
const MAX_AUDITED_CAPABILITY_CHARACTERS = 128;

const MAX_PRINCIPAL_CHARACTERS = 256;

export interface AutonomyServiceDependencies {
  readonly repository: AutonomyRepositoryContract;
  readonly now?: () => Date;
  readonly newEvaluationId?: () => Ulid;
}

/**
 * Truncate by code point, not by UTF-16 unit. Slicing units splits a surrogate
 * pair and leaves half an emoji in the audit record, and SQLite counts the
 * pair as one character anyway, so unit-slicing would also cut short of the
 * limit the schema actually enforces.
 */
function truncateCodePoints(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join("");
}

/**
 * A blank summary is refused rather than truncated. An over-long summary is a
 * caller being verbose and the action should still go through, but a blank one
 * produces an audit row indistinguishable from one nobody bothered to write,
 * in the table whose only job is to be readable months later.
 */
function boundedSummary(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("autonomy_summary_invalid");
  return truncateCodePoints(value, MAX_SUMMARY_CHARACTERS);
}

/**
 * The principal is checked rather than trimmed to fit. It comes from the
 * authenticated context and not from anything the model chose, so a malformed
 * one is a bug upstream -- and a truncated identity in an audit row points at
 * whoever happens to share the prefix.
 */
function requiredPrincipalId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > MAX_PRINCIPAL_CHARACTERS) {
    throw new TypeError("autonomy_principal_invalid");
  }
  return value;
}

function optionalDecisionId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new TypeError("autonomy_decision_id_invalid");
  return value;
}

/**
 * The whole policy, in one place with no inputs but the tier and the mode.
 * Nothing about the caller, the model's confidence, or the request text
 * reaches this function, so there is nothing here for a persuasive prompt to
 * argue with.
 */
export function decideOutcome(tier: AutonomyTier | null, mode: AutonomyMode): AutonomyOutcome {
  if (tier === null) return "denied_unknown_capability";
  if (tier === 3) return "requires_confirmation";
  if (tier === 2) return mode === "live" ? "permitted" : "withheld_shadow";
  return "permitted";
}

/** Evaluates a capability against its tier and the current mode, and audits the result. */
export class AutonomyService implements AutonomyServiceContract {
  private readonly repository: AutonomyRepositoryContract;
  private readonly clock: () => Date;
  private readonly newEvaluationId: () => Ulid;

  constructor(dependencies: AutonomyServiceDependencies) {
    this.repository = dependencies.repository;
    this.clock = dependencies.now ?? (() => new Date());
    this.newEvaluationId = dependencies.newEvaluationId ?? newUlid;
  }

  async evaluate(request: AutonomyEvaluationRequest): Promise<AutonomyEvaluation> {
    const capability = this.requiredCapability(request.capability);
    const principalId = requiredPrincipalId(request.principalId);
    const summary = boundedSummary(request.summary);
    const suppliedDecisionId = optionalDecisionId(request.decisionId);
    const evaluatedAt = this.sampleNow();

    const { mode } = await this.repository.readMode();
    // Looked up by the untruncated name so a long one cannot collide with a
    // registered capability that happens to share its first 128 characters.
    const tier = await this.repository.readCapabilityTier(capability);
    const outcome = decideOutcome(tier, mode);

    // `decision_id` means "the confirmation this evaluation is waiting on".
    // Carrying a caller's handle onto a permitted row would record a
    // confirmation that was never asked for, which is the one thing an
    // incident review would take at face value.
    const decisionId = outcome === "requires_confirmation" ? suppliedDecisionId : null;
    const evaluationId = this.newEvaluationId();

    try {
      await this.repository.appendEvaluation({
        evaluationId,
        capability: truncateCodePoints(capability, MAX_AUDITED_CAPABILITY_CHARACTERS),
        tier: tier ?? UNCLASSIFIED_AUDIT_TIER,
        mode,
        outcome,
        principalId,
        summary,
        decisionId,
        evaluatedAt,
      });
    } catch (error) {
      throw new Error("autonomy_audit_persistence_failed", { cause: error });
    }

    return Object.freeze({
      evaluationId, capability, tier, mode, outcome, principalId, summary, decisionId, evaluatedAt,
    });
  }

  private requiredCapability(value: unknown): string {
    // An empty or unrecognisable name is denied and audited, not thrown:
    // a model that asked for a capability that does not exist is precisely
    // what the audit table is for.
    if (typeof value !== "string") throw new TypeError("autonomy_capability_invalid");
    return value;
  }

  private sampleNow(): string {
    let epochMs: number;
    try { epochMs = Date.prototype.getTime.call(this.clock()); }
    catch { throw new TypeError("autonomy_clock_invalid"); }
    if (!Number.isFinite(epochMs)) throw new TypeError("autonomy_clock_invalid");
    return new Date(epochMs).toISOString();
  }
}
