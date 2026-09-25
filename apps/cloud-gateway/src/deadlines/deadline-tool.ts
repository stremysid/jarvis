import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { parseArguments, refusedTool, successfulTool, type ExecutedTool } from "../agent/owner-agent-core.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelFunctionCall, ModelFunctionDefinition } from "../providers/provider-types.js";
import { DeadlineRepository } from "./deadline-repository.js";
import { DEFAULT_LEAD_MINUTES } from "./effort-classifier.js";
import { DEADLINE_STATUSES, requireEffort, requireStatus, requireText, type DeadlineStatus } from "./deadline-types.js";

// Jarvis reads Sid's words and decides the course, title, due time, effort and
// status. This tool only checks facts code owns: the arguments are well typed,
// the date is a real calendar date or instant, the zone is a real IANA zone,
// and the row it writes or updates is Sid's own. It never parses Sid's wording
// (Sid, 2026-09-24: "code should never make a decision or restrict jarvis").
export const DEADLINE_TOOL_DEFINITION: ModelFunctionDefinition = Object.freeze({
  name: "deadline_record",
  description: "Record or update one of Sid's school deadlines from his current message, typed or spoken. You decide the course, title, due date and time, effort and status from what he said; the owner time zone and the message time are in your context for resolving words like Friday, tomorrow or 3pm. If you are truly unsure which date, time, assignment or status he means, ask him instead of calling this tool. dueAt: an ISO 8601 instant with an explicit offset or Z (2026-09-25T15:00:00-04:00) when you know the time, or a calendar date YYYY-MM-DD when you only know the day; a date is stored at the end of that day in timeZone and the receipt says no clock time was given. timeZone: optional IANA zone for a date-only dueAt, defaulting to the owner zone. effort is your classification. status: optional, one of open, submitted, missed or cancelled, as you judge from what Sid said; leave it out to keep the stored status. Calling again with the same course and title (case and spacing ignored) updates that row instead of adding one. The receipt names other stored deadlines with a similar name; if one of them is the same assignment, tell Sid and use its exact course and title. Platform sources may also list the same assignment.",
  parameters: {
    type: "object", additionalProperties: false,
    required: ["course", "title", "dueAt", "effort"],
    properties: {
      course: { type: "string" }, title: { type: "string" },
      dueAt: { type: "string", description: "ISO 8601 instant with offset or Z, or a YYYY-MM-DD date." },
      timeZone: { type: "string", description: "IANA zone for a date-only dueAt; defaults to the owner zone." },
      effort: { type: "string", enum: ["quiz", "test", "exam", "essay", "project", "other"] },
      status: { type: "string", enum: [...DEADLINE_STATUSES] },
    },
  },
});

class DeadlineToolError extends Error {
  constructor(readonly reason: string, readonly detail: string) { super(reason); }
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const normalize = (value: string): string => value.toLocaleLowerCase("en-CA").replace(/\s+/gu, " ").trim();
const courseKey = normalize;
const identity = (principal: string, course: string, title: string): Promise<string> => sha256Hex(canonicalJson({ principal, course, title }));

function invalid(detail: string): never { throw new DeadlineToolError("deadline_input_invalid", detail); }

function realDate(year: string, month: string, day: string): string {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // Date rolls 2026-02-30 forward to March, so only a round trip proves the day exists.
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) {
    invalid(`${year}-${month}-${day} is not a real calendar date.`);
  }
  return `${year}-${month}-${day}`;
}

function requireZone(value: unknown, label: string): string {
  const zone = requireText(value, label, 128);
  try {
    // Intl also accepts bare offsets such as -04:00; an IANA name starts with a letter.
    if (!/^[A-Za-z]/u.test(zone)) throw new Error();
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(0));
  } catch { invalid(`${zone} is not an IANA time zone.`); }
  return zone;
}

function wallMinute(format: Intl.DateTimeFormat, instant: number): string {
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** The last instant of a local calendar day: 23:59:59.999 wall time in the zone. */
function endOfLocalDay(date: string, zone: string): number {
  const wall = Date.parse(`${date}T23:59:00Z`);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Every current zone offset is a whole quarter hour within a day of UTC, so
  // these candidates include every instant showing 23:59 on that local date.
  let latest: number | null = null;
  for (let offset = -DAY; offset <= DAY; offset += 15 * MINUTE) {
    const candidate = wall - offset;
    if (wallMinute(format, candidate) === `${date}T23:59` && (latest === null || candidate > latest)) latest = candidate;
  }
  if (latest === null) invalid(`${date} has no 23:59 in ${zone}; give an instant with its offset instead.`);
  return latest + 59_999;
}

interface ResolvedDue { readonly dueAt: string; readonly dateOnlyZone: string | null }

function resolveDue(value: unknown, timeZone: string): ResolvedDue {
  const text = requireText(value, "deadline_due_at", 64);
  const date = DATE_ONLY.exec(text);
  if (date !== null) {
    return { dueAt: new Date(endOfLocalDay(realDate(date[1]!, date[2]!, date[3]!), timeZone)).toISOString(), dateOnlyZone: timeZone };
  }
  const instant = INSTANT.exec(text);
  if (instant === null) invalid("dueAt must be an ISO 8601 instant with an offset or Z, or a YYYY-MM-DD date.");
  realDate(instant[1]!, instant[2]!, instant[3]!);
  const [hour, minute, second] = [Number(instant[4]), Number(instant[5]), Number(instant[6] ?? "0")];
  const [offsetHour, offsetMinute] = [Number(instant[8] ?? "0"), Number(instant[9] ?? "0")];
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59) {
    invalid(`${text} is not a real clock time or offset.`);
  }
  return { dueAt: new Date(Date.parse(text)).toISOString(), dateOnlyZone: null };
}

