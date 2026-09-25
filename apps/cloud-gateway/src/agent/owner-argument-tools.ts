import { DEADLINE_TOOL_DEFINITION, recordDeadline } from "../deadlines/deadline-tool.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import type { ExecutedTool } from "./owner-agent-core.js";

// The shared owner catalogue includes argument tools so a new hand cannot
// quietly exist on only one channel.
export const OWNER_ARGUMENT_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  DEADLINE_TOOL_DEFINITION,
]);

// Authority is checked by the shared core before this runs: OwnerAgentCore
// requires direct owner text, re-reads the durable committed owner turn for
// this channel (memoryOwnerTurn) and passes the tier gate. That stored turn,
// with Sid's raw words, is the evidence for whatever the model records here.
export function ownerArgumentTool(database: D1Database, input: Readonly<ModelAdapterStreamInput>,
  call: ModelFunctionCall, now: () => Date, ownerZone: string): (() => Promise<ExecutedTool>) | null {
  if (call.name === "deadline_record") return async () => recordDeadline(database, input, call, now(), { ownerZone });
  return null;
}
