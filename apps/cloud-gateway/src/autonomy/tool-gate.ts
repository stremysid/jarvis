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
  CONFIRMATION_TTL_MS,
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
  /**
   * The agent turn that asked, when the channel may have to ask Sid a question
   * before answering. Optional because most callers never reach a channel.
   */
  readonly turn?: ToolGateTurn;
}

/**
 * The turn a tool call belongs to, as the gate needs it.
 *
 * `signal` is the turn's own abort signal. A channel question is tied to it,
 * so a turn that ends -- the call hung up, the turn was cancelled -- closes
 * the question and nothing it asked about can run afterwards.
 *
 * `holdDeadline` stops the turn's clock while the question is open and
 * returns the function that restarts it. Without it the turn budget, which
 * started before the model's first round, decides how long Sid has to answer
 * instead of the question's own forgiving timer.
 */
export interface ToolGateTurn {
  readonly signal: AbortSignal;
  holdDeadline(): () => void;
}

/**
 * What a channel answers when it asked Sid and he did not authorize: he said
 * cancel, ran out of attempts, did not answer, or the turn ended.
 *
 * Distinct from null, which means the channel could not ask at all (no PIN
 * configured, say). After a refusal the action is simply not done; it is not
 * turned into a Telegram card for something Sid just declined.
 */
export const CHANNEL_REFUSED: Readonly<{ refused: true }> = Object.freeze({ refused: true });
export type ToolChannelAuthorization = string | typeof CHANNEL_REFUSED | null;

/**
 * How a channel authorizes a tier-3 call when no standing tap can be spent.
 *
 * Telegram's keyboard is the confirmation surface the tap flow was built for.
 * A phone call has no button, so the medium's own authorization -- the spoken
 * or keypad four digit PIN -- arrives through this port instead. It is asked
 * only after a standing tap failed to be claimed, so a tap Sid already gave
 * keeps authorizing the call on either channel, and it returns an
 * authorization id that is then treated exactly like a decision id: the
 * evaluation is re-run with it attached, and a changed outcome denies.
 */
export interface ToolChannelAuthorizationRequest {
  readonly principalId: string;
  readonly toolName: string;
  readonly capability: string;
  readonly argumentsHash: string;
  /** The asking turn's signal. The channel must stop asking when it aborts. */
  readonly signal?: AbortSignal;
}

