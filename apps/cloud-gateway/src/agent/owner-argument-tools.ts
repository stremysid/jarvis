import { DEADLINE_TOOL_DEFINITION, recordDeadline } from "../deadlines/deadline-tool.js";
import {
  DEADLINE_JUDGMENT_TOOL_DEFINITIONS,
  executeDeadlineJudgmentTool,
  isDeadlineJudgmentTool,
} from "../deadlines/deadline-judgment-tools.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import { executeReminderTool, isReminderTool, REMINDER_TOOL_DEFINITIONS } from "../reminders/reminder-tools.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import { WEB_TOOL_DEFINITIONS } from "../web/web-tools.js";
import type { ExecutedTool } from "./owner-agent-core.js";

// The shared owner catalogue includes argument tools so a new hand cannot
// quietly exist on only one channel.
// The web tools are dispatched by the core itself (`runWebTool`), not by
// `ownerArgumentTool`, because they need the gateway's fetch and AI binding
// rather than the database alone; listing them here is what puts them on
// every channel.
export const OWNER_ARGUMENT_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  DEADLINE_TOOL_DEFINITION,
  ...DEADLINE_JUDGMENT_TOOL_DEFINITIONS,
  ...REMINDER_TOOL_DEFINITIONS,
  ...WEB_TOOL_DEFINITIONS,
]);

// Authority is checked by the shared core before this runs: OwnerAgentCore
// requires direct owner text, re-reads the durable committed owner turn for
// this channel (memoryOwnerTurn) and passes the tier gate. That stored turn,
// with Sid's raw words, is the evidence for whatever the model records here.
export function ownerArgumentTool(database: D1Database, input: Readonly<ModelAdapterStreamInput>,
  call: ModelFunctionCall, now: () => Date, ownerZone: string): (() => Promise<ExecutedTool>) | null {
  if (call.name === "deadline_record") return async () => recordDeadline(database, input, call, now(), { ownerZone });
  if (isDeadlineJudgmentTool(call.name)) return async () => executeDeadlineJudgmentTool(database, call, now());
  if (isReminderTool(call.name)) return async () => executeReminderTool(database, input, call, now(), ownerZone);
  return null;
}
