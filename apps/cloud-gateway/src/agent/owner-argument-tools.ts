import { DEADLINE_TOOL_DEFINITION, recordDeadline } from "../deadlines/deadline-tool.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
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
  ...WEB_TOOL_DEFINITIONS,
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
