/**
 * The tier gate every tool call passes through before it acts.
 *
 * This exists because `AutonomyService` was correct, reviewed, tested and
 * unreferenced: the backstop the README advertises did not run. The service
 * decides what is allowed. This module is the thing that asks it, and the thing
 * that turns its answer into either permission or a receipt the owner can read.
 *
 * Three properties are deliberate.
 *
 * It runs BEFORE the tool acts, never after. A gate that records what happened
 * is an audit log, not a control.
 *
 * It fails closed on every path that is not an explicit permission. An
 * evaluation that throws -- an audit row that could not be written -- propagates
 * and denies. A capability nobody registered denies. Silence is never
 * permission.
 *
 * It never consults anything the model can reach. The capability comes from the
 * tool NAME, the tier comes from the database, and the mode comes from the
 * database. The arguments are read only to fingerprint them, never to decide,
 * and the summary written to the audit table is built here from the tool name,
 * so a persuasive payload cannot argue its own way past the gate or turn the
 * audit table into a second copy of the archive.
 */

import type {
  AutonomyEvaluation,
  AutonomyServiceContract,
  AutonomyTier,
} from "./autonomy-types.js";
import { capabilityForTool, isToolClassified } from "./tool-capabilities.js";
import {
  argumentsFingerprint,
  type ToolConfirmationStoreContract,
} from "./tool-confirmations.js";

/**
 * What the caller may do with this tool call.
 *
 * `withheld` is the shadow-mode answer to an action that would be permitted in
 * live mode. It is separate from `deny` because collapsing them would make a
 * healthy shadow run indistinguishable from a wall of refusals -- the
 * distinction `AutonomyOutcome` already keeps and this carries forward.
 */
export type ToolGateVerdict = "permit" | "confirm" | "deny" | "withheld";

export interface ToolGateDecision {
  readonly verdict: ToolGateVerdict;
  readonly evaluation: AutonomyEvaluation;
  /** One line the owner reads. Always names the capability, tier and outcome. */
  readonly receipt: string;
  /**
   * The decision the owner tapped, when a standing confirmation is what let a
   * tier-3 call through. Null on every other path.
   */
  readonly confirmedBy: string | null;
}

export interface ToolGateEvaluationRequest {
  readonly toolName: string;
  readonly principalId: string;
  /** The raw JSON the model supplied. Fingerprinted, never stored or decided on. */
  readonly arguments: string;
}

export interface ToolAutonomyGateContract {
  evaluateToolCall(request: ToolGateEvaluationRequest): Promise<ToolGateDecision>;
}

/**
 * The audit summary. Built from the tool NAME only.
 *
 * Never the arguments: `autonomy_evaluations` is read during an incident review
 * and its own schema comment says it must not become a second copy of the
 * archive. A tool name is what an incident review needs and all it may have.
 */
export function toolSummary(toolName: string): string {
  return `tool ${toolName}`;
}

function describeTier(tier: AutonomyTier | null): string {
  return tier === null ? "unclassified" : `tier ${String(tier)}`;
}

/**
 * The receipt. One line, and it always carries the same facts: which capability
 * was evaluated, what tier it holds, what the outcome was, and the evaluation id
 * that keys the audit row.
 *
 * The evaluation id is in the visible receipt on purpose. A refusal the owner
 * cannot point at is a refusal he cannot ask about, and the defect this
 * replaces was a safety decision nobody could see.
 */
