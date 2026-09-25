/**
 * The two tools that let Jarvis judge a deadline he did not write himself.
 *
 * `deadline_record` creates and updates the deadlines Sid states. But most rows
 * in the store are collected -- Brightspace, Classroom, the D2L email handler --
 * and ingestion cannot know what kind of work "Final Exam" is without reading
 * the title's words, which is a judgment code does not make. So a collected row
 * is stored as `other` with `effort_judged` false, `deadline_list` shows the
 * model which rows are still unjudged, and `deadline_judge` writes the
 * judgment on any row by id. Code checks only facts it owns: the id names a
 * stored row, the effort is one of the six stored values, and the lead is a
 * real number of minutes in range.
 */

import { parseArguments, refusedTool, successfulTool, type ExecutedTool } from "../agent/owner-agent-core.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import { DeadlineRepository } from "./deadline-repository.js";
import { leadMinutesForWrite } from "./effort-lead-times.js";
import {
  requireEffort,
  requireLeadMinutes,
  requireText,
  type Deadline,
} from "./deadline-types.js";

const DAY = 86_400_000;
const MAXIMUM_LIST_DAYS = 365;
const MAXIMUM_IDENTIFIER_CHARACTERS = 256;

export const DEADLINE_JUDGMENT_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  Object.freeze({
    name: "deadline_list",
    description: "List Sid's open deadlines due in the next withinDays days, each with its deadlineId, course, title, due instant, stored effort, warning lead in minutes and source. A row shown as \"unjudged effort\" was collected from Brightspace, Google Classroom or his school email and no one has judged what kind of work it is yet; its stored effort is only the safe default other, so its warning lead is too short for an exam or a project until you judge it. After listing, call deadline_judge for every row marked unjudged effort, using its title, its course and anything Sid has said. Never infer an effort from a title word list. withinDays is your own window, from 1 to 365.",
    parameters: { type: "object", additionalProperties: false, required: ["withinDays"],
      properties: { withinDays: { type: "integer", minimum: 1, maximum: MAXIMUM_LIST_DAYS } } },
  }),
  Object.freeze({
    name: "deadline_judge",
    description: "Set the effort and warning lead on one stored deadline, including a collected one you saw in deadline_list. deadlineId is the id deadline_list gave you. effort is your judgment of what the work is -- quiz, test, exam, essay, project or other -- from its title, its course and anything Sid has said; a title alone is weak evidence, so if you are genuinely unsure what kind of work it is, say so or ask Sid rather than guessing from a keyword. leadMinutes is optional minutes of warning before the due time: leave it out to keep the stored lead when the effort is unchanged, or to use the new effort's stored default when you change the effort. This changes only the effort and the lead. It never changes the due date, the status or the source; use deadline_record for a deadline Sid stated or a status change.",
    parameters: { type: "object", additionalProperties: false, required: ["deadlineId", "effort"],
      properties: {
        deadlineId: { type: "string", description: "The deadlineId deadline_list showed you." },
        effort: { type: "string", enum: ["quiz", "test", "exam", "essay", "project", "other"] },
        leadMinutes: { type: "integer", description: "Optional minutes of warning before the due time; leave it out to keep the stored lead when the effort is unchanged." },
      } },
  }),
]);

function describeDeadline(deadline: Deadline): string {
  const effort = deadline.effortJudged ? `effort ${deadline.effort}` : "unjudged effort (stored other)";
  return `${deadline.deadlineId} ${JSON.stringify(deadline.course)}: ${JSON.stringify(deadline.title)} -- due ${deadline.dueAt}; ${effort}; lead ${deadline.leadMinutes} minutes; source ${deadline.sourceId}`;
}

async function listDeadlines(database: D1Database, call: ModelFunctionCall, now: Date): Promise<ExecutedTool> {
  const args = parseArguments(call, ["withinDays"]);
  const withinDays = args.withinDays;
  if (!Number.isSafeInteger(withinDays) || (withinDays as number) < 1 || (withinDays as number) > MAXIMUM_LIST_DAYS) {
    return refusedTool(call, "deadline_within_days_invalid: withinDays must be a whole number of days from 1 to 365. Nothing changed.");
  }
  const deadlines = await new DeadlineRepository(database).listDueWithin({
    from: now,
    to: new Date(now.getTime() + (withinDays as number) * DAY),
  });
  if (deadlines.length === 0) {
    return successfulTool(call, `No open deadlines are due in the next ${String(withinDays)} days.`);
  }
  const unjudged = deadlines.filter((deadline) => !deadline.effortJudged);
  const notice = unjudged.length === 0
    ? "Every listed deadline has a judged effort."
    : `${unjudged.length} of ${deadlines.length} listed deadlines have unjudged effort. Judge each one with deadline_judge; do not infer its effort from a title keyword.`;
  return successfulTool(call, `Open deadlines due in the next ${String(withinDays)} days:\n${deadlines.map(describeDeadline).join("\n")}\n${notice}`);
}

async function judgeDeadline(database: D1Database, call: ModelFunctionCall, now: Date): Promise<ExecutedTool> {
  const decoded = JSON.parse(call.arguments) as Record<string, unknown>;
  const args = parseArguments(call, ["deadlineId", "effort",
    ...(Object.hasOwn(decoded, "leadMinutes") ? ["leadMinutes"] : [])]);
  const deadlineId = requireText(args.deadlineId, "deadline_id", MAXIMUM_IDENTIFIER_CHARACTERS);
  const effort = requireEffort(args.effort);
  // Validate every field before the read, so a malformed call is refused by its
  // shape rather than depending on whether the id happens to exist.
  const requestedLead = args.leadMinutes === undefined ? null : requireLeadMinutes(args.leadMinutes);
  const repository = new DeadlineRepository(database);
  const existing = await repository.readDeadline(deadlineId);
  if (existing === null) {
    return refusedTool(call, `deadline_id_unknown: no stored deadline has the id ${JSON.stringify(deadlineId)}. Nothing changed.`);
  }
  // No lead named: keep the one already stored when the effort is unchanged, or
  // use the new effort's default when it changed. See `leadMinutesForWrite`.
  const leadMinutes = leadMinutesForWrite(requestedLead, existing, effort);
  const result = await repository.upsert({
    sourceId: existing.sourceId,
    externalId: existing.externalId,
    course: existing.course,
    title: existing.title,
    dueAt: existing.dueAt,
    effort,
    leadMinutes,
    replaceEffortAndLead: true,
    effortJudged: true,
    now,
  });
  return successfulTool(call, `Judged ${JSON.stringify(result.deadline.course)}: ${JSON.stringify(result.deadline.title)} as effort ${result.deadline.effort} with a ${result.deadline.leadMinutes}-minute warning lead; due ${result.deadline.dueAt} (${result.deadline.sourceId}). The due date and status are unchanged.`);
}

export function isDeadlineJudgmentTool(name: string): boolean {
  return DEADLINE_JUDGMENT_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

export async function executeDeadlineJudgmentTool(
  database: D1Database,
  call: ModelFunctionCall,
  now: Date,
): Promise<ExecutedTool> {
  try {
    if (call.name === "deadline_list") return await listDeadlines(database, call, now);
    if (call.name === "deadline_judge") return await judgeDeadline(database, call, now);
    throw new TypeError("deadline_judgment_tool_unknown");
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return refusedTool(call, `deadline_input_invalid (${error.message}): Use the documented fields and formats. Nothing changed.`);
    }
    throw error;
  }
}
