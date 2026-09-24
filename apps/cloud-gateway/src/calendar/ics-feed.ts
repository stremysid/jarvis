import type { Deadline } from "../deadlines/deadline-types.js";
import type { SchoolCatchupAction } from "../school/school-catchup-types.js";
import type {
  UniversityApplicationDigestItem,
  UniversityWorkflowDigestItem,
} from "../university/university-tracker-types.js";

export interface CalendarFeedInput {
  readonly now: Date;
  /** Read-only repository queries supply planned actions and open deadlines. */
  readonly actions: readonly SchoolCatchupAction[];
  readonly deadlines: readonly Deadline[];
  readonly applications: readonly UniversityApplicationDigestItem[];
  readonly workflows: readonly UniversityWorkflowDigestItem[];
}

const encoder = new TextEncoder();

function text(value: string): string {
  // Escape line breaks before stripping controls: source text stays text even
  // when it contains an apparent property or component boundary.
  return value.replace(/\\/gu, "\\\\").replace(/\r\n|\r|\n/gu, "\\n")
    .replace(/\p{C}/gu, "").replace(/;/gu, "\\;").replace(/,/gu, "\\,");
}

function fold(line: string): string {
  let result = "";
  let octets = 0;
  for (const character of line) {
    const size = encoder.encode(character).byteLength;
    if (octets + size > 75) {
      result += "\r\n ";
      octets = 1;
    }
    result += character;
    octets += size;
  }
  return result;
}

function instant(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
}

function date(value: string): string {
  return value.replace(/-/gu, "");
}

/** Deterministic serialization of saved rows; no model, fetch, or persistence. */
export function composeCalendarFeed(input: CalendarFeedInput): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jarvis//School Calendar//EN", "CALSCALE:GREGORIAN"];
  const stamp = instant(input.now.toISOString());
  function event(uid: string, summary: string, start: string, alarm: readonly string[] = []): void {
    lines.push("BEGIN:VEVENT", `UID:${text(uid)}@jarvis`, `DTSTAMP:${stamp}`,
      start, `SUMMARY:${text(summary)}`, ...alarm, "END:VEVENT");
  }
  // A DATE event without DTEND lasts one day; timed deadlines are instants,
  // so inventing a duration would imply time the stored plan never allocated.
  for (const action of input.actions) {
    event(`catchup-${action.actionId}`, `${action.courseName}: ${action.text} (${action.estimatedMinutes} min)`,
      `DTSTART;VALUE=DATE:${date(action.localDate)}`);
  }
  for (const deadline of input.deadlines) {
    const summary = `${deadline.course}: ${deadline.title}`;
    event(`deadline-${deadline.deadlineId}`, summary, `DTSTART:${instant(deadline.dueAt)}`, [
      "BEGIN:VALARM", `TRIGGER:-PT${deadline.leadMinutes}M`, "ACTION:DISPLAY",
      `DESCRIPTION:${text(summary)}`, "END:VALARM",
    ]);
  }
  for (const item of input.applications) {
    if (item.dueDate === null) continue;
    event(`application-${item.itemId}`, `[${item.verification.state}] ${item.university} / ${item.programName}: ${item.label}`,
      `DTSTART;VALUE=DATE:${date(item.dueDate)}`);
  }
  for (const item of input.workflows) {
    const due = item.deadline;
    if (due.instant === null && due.date === null) continue;
    const start = due.instant !== null ? `DTSTART:${instant(due.instant)}` : `DTSTART;VALUE=DATE:${date(due.date!)}`;
    event(`workflow-${item.workflowId}`, `[${due.verification.state}] ${item.university} / ${item.programName}: ${item.label}`, start);
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
