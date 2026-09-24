import { DEADLINE_TOOL_DEFINITION, recordDeadline } from "../deadlines/deadline-tool.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import type { ExecutedTool } from "./owner-agent-core.js";

// Both channel catalogues import this list so a new hand cannot quietly exist
// on only one channel while the broader channel-parity work is in flight.
export const OWNER_ARGUMENT_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  DEADLINE_TOOL_DEFINITION,
]);

export function ownerArgumentTool(database: D1Database, input: Readonly<ModelAdapterStreamInput>,
  call: ModelFunctionCall, now: () => Date, ownerZone: string,
  readTurn: () => Promise<{ occurredAt: string }>): (() => Promise<ExecutedTool>) | null {
  if (call.name === "deadline_record") return async () => {
    const turn = await readTurn();
    return recordDeadline(database, input, call, now(), { ownerZone, messageAt: turn.occurredAt });
  };
  return null;
}
