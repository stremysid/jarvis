import { parseArguments, successfulTool, type ExecutedTool } from "../agent/owner-agent-core.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import { OwnerReminderRepository } from "./owner-reminders.js";

export const REMINDER_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  { name: "reminder_schedule", description: "Schedule a Telegram message to Sid. You choose at and the exact text from his needs and context; code chooses neither. at is an explicit UTC instant YYYY-MM-DDTHH:mm:ss.sssZ. A five-minute job delivers it at or after that time, subject to the existing non-urgent quiet windows. Do not claim exact-minute delivery. One reminder per turn. Use deadline_record separately for an assignment's due date.",
    parameters: { type: "object", additionalProperties: false, required: ["at", "text"],
      properties: { at: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 4096 } } } },
  { name: "reminder_list", description: "List Sid's reminders, including IDs, exact text, due instants, status and attempts. A failed reminder has unconfirmed delivery or may currently be sending: it may have arrived. Check with Sid before scheduling a replacement; never infer that failed means it was not sent.",
    parameters: { type: "object", additionalProperties: false, properties: {} } },
  { name: "reminder_cancel", description: "Cancel a pending reminder by its listed ID. Once dispatch has started it cannot be cancelled; report the tool's actual result.",
    parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } } },
]);

export function isReminderTool(name: string): boolean {
  return REMINDER_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

export async function executeReminderTool(database: D1Database, input: Readonly<ModelAdapterStreamInput>,
  call: ModelFunctionCall): Promise<ExecutedTool> {
  const repository = new OwnerReminderRepository(database);
  switch (call.name) {
    case "reminder_schedule": {
      const args = parseArguments(call, ["at", "text"]);
      const row = await repository.schedule(input.principalId, input.correlationId, args.at, args.text);
      return successfulTool(call, `Reminder ${row.id}: ${row.status}, due ${row.due_at}, text ${JSON.stringify(row.text)}. Quiet windows may delay delivery.`);
    }
    case "reminder_list": {
      parseArguments(call, []);
      const rows = (await repository.list(input.principalId)).map(({ id, due_at, text, status, sent_at, attempts }) =>
        ({ id, at: due_at, text, status, sentAt: sent_at, attempts }));
      return successfulTool(call, `Reminders: ${JSON.stringify(rows)}`);
    }
    case "reminder_cancel": {
      const args = parseArguments(call, ["id"]);
      const cancelled = await repository.cancel(input.principalId, args.id);
      return successfulTool(call, cancelled
        ? `Cancelled reminder ${String(args.id)}.`
        : "No pending reminder with that ID was cancelled. A dispatch already started cannot be recalled.");
    }
    default: throw new TypeError("owner_reminder_tool_unknown");
  }
}