export interface ToolChannelAuthorizationPort {
  /**
   * The single-use authorization id; `CHANNEL_REFUSED` when the channel asked
   * and was not given one; or null when this channel cannot ask. A throw is a
   * denial: `ToolAutonomyGate` does not catch it, and the dispatcher turns it
   * into a refusal.
   */
  authorizeToolCall(request: ToolChannelAuthorizationRequest): Promise<ToolChannelAuthorization>;
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

function evaluationAudit(evaluation: AutonomyEvaluation): string {
  return `[autonomy ${evaluation.evaluationId} capability=${
    evaluation.capability
  } ${describeTier(evaluation.tier)} outcome=${evaluation.outcome}]`;
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
  via: "tap" | "pin" = "tap",
): string {
  const audit = evaluationAudit(evaluation);
  switch (evaluation.outcome) {
    case "permitted":
      return `Allowed ${toolName} (${describeTier(evaluation.tier)}). ${audit}`;
    case "requires_confirmation":
      return confirmedBy === null
        ? `Nothing has happened yet: ${toolName} is ${
          describeTier(evaluation.tier)
        } and needs your tap before it runs. Confirm again if the previous tap was already used or expired; each tap is valid once for ${CONFIRMATION_TTL_MS / 60_000} minutes. ${audit}`
        // Which authorization let it through is named in the only place the
        // owner reads. Without it a confirmed action looks identical to an
        // unconfirmed one.
        : via === "pin"
          ? `Allowed ${toolName} (${describeTier(evaluation.tier)}, confirmed by your PIN on this call). ${audit}`
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
  readonly #channel: ToolChannelAuthorizationPort | null;

  constructor(
    service: AutonomyServiceContract,
    confirmations: ToolConfirmationStoreContract | null = null,
    channel: ToolChannelAuthorizationPort | null = null,
  ) {
    this.#service = service;
    this.#confirmations = confirmations;
    this.#channel = channel;
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

    if (first.outcome !== "requires_confirmation" || this.#confirmations === null && this.#channel === null) {
      return Object.freeze({
        verdict: verdictFor(first),
        evaluation: first,
        receipt: gateReceipt(first, request.toolName, classified, null),
        confirmedBy: null,
      });
    }

    const argumentsHash = await argumentsFingerprint(request.arguments);
    let decisionId = this.#confirmations === null
      ? null
      : await this.#confirmations.consumeStandingDecision({
        principalId: request.principalId,
        toolName: request.toolName,
        capability,
        argumentsHash,
      });
    // The tap is asked for first and the channel second, so a confirmation Sid
    // already gave on the other channel keeps working and the call does not ask
    // him for a PIN it did not need.
    let via: "tap" | "pin" = "tap";
    let channelRefused = false;
    if (decisionId === null && this.#channel !== null) {
      const turn = request.turn;
      const resumeDeadline = turn?.holdDeadline() ?? ((): void => undefined);
      let answer: ToolChannelAuthorization;
      try {
        answer = turn !== undefined && turn.signal.aborted
          ? CHANNEL_REFUSED
          : await this.#channel.authorizeToolCall({
            principalId: request.principalId,
            toolName: request.toolName,
            capability,
            argumentsHash,
            ...(turn === undefined ? {} : { signal: turn.signal }),
          });
      } finally {
        resumeDeadline();
      }
      if (typeof answer === "string") {
        decisionId = answer;
        via = "pin";
      } else if (answer !== null) {
        channelRefused = true;
      }
    }
    // The turn that asked is over. Whatever answered, nothing it asked about
    // may run now: the reply that would have said so is gone, and Sid asking
    // again would run it a second time.
    if (request.turn?.signal.aborted === true) {
      return Object.freeze({
        verdict: "deny",
        evaluation: first,
        receipt: `Nothing happened: ${request.toolName} did not run because its turn ended before it could. ${evaluationAudit(first)}`,
        confirmedBy: null,
      });
    }
    if (channelRefused) {
      return Object.freeze({
        verdict: "deny",
        evaluation: first,
        receipt: `Nothing happened: ${request.toolName} was not confirmed on this call, so it did not run. ${evaluationAudit(first)}`,
        confirmedBy: null,
      });
    }
    if (decisionId === null) {
      return Object.freeze({
        verdict: "confirm",
        evaluation: first,
        receipt: gateReceipt(first, request.toolName, classified, null),
        confirmedBy: null,
      });
    }

    // Evaluated a second time with the authorization attached. The first row
    // records that the policy asked, this one records which tap or PIN answered
    // it, and an incident review can follow the link without reading the
    // conversation.
    const confirmed = await this.#service.evaluate({
      capability,
      principalId: request.principalId,
      summary: toolSummary(request.toolName),
      decisionId,
    });
    // A tap answers the first evaluation only. Even a newly permissive outcome
    // means the policy changed under it, so it cannot authorize this attempt.
    if (confirmed.outcome !== first.outcome) {
      return Object.freeze({
        verdict: "deny",
        evaluation: confirmed,
        receipt: `Nothing happened: ${request.toolName} was refused because its safety outcome changed from ${first.outcome} to ${confirmed.outcome} during confirmation. ${via === "pin" ? "The PIN authorization" : "The tap"} was spent and cannot be reused. ${evaluationAudit(confirmed)}`,
        confirmedBy: null,
      });
    }
    return Object.freeze({
      // The policy outcome is still `requires_confirmation`, because tier 3
      // always requires one. What changed is that one stands, which is why the
      // verdict is a permit and the receipt names the authorization.
      verdict: "permit",
      evaluation: confirmed,
      receipt: gateReceipt(confirmed, request.toolName, classified, decisionId, via),
      confirmedBy: decisionId,
    });
  }
}
