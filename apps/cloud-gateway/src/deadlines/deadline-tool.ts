import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { groundedExcerpt, parseArguments, successfulTool, wordBoundaryOccurrence, type ExecutedTool } from "../agent/owner-agent-core.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import { DeadlineRepository } from "./deadline-repository.js";
import { requireEffort, requireStatus, requireText } from "./deadline-types.js";

export const DEADLINE_TOOL_DEFINITION: ModelFunctionDefinition = Object.freeze({
  name: "deadline_record",
  description: "Record a dated deadline Sid states in his CURRENT message. Copy course, title and evidenceExcerpt verbatim. dueAt is RFC3339 with an explicit offset, timeZone is its IANA zone. Evidence must include the full calendar date (year included) and clock time: ISO date, or English month/day/year, and 24-hour HH:mm or h:mm am/pm. Ask Sid to clarify relative dates, missing years or missing times; never invent a date or end-of-day time. effort is your classification. Optional status is submitted, missed or cancelled and must be stated in the evidence. Omitted status means open. The same exact course/title updates the owner-reported row; platform sources may duplicate it.",
  parameters: {
    type: "object", additionalProperties: false,
    required: ["course", "title", "dueAt", "timeZone", "effort", "evidenceExcerpt"],
    properties: {
      course: { type: "string" }, title: { type: "string" }, dueAt: { type: "string" },
      timeZone: { type: "string" }, evidenceExcerpt: { type: "string" },
      effort: { type: "string", enum: ["quiz", "test", "exam", "essay", "project", "other"] },
      status: { type: "string", enum: ["submitted", "missed", "cancelled"] },
    },
  },
});

/** Compare the model's instant with the stated wall date and time; no date is chosen here. */
export function proveDeadlineTime(dueAt: string, timeZone: string, excerpt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):00(?:\.000)?(Z|[+-]\d{2}:\d{2})$/u.exec(dueAt);
  if (match === null) throw new TypeError("deadline_time_invalid");
  const instant = new Date(dueAt);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const clock = `${parts.hour}:${parts.minute}`;
  if (date !== match[1] || clock !== match[2]) throw new TypeError("deadline_zone_or_date_invalid");
  const longMonth = new Intl.DateTimeFormat("en-CA", { timeZone, month: "long" }).format(instant);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const dates = [date, `${longMonth} ${day}, ${parts.year}`, `${longMonth} ${day} ${parts.year}`, `${day} ${longMonth} ${parts.year}`];
  const clocks = [clock, `${hour % 12 || 12}:${parts.minute} ${hour < 12 ? "am" : "pm"}`,
    `${hour % 12 || 12}:${parts.minute}${hour < 12 ? "am" : "pm"}`];
  const evidence = excerpt.toLocaleLowerCase("en-CA");
  if (!dates.some((value) => wordBoundaryOccurrence(evidence, value.toLowerCase()) >= 0)
    || !clocks.some((value) => wordBoundaryOccurrence(evidence, value) >= 0)) {
    throw new TypeError("deadline_date_not_in_evidence");
  }
  return instant.toISOString();
}

export async function recordDeadline(database: D1Database, input: Readonly<ModelAdapterStreamInput>,
  call: ModelFunctionCall, now: Date): Promise<ExecutedTool> {
  const fields = ["course", "title", "dueAt", "timeZone", "effort", "evidenceExcerpt"];
  let args: Record<string, unknown>;
  try { args = parseArguments(call, fields); }
  catch { args = parseArguments(call, [...fields, "status"]); }
  const excerpt = groundedExcerpt(input, args.evidenceExcerpt);
  const course = requireText(args.course, "deadline_course", 512);
  const title = requireText(args.title, "deadline_title", 512);
  const status = requireStatus(args.status ?? "open");
  const effort = requireEffort(args.effort);
  if (wordBoundaryOccurrence(excerpt, course) < 0 || wordBoundaryOccurrence(excerpt, title) < 0
    || (args.status !== undefined && (status === "open" || wordBoundaryOccurrence(excerpt, status) < 0))) {
    throw new TypeError("deadline_fields_not_in_evidence");
  }
  const timeZone = requireText(args.timeZone, "deadline_zone", 128);
  const dueAt = proveDeadlineTime(requireText(args.dueAt, "deadline_due_at", 64), timeZone, excerpt);
  const repository = new DeadlineRepository(database);
  await repository.ensureSource({ sourceId: "owner-reported", kind: "manual", label: "owner-reported", now });
  const externalId = await sha256Hex(canonicalJson({ principal: input.principalId, course, title }));
  await repository.upsert({ sourceId: "owner-reported", externalId, course, title, dueAt,
    effort, status, leadMinutes: 0, now });
  const local = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "full", timeStyle: "short" }).format(new Date(dueAt));
  return successfulTool(call, `Recorded ${JSON.stringify(course)}: ${JSON.stringify(title)}, due ${local} (${timeZone}); ${status}. Source: owner-reported.`);
}
