import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { groundedExcerpt, parseArguments, refusedTool, successfulTool, wordBoundaryOccurrence, type ExecutedTool } from "../agent/owner-agent-core.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import { DeadlineRepository } from "./deadline-repository.js";
import { containsDeadlineDateOrClock, DeadlineProofError, proveDeadlineDue } from "./deadline-date-proof.js";
import { DEFAULT_LEAD_MINUTES } from "./effort-classifier.js";
import { requireEffort, requireText, type DeadlineStatus } from "./deadline-types.js";

export const DEADLINE_TOOL_DEFINITION: ModelFunctionDefinition = Object.freeze({
  name: "deadline_record",
  description: "Record a deadline from Sid's CURRENT message, spoken or typed. Copy evidenceExcerpt and a short dueExcerpt containing ONE due expression. Course, title, and due phrase must occur in that order without a sentence separator or another date/clock in either gap; filler-only commas and connectors are allowed. Copy the stated course spelling, do not expand abbreviations. Resolve dueAt against the durable message timestamp in the configured owner zone. timeZone defaults to that zone; another IANA zone must be named in dueExcerpt. Supported dates: ISO, English month/day or day/month with optional year, weekdays, today, tomorrow, this weekday, next week optionally with weekday, and ordinal day (25th). This weekday means its next occurrence on or after the message date. Next weekday and a bare weekday naming today return deadline_ambiguous_date with both candidate dates: ask Sid which one. Bare clocks (3pm, at 3pm, tonight at 11:59pm) mean the message's local date; an already-passed bare/weekday/today clock is refused, never rolled forward. Today and tomorrow mean the current and next calendar dates while the owner small-hours window is unset; once its end hour is configured, those words ask which adjacent date only inside that window. Tonight with an a.m. clock always returns both candidate dates for clarification. Other clocks: 3:30 p.m. or 24-hour HH:mm. Missing/ambiguous clock means date-only: supply YYYY-MM-DD, stored at owner-zone end of day. The limited grammar still uses nearest occurrence for omitted year/ordinal and an explicitly unconfirmed end-of-week bound for bare next week. Never combine separate assignments. effort is your classification. Optional status: submitted (also handed in/turned in), missed, cancelled (also canceled), grounded in evidence. Omission preserves status. Finished work is school_update, not proof of submission; missed here is a missed deadline, school_update handles missed classwork. Normalised course/title updates an existing owner-reported row; uncertain matches ask for clarification. Platform sources may duplicate it.",
  parameters: {
    type: "object", additionalProperties: false,
    required: ["course", "title", "dueAt", "effort", "evidenceExcerpt", "dueExcerpt"],
    properties: {
      course: { type: "string" }, title: { type: "string" }, dueAt: { type: "string" },
      timeZone: { type: "string" }, evidenceExcerpt: { type: "string" }, dueExcerpt: { type: "string", maxLength: 160 },
      effort: { type: "string", enum: ["quiz", "test", "exam", "essay", "project", "other"] },
      status: { type: "string", enum: ["submitted", "handed in", "turned in", "missed", "cancelled", "canceled"] },
    },
  },
});

