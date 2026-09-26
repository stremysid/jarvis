/**
 * The reporting capabilities the model reaches as tools.
 *
 * Telegram used to answer `/status`, `/queue` and `/digest` from a code router
 * before the model ran. That made those three capabilities Telegram-only: a
 * call could not ask what was waiting on Sid or read a digest, because the
 * command text only ever arrived on one channel. They are tools now, in the
 * shared owner catalogue, so Telegram and voice dispatch the same three and
 * code reads no wording at all.
 *
 * The results are evidence rather than receipts: `owner_status`,
 * `decision_queue` and `run_digest` change nothing the model may claim it did,
 * so they mint no receipt id and their content is the model's reference data.
 */

import type { DecisionItem } from "../decisions/decision-types.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import {
  parseArguments,
  refusedTool,
  unactionedTool,
  type ExecutedTool,
} from "./owner-agent-core.js";
import type { OwnerCommandCapabilities } from "./owner-command-capabilities.js";

export const OWNER_STATUS_TOOL_NAME = "owner_status";
export const DECISION_QUEUE_TOOL_NAME = "decision_queue";
export const RUN_DIGEST_TOOL_NAME = "run_digest";

const EMPTY_ARGUMENTS = Object.freeze({ type: "object", additionalProperties: false, properties: {} });

/**
 * The tool descriptions tell the model which words map to which read, so
 * "/queue" or "what's waiting on me" both reach `decision_queue` without code
 * recognising either phrase.
 */
export const OWNER_COMMAND_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  Object.freeze({
    name: OWNER_STATUS_TOOL_NAME,
    description: "Read Jarvis's own status for the owner: autonomy mode, the scheduled jobs and their last run, and memory index coverage. Use this for \"/status\" or \"how are you doing?\" questions about the system itself, not for the owner's own deadlines or tracker.",
    parameters: EMPTY_ARGUMENTS,
  }),
  Object.freeze({
    name: DECISION_QUEUE_TOOL_NAME,
    description: "Read every question still waiting on the owner, in the queue's own order. Use this for \"/queue\", \"what's waiting on me?\" or \"what do you need from me?\". The result is the questions and their answer choices; answering a stored question still happens by the owner's tap on the message that asked it, so read the questions out rather than claiming to have answered one.",
    parameters: EMPTY_ARGUMENTS,
  }),
  Object.freeze({
    name: RUN_DIGEST_TOOL_NAME,
    description: "Assemble today's digest now and return its text, for \"/digest\", \"what's my day look like?\" or \"give me the digest\". It is assembled but not sent, so put its text in your reply instead of saying you sent it.",
    parameters: EMPTY_ARGUMENTS,
  }),
]);

function queueEvidence(items: readonly DecisionItem[]): string {
  if (items.length === 0) return "Nothing is waiting on the owner.";
  return items.map((item) => {
    const prefix = item.urgency === "urgent" ? "!" : "-";
    const choices = item.options.map((option) => option.label).join(", ");
    return `${prefix} ${item.question} [${choices}]`;
  }).join("\n");
}

/**
 * Resolve a channel's reporting capabilities into a tool body, or null when
 * the call is not one of the three. The shared core checks authority and the
 * tier gate before this runs, exactly as it does for every other tool.
 */
export function ownerCommandTool(
  capabilities: OwnerCommandCapabilities | undefined,
  call: ModelFunctionCall,
): (() => Promise<ExecutedTool>) | null {
  if (call.name !== OWNER_STATUS_TOOL_NAME && call.name !== DECISION_QUEUE_TOOL_NAME
    && call.name !== RUN_DIGEST_TOOL_NAME) {
    return null;
  }
  if (capabilities === undefined) {
    return async () => refusedTool(call, "That report is not configured on this deployment. Nothing changed.");
  }
  return async () => {
    try {
      parseArguments(call, []);
      if (call.name === OWNER_STATUS_TOOL_NAME) {
        return unactionedTool(call, await capabilities.status(), []);
      }
      if (call.name === DECISION_QUEUE_TOOL_NAME) {
        return unactionedTool(call, queueEvidence(await capabilities.queue()), []);
      }
      return unactionedTool(call, await capabilities.digest(), []);
    } catch (error) {
      return refusedTool(call,
        `That report failed: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`);
    }
  };
}