export function gateReceipt(
  evaluation: AutonomyEvaluation,
  toolName: string,
  classified: boolean,
  confirmedBy: string | null,
): string {
  const audit = `[autonomy ${evaluation.evaluationId} capability=${
    evaluation.capability
  } ${describeTier(evaluation.tier)} outcome=${evaluation.outcome}]`;
  switch (evaluation.outcome) {
    case "permitted":
      return `Allowed ${toolName} (${describeTier(evaluation.tier)}). ${audit}`;
    case "requires_confirmation":
      return confirmedBy === null
        ? `Nothing has happened yet: ${toolName} is ${
          describeTier(evaluation.tier)
        } and needs your tap before it runs. ${audit}`
        // The tap is why this ran, and the owner can see which one. Without the
        // decision id here a confirmed action looks identical to an unconfirmed
        // one in the only place he reads.
        : `Allowed ${toolName} (${describeTier(evaluation.tier)}, confirmed by you with decision ${confirmedBy}). ${audit}`;
    case "withheld_shadow":
      return `Nothing happened: ${toolName} is ${
        describeTier(evaluation.tier)
      } and Jarvis is still in shadow mode, so it was reported instead of run. ${audit}`;
    case "denied_unknown_capability":
      return classified
        ? `Nothing happened: ${toolName} is refused because its capability is not registered. ${audit}`
        // An unclassified tool is the case worth spelling out. The owner did
        // not misconfigure anything and cannot fix it by trying again, so the
        // receipt names the tool rather than blaming the request.
        : `Nothing happened: ${toolName} has no tier classification, so it was refused rather than run at a guessed one. ${audit}`;
  }
}

/** Maps the service's outcome onto what the caller may do. */
function verdictFor(evaluation: AutonomyEvaluation): ToolGateVerdict {
  switch (evaluation.outcome) {
    case "permitted":
      return "permit";
    case "requires_confirmation":
      return "confirm";
    case "withheld_shadow":
      return "withheld";
    case "denied_unknown_capability":
      return "deny";
  }
}

export class ToolAutonomyGate implements ToolAutonomyGateContract {
  readonly #service: AutonomyServiceContract;
  readonly #confirmations: ToolConfirmationStoreContract | null;

  constructor(
    service: AutonomyServiceContract,
    confirmations: ToolConfirmationStoreContract | null = null,
  ) {
    this.#service = service;
    this.#confirmations = confirmations;
  }

  async evaluateToolCall(request: ToolGateEvaluationRequest): Promise<ToolGateDecision> {
    const classified = isToolClassified(request.toolName);
    const capability = capabilityForTool(request.toolName);
    // Not wrapped in a catch that turns a failure into a verdict. The service
    // throws exactly when its audit row could not be written, and its contract
    // says that is a denial; converting it here would hand the caller a verdict
    // with no row behind it, which is the one thing the audit table exists to
    // prevent. The throw reaches `executeCalls`, which refuses the call.
    const first = await this.#service.evaluate({
      capability,
      principalId: request.principalId,
      summary: toolSummary(request.toolName),
      decisionId: null,
    });

    if (first.outcome !== "requires_confirmation" || this.#confirmations === null) {
      return Object.freeze({
        verdict: verdictFor(first),
        evaluation: first,
        receipt: gateReceipt(first, request.toolName, classified, null),
        confirmedBy: null,
      });
    }

    const argumentsHash = await argumentsFingerprint(request.arguments);
    const decisionId = await this.#confirmations.findStandingDecision({
      principalId: request.principalId,
      capability,
      argumentsHash,
      now: new Date(first.evaluatedAt),
    });
    if (decisionId === null) {
      return Object.freeze({
        verdict: "confirm",
        evaluation: first,
        receipt: gateReceipt(first, request.toolName, classified, null),
        confirmedBy: null,
      });
    }

    // Evaluated a second time with the decision attached. The first row records
    // that the policy asked, this one records which tap answered it, and an
    // incident review can follow the link without reading the conversation.
    const confirmed = await this.#service.evaluate({
      capability,
      principalId: request.principalId,
      summary: toolSummary(request.toolName),
      decisionId,
    });
    return Object.freeze({
      // The policy outcome is still `requires_confirmation`, because tier 3
      // always requires one. What changed is that one stands, which is why the
      // verdict is a permit and the receipt names the decision.
      verdict: "permit",
      evaluation: confirmed,
      receipt: gateReceipt(confirmed, request.toolName, classified, decisionId),
      confirmedBy: decisionId,
    });
  }
}
