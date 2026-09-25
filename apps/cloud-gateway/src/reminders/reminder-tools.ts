import { parseArguments, refusedTool, successfulTool, type ExecutedTool } from "../agent/owner-agent-core.js";
import { requireInstant } from "../deadlines/deadline-types.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import { OwnerReminderRepository, OwnerReminderWriteUnconfirmedError } from "./owner-reminders.js";

export const REMINDER_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  { name: "reminder_schedule", description: "Schedule a Telegram message to Sid. You choose at and the exact text from his needs and context; code chooses neither. The channel prompt supplies the current UTC instant and Sid's owner zone. at is an explicit UTC instant YYYY-MM-DDTHH:mm:ss.sssZ, no earlier than five minutes before the current instant; there is no upper limit. The message is always delivered as a Telegram message, whether he asked on Telegram or on a call. A five-minute job delivers up to ten due messages per run at or after their times, subject to the existing non-urgent quiet windows. Do not claim exact-minute delivery. Repeating the same at and text in one turn returns the original reminder. Use deadline_record separately for an assignment's due date.",
    parameters: { type: "object", additionalProperties: false, required: ["at", "text"],
      properties: { at: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 4096 } } } },
  { name: "reminder_list", description: "List Sid's reminders, including IDs, exact text, due instants, status and attempts. A rejected reminder was not delivered and will not retry. Authentication and rate-limit refusals stay pending for retry. A failed reminder has unconfirmed delivery or may currently be sending: it may have arrived. Check with Sid before scheduling a replacement; never infer that failed means it was not sent.",
    parameters: { type: "object", additionalProperties: false, properties: {} } },
  { name: "reminder_cancel", description: "Cancel a pending reminder by its listed ID. Once dispatch has started it cannot be cancelled; report the tool's actual result.",
    parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } } },
]);

export function isReminderTool(name: string): boolean {
  return REMINDER_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

export async function executeReminderTool(database: D1Database, input: Readonly<ModelAdapterStreamInput>,
  call: ModelFunctionCall, now: Date, ownerZone: string): Promise<ExecutedTool> {
  const repository = new OwnerReminderRepository(database);
  switch (call.name) {
    case "reminder_schedule": {
      const args = parseArguments(call, ["at", "text"]);
      const at = requireInstant(args.at, "owner_reminder_at");
      const due = Date.parse(at);
      // The clock is a fact code owns: an instant already past cannot be kept as
      // "at that time", and a wrong-year guess would otherwise fire immediately.
      // How far ahead to remind is Sid's and the model's choice, so no upper cap.
      if (due < now.getTime() - 5 * 60_000) return refusedTool(call, "owner_reminder_at_past: choose a time no earlier than five minutes before the current instant. Nothing changed.");
      // Format before writing so a bad zone cannot turn a saved row into a false refusal.
      const localDue = new Intl.DateTimeFormat("en-CA", { timeZone: ownerZone,
        dateStyle: "medium", timeStyle: "long" }).format(new Date(at));
      try {
        const row = await repository.schedule(input.principalId, input.correlationId, at, args.text);
        return successfulTool(call, `Reminder ${row.id}: ${row.status}, due ${localDue} (${ownerZone}; UTC ${row.due_at}), text ${JSON.stringify(row.text)}. It will arrive as a Telegram message; quiet windows may delay delivery.`);
      } catch (error) {
        if (error instanceof OwnerReminderWriteUnconfirmedError) return refusedTool(call,
          "owner_reminder_write_unconfirmed: the reminder may have been saved. Check reminder_list before scheduling it again.");
        throw error;
      }
    }
    case "reminder_list": {
      parseArguments(call, []);
      const rows = (await repository.list(input.principalId)).map(({ id, due_at, text, status, sent_at, attempts }) =>
        ({ id, at: due_at, text, status, sentAt: sent_at, attempts,
          ...(status === "rejected" ? { delivery: "not delivered" } : {}) }));
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