interface ExistingDeadline { external_id: string; course: string; title: string }

async function ownedDeadlines(database: D1Database, principal: string): Promise<ExistingDeadline[]> {
  const rows = await database.prepare("SELECT external_id, course, title FROM deadlines WHERE source_id = 'owner-reported'").all<ExistingDeadline>();
  const owned: ExistingDeadline[] = [];
  for (const row of rows.results) {
    // Older rows hashed literal spelling. Both generations must retain their
    // principal boundary without requiring a migration of shared source rows.
    if (row.external_id === await identity(principal, row.course, row.title)
      || row.external_id === await identity(principal, courseKey(row.course), normalize(row.title))) owned.push(row);
  }
  return owned;
}

/**
 * The same assignment is the same normalised course and title, so a repeat
 * updates rather than duplicates. Names that merely look alike are returned
 * as a hint for Jarvis to weigh; code never blocks a save on them.
 */
function sameAndSimilar(owned: readonly ExistingDeadline[], course: string, title: string) {
  const b = courseKey(course), y = normalize(title);
  const same = owned.filter((row) => courseKey(row.course) === b && normalize(row.title) === y);
  if (same.length > 1) {
    // Two stored rows already share one identity (legacy literal hashes), so
    // there is no single row to update. That is a storage fact, not wording.
    throw new DeadlineToolError("deadline_ambiguous_match",
      `More than one stored row is ${JSON.stringify(course)} / ${JSON.stringify(title)}. No duplicate was created.`);
  }
  const similar = owned.filter((row) => {
    const a = courseKey(row.course), x = normalize(row.title);
    if (a === b && x === y) return false;
    return x === y && (a.startsWith(b) || b.startsWith(a))
      || a === b && (x.startsWith(y) || y.startsWith(x) || x.replace(/\W/gu, "") === y.replace(/\W/gu, ""));
  });
  return { match: same[0] ?? null, similar };
}

export async function recordDeadline(database: D1Database, input: Readonly<ModelAdapterStreamInput>,
  call: ModelFunctionCall, now: Date, context: { ownerZone: string }): Promise<ExecutedTool> {
  try {
    const decoded = JSON.parse(call.arguments) as Record<string, unknown>;
    const args = parseArguments(call, ["course", "title", "dueAt", "effort",
      ...["timeZone", "status"].filter((key) => Object.hasOwn(decoded, key))]);
    const course = requireText(args.course, "deadline_course", 512);
    const title = requireText(args.title, "deadline_title", 512);
    if (normalize(course).length === 0 || normalize(title).length === 0) invalid("course and title must not be blank.");
    const effort = requireEffort(args.effort);
    const status: DeadlineStatus | undefined = args.status === undefined ? undefined : requireStatus(args.status);
    const ownerZone = requireZone(context.ownerZone, "deadline_owner_zone");
    const timeZone = args.timeZone === undefined ? ownerZone : requireZone(args.timeZone, "deadline_zone");
    const due = resolveDue(args.dueAt, timeZone);
    const { match, similar } = sameAndSimilar(await ownedDeadlines(database, input.principalId), course, title);
    const repository = new DeadlineRepository(database);
    await repository.ensureSource({ sourceId: "owner-reported", kind: "manual", label: "owner-reported", now });
    const externalId = match?.external_id ?? await identity(input.principalId, courseKey(course), normalize(title));
    const result = await repository.upsert({ sourceId: "owner-reported", externalId,
      course: match?.course ?? course, title: match?.title ?? title, dueAt: due.dueAt,
      effort, ...(status === undefined ? {} : { status }), replaceEffortAndLead: true, leadMinutes: DEFAULT_LEAD_MINUTES[effort], now });
    const local = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: ownerZone, dateStyle: "full", timeStyle: "short" }).format(new Date(at));
    const action = result.outcome === "created" ? "Created" : result.outcome === "unchanged" ? "Unchanged" : "Updated";
    const previous = result.previous !== null && result.previous.dueAt !== result.deadline.dueAt
      ? ` Previous due time: ${local(result.previous.dueAt)} (${ownerZone}).` : "";
    const qualification = due.dateOnlyZone === null ? ""
      : ` Date-only: stored at end of day in ${due.dateOnlyZone}, not a stated clock time.`;
    const alike = similar.length === 0 ? "" : ` Similar stored deadlines: ${similar.map((row) =>
      `${JSON.stringify(row.course)} / ${JSON.stringify(row.title)}`).join(", ")}; if one is the same assignment, tell Sid.`;
    return successfulTool(call, `${action} ${JSON.stringify(result.deadline.course)}: ${JSON.stringify(result.deadline.title)}, due ${local(result.deadline.dueAt)} (${ownerZone}); ${result.deadline.status}.${qualification}${previous}${alike} Source: owner-reported.`);
  } catch (error) {
    if (error instanceof DeadlineToolError) return refusedTool(call, `${error.reason}: ${error.detail} Nothing changed.`);
    if (error instanceof TypeError || error instanceof SyntaxError) return refusedTool(call,
      `deadline_input_invalid (${error.message}): Use the documented fields and formats. Nothing changed.`);
    throw error;
  }
}