const STATUS_WORDS = { submitted: ["submitted", "handed in", "turned in"], missed: ["missed"], cancelled: ["cancelled", "canceled"] } as const;
const normalize = (value: string): string => value.toLocaleLowerCase("en-CA").replace(/\s+/gu, " ").trim();
const courseKey = normalize;
const identity = (principal: string, course: string, title: string): Promise<string> => sha256Hex(canonicalJson({ principal, course, title }));
const ASSIGNMENT_GAP_FILLERS = new Set([
  "is", "was", "will", "be", "due", "on", "by", "at", "it's", "the", "um", "uh", "for", "in",
]);
const ASSIGNMENT_GAP_WORD = /[\p{L}]+(?:['’][\p{L}]+)*/gu;
const assignmentGapBreaksTie = (gap: string): boolean => {
  if (/[.!?;]/u.test(gap) || containsDeadlineDateOrClock(gap)) return true;
  const hasSoftSeparator = gap.includes(",") || /(?:^|[^\p{L}\p{N}])and(?=$|[^\p{L}\p{N}])/u.test(gap);
  if (!hasSoftSeparator) return false;
  return (gap.match(ASSIGNMENT_GAP_WORD) ?? [])
    .some((word) => word !== "and" && !ASSIGNMENT_GAP_FILLERS.has(word.replace(/’/gu, "'")));
};

function statusOf(value: unknown, excerpt: string): DeadlineStatus | undefined {
  if (value === undefined) return undefined;
  const requested = normalize(requireText(value, "deadline_status", 32));
  for (const [status, words] of Object.entries(STATUS_WORDS)) {
    if (words.some((word) => word === requested) && words.some((word) => wordBoundaryOccurrence(normalize(excerpt), word) >= 0)) {
      return status as DeadlineStatus;
    }
  }
  throw new DeadlineProofError("deadline_status_not_proved", "Copy a stated submission, missed-deadline or cancellation word. Finished alone belongs to school_update.");
}

interface ExistingDeadline { external_id: string; course: string; title: string }
async function matchingDeadline(database: D1Database, principal: string, course: string, title: string): Promise<ExistingDeadline | null> {
  const rows = await database.prepare("SELECT external_id, course, title FROM deadlines WHERE source_id = 'owner-reported'").all<ExistingDeadline>();
  const owned: ExistingDeadline[] = [];
  for (const row of rows.results) {
    // Older rows hashed literal spelling. Both generations must retain their
    // principal boundary without requiring a migration of shared source rows.
    if (row.external_id === await identity(principal, row.course, row.title)
      || row.external_id === await identity(principal, courseKey(row.course), normalize(row.title))) owned.push(row);
  }
  const exact = owned.filter((row) => courseKey(row.course) === courseKey(course) && normalize(row.title) === normalize(title));
  if (exact.length === 1) return exact[0]!;
  const uncertain = exact.length > 1 ? exact : owned.filter((row) => {
    const a = courseKey(row.course), b = courseKey(course), x = normalize(row.title), y = normalize(title);
    return x === y && (a.startsWith(b) || b.startsWith(a))
      || a === b && (x.startsWith(y) || y.startsWith(x) || x.replace(/\W/gu, "") === y.replace(/\W/gu, ""));
  });
  if (uncertain.length > 0) throw new DeadlineProofError("deadline_ambiguous_match",
    `Ask which existing assignment is intended: ${uncertain.map((row) => `${JSON.stringify(row.course)} / ${JSON.stringify(row.title)}`).join(", ")}. No duplicate was created.`);
  return null;
}

export async function recordDeadline(database: D1Database, input: Readonly<ModelAdapterStreamInput>,
  call: ModelFunctionCall, now: Date, context: { ownerZone: string; messageAt: string }): Promise<ExecutedTool> {
  try {
    const decoded = JSON.parse(call.arguments) as Record<string, unknown>;
    const fields = ["course", "title", "dueAt", "effort", "evidenceExcerpt", "dueExcerpt"];
    const args = parseArguments(call, [...fields, ...["timeZone", "status"].filter((key) => Object.hasOwn(decoded, key))]);
    const excerpt = groundedExcerpt(input, args.evidenceExcerpt);
    if (args.dueExcerpt === "") throw new DeadlineProofError("deadline_missing_date", "Ask for the due date; no date was supplied.");
    const dueExcerpt = groundedExcerpt({ ...input, userText: excerpt }, args.dueExcerpt);
    requireText(dueExcerpt, "deadline_due_excerpt", 160);
    const course = requireText(args.course, "deadline_course", 512);
    const title = requireText(args.title, "deadline_title", 512);
    if (normalize(course).length === 0 || normalize(title).length === 0) {
      throw new DeadlineProofError("deadline_fields_not_in_evidence", "Copy a nonblank course and title from the current message.");
    }
    const evidence = normalize(excerpt);
    const courseStart = wordBoundaryOccurrence(evidence, normalize(course));
    const titleStart = wordBoundaryOccurrence(evidence, normalize(title));
    if (courseStart < 0 || titleStart < 0) {
      throw new DeadlineProofError("deadline_fields_not_in_evidence", "Copy the course and title from the grounded evidence.");
    }
    const dueStart = wordBoundaryOccurrence(evidence, normalize(dueExcerpt));
    const courseEnd = courseStart + normalize(course).length;
    const titleEnd = titleStart + normalize(title).length;
    const titleGap = evidence.slice(titleEnd, dueStart);
    if (dueStart < titleEnd || assignmentGapBreaksTie(titleGap)) {
      throw new DeadlineProofError("deadline_ambiguous_date", "The due phrase must follow this title without a sentence separator, another date or clock, or another assignment across a comma or and.");
    }
    const courseGap = evidence.slice(courseEnd, titleStart);
    if (titleStart < courseEnd || assignmentGapBreaksTie(courseGap)) {
      throw new DeadlineProofError("deadline_course_not_tied_to_assignment", "Copy the course, title and due phrase in order without a sentence separator, another date or clock, or another assignment across a comma or and.");
    }
    const status = statusOf(args.status, excerpt);
    const effort = requireEffort(args.effort);
    const proof = proveDeadlineDue({ dueAt: requireText(args.dueAt, "deadline_due_at", 64),
      ...(args.timeZone === undefined ? {} : { timeZone: requireText(args.timeZone, "deadline_zone", 128) }),
      ...context, dueExcerpt });
    const match = await matchingDeadline(database, input.principalId, course, title);
    const repository = new DeadlineRepository(database);
    await repository.ensureSource({ sourceId: "owner-reported", kind: "manual", label: "owner-reported", now });
    const externalId = match?.external_id ?? await identity(input.principalId, courseKey(course), normalize(title));
    const result = await repository.upsert({ sourceId: "owner-reported", externalId,
      course: match?.course ?? course, title: match?.title ?? title, dueAt: proof.dueAt,
      effort, ...(status === undefined ? {} : { status }), replaceEffortAndLead: true, leadMinutes: DEFAULT_LEAD_MINUTES[effort], now });
    const local = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: context.ownerZone, dateStyle: "full", timeStyle: "short" }).format(new Date(at));
    const action = result.outcome === "created" ? "Created" : result.outcome === "unchanged" ? "Unchanged" : "Updated";
    const previous = result.previous !== null && result.previous.dueAt !== result.deadline.dueAt
      ? ` Previous due time: ${local(result.previous.dueAt)} (${context.ownerZone}).` : "";
    const qualification = proof.dateOnly ? ` ${proof.note}; stored at end of day in ${context.ownerZone}, not a stated clock time.` : "";
    return successfulTool(call, `${action} ${JSON.stringify(result.deadline.course)}: ${JSON.stringify(result.deadline.title)}, due ${local(result.deadline.dueAt)} (${context.ownerZone}); ${result.deadline.status}.${qualification}${previous} Source: owner-reported.`);
  } catch (error) {
    if (error instanceof DeadlineProofError) return refusedTool(call, `${error.reason}: ${error.detail} Nothing changed.`);
    if (error instanceof TypeError || error instanceof SyntaxError) return refusedTool(call,
      `${error.message === "owner_agent_memory_grounding_invalid" ? "deadline_evidence_not_in_message" : "deadline_input_invalid"}: Copy evidence from the current message and use the documented fields and formats. Nothing changed.`);
    throw error;
  }
}
