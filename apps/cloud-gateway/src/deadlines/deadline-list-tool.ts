/**
 * `deadline_list`: Jarvis's view of the deadlines code stores.
 *
 * Code stores what the school systems and Sid state, including a due date of
 * "none". It does not rank deadlines, does not decide which are urgent and does
 * not schedule warnings. This tool shows the model the stored rows; whether and
 * when Sid is warned is the model's call through the reminder tools, and an
 * assignment with no due date is something the model asks Sid about rather than
 * something code fills in.
 */

import { parseArguments, refusedTool, successfulTool, type ExecutedTool } from "../agent/owner-agent-core.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import { DeadlineRepository } from "./deadline-repository.js";
import type { Deadline } from "./deadline-types.js";

const DAY = 86_400_000;
const MAXIMUM_LIST_DAYS = 365;

export const DEADLINE_LIST_TOOL_DEFINITION: ModelFunctionDefinition = Object.freeze({
  name: "deadline_list",
  description: "List Sid's stored school deadlines: those due in the next withinDays days, plus every open deadline that has no due date. Each line carries the deadlineId, course, title, due instant or \"no due date\", status and source. A line reading \"no due date\" means the school system stated none: ask Sid for it in a normal message, and store what he answers with deadline_record. Never invent or guess a date, and never treat a missing date as nothing to do. You decide whether and when Sid is warned about each deadline; use reminder_schedule for that, reminder_list to avoid scheduling a duplicate, and reminder_cancel to withdraw one. withinDays is your own window, from 1 to 365.",
  parameters: { type: "object", additionalProperties: false, required: ["withinDays"],
    properties: { withinDays: { type: "integer", minimum: 1, maximum: MAXIMUM_LIST_DAYS } } },
});

function describeDeadline(deadline: Deadline): string {
  const due = deadline.dueAt === null ? "no due date" : `due ${deadline.dueAt}`;
  return `${deadline.deadlineId} ${JSON.stringify(deadline.course)}: ${JSON.stringify(deadline.title)} -- ${due}; ${deadline.status}; source ${deadline.sourceId}`;
}

export function isDeadlineListTool(name: string): boolean {
  return name === "deadline_list";
}

export async function executeDeadlineListTool(
  database: D1Database,
  call: ModelFunctionCall,
  now: Date,
): Promise<ExecutedTool> {
  try {
    const args = parseArguments(call, ["withinDays"]);
    const withinDays = args.withinDays;
    if (!Number.isSafeInteger(withinDays) || (withinDays as number) < 1 || (withinDays as number) > MAXIMUM_LIST_DAYS) {
      return refusedTool(call, "deadline_within_days_invalid: withinDays must be a whole number of days from 1 to 365. Nothing changed.");
    }
    const deadlines = await new DeadlineRepository(database).listReviewable({
      from: now,
      to: new Date(now.getTime() + (withinDays as number) * DAY),
    });
    if (deadlines.length === 0) {
      return successfulTool(call, `No open deadlines are due in the next ${String(withinDays)} days and none lack a due date.`);
    }
    const undated = deadlines.filter((deadline) => deadline.dueAt === null);
    const notice = undated.length === 0
      ? ""
      : `\n${undated.length} of ${deadlines.length} have no due date; ask Sid for those dates and store them with deadline_record.`;
    return successfulTool(call, `Open deadlines due in the next ${String(withinDays)} days, and every undated one:\n${deadlines.map(describeDeadline).join("\n")}${notice}`);
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return refusedTool(call, `deadline_input_invalid (${error.message}): Use the documented fields and formats. Nothing changed.`);
    }
    throw error;
  }
}
