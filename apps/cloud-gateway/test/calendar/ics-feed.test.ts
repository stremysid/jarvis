import { describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { composeCalendarFeed, type CalendarFeedInput } from "../../src/calendar/ics-feed.js";
import type { SchoolCatchupAction } from "../../src/school/school-catchup-types.js";
import type { Deadline } from "../../src/deadlines/deadline-types.js";
import type { UniversityApplicationDigestItem, UniversityWorkflowDigestItem } from "../../src/university/university-tracker-types.js";

const now = new Date("2026-09-23T12:34:56.789Z");
const id = newUlid(now);
const verification = { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null } as const;
const action: SchoolCatchupAction = {
  actionId: id, courseId: id, courseName: "Chemistry", text: "Finish the lab", estimatedMinutes: 25,
  localDate: "2026-09-23", sequenceRank: 1, status: "planned",
};
const deadline: Deadline = {
  deadlineId: id, sourceId: "fixture", externalId: "fixture", course: "Physics", title: "Unit test",
  dueAt: "2026-11-01T06:30:00.000Z", leadMinutes: 90, effort: "test", status: "open",
  contentHash: "a".repeat(64), firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), remindedAt: null,
};
const application: UniversityApplicationDigestItem = {
  itemId: id, kind: "essay", label: "Essay", status: "drafting", dueDate: "2027-01-15",
  verification, sourceTurnId: id, submittedAt: null, updatedAt: now.toISOString(),
  university: "Test University", programName: "Computing",
};
const workflow: UniversityWorkflowDigestItem = {
  workflowId: id, eventId: id, revision: 1, applicationItemId: null, kind: "offer_response", label: "Reply",
  owner: "sid", status: "prepared", preparedDetails: null, executionBoundary: "owner_only",
  deadline: { date: null, instant: "2026-11-01T05:30:00.000Z", timeZone: "America/Toronto", verification },
  sourceTurnId: id, updatedAt: now.toISOString(), university: "Test University", programName: "Computing",
};
const input: CalendarFeedInput = { now, actions: [action], deadlines: [deadline], applications: [application], workflows: [workflow] };
const unfold = (value: string) => value.replace(/\r\n /gu, "");

describe("the private calendar composer", () => {
  it("serializes saved dates and alarm lead times without shifting all-day dates or UTC instants", () => {
    const feed = unfold(composeCalendarFeed(input));
    expect(feed.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(feed.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(feed.match(/BEGIN:VEVENT/gu)).toHaveLength(4);
    expect(feed).toContain("DTSTAMP:20260923T123456Z\r\n");
    expect(feed).toContain("DTSTART;VALUE=DATE:20260923\r\nSUMMARY:Chemistry: Finish the lab (25 min)");
    expect(feed).toContain("DTSTART:20261101T063000Z\r\nSUMMARY:Physics: Unit test");
    expect(feed).toContain("BEGIN:VALARM\r\nTRIGGER:-PT90M\r\nACTION:DISPLAY\r\nDESCRIPTION:Physics: Unit test\r\nEND:VALARM");
    expect(feed).toContain("DTSTART;VALUE=DATE:20270115\r\nSUMMARY:[unverified] Test University / Computing: Essay");
    expect(feed).toContain("DTSTART:20261101T053000Z\r\nSUMMARY:[unverified] Test University / Computing: Reply");
    expect(feed).not.toContain("DTEND");
  });

  it("keeps namespaced row identities stable when titles dates and workflow revisions change", () => {
    const uids = (value: string) => unfold(value).split("\r\n").filter((line) => line.startsWith("UID:"));
    const before = uids(composeCalendarFeed(input));
    const after = uids(composeCalendarFeed({ ...input,
      actions: [{ ...action, text: "Changed", localDate: "2026-09-24" }],
      deadlines: [{ ...deadline, title: "Changed", dueAt: "2026-11-02T06:30:00.000Z" }],
      applications: [{ ...application, label: "Changed" }],
      workflows: [{ ...workflow, eventId: newUlid(now), revision: 2 }],
    }));
    expect(after).toEqual(before);
    expect(new Set(before).size).toBe(4);
    expect(before).toEqual([`UID:catchup-${id}@jarvis`, `UID:deadline-${id}@jarvis`, `UID:application-${id}@jarvis`, `UID:workflow-${id}@jarvis`]);
  });

  it("omits undated university items and preserves verified date-only workflow labels", () => {
    const feed = unfold(composeCalendarFeed({ ...input, actions: [], deadlines: [],
      applications: [{ ...application, dueDate: null }],
      workflows: [
        { ...workflow, deadline: { ...workflow.deadline, instant: null } },
        { ...workflow, deadline: { date: "2027-02-03", instant: null, timeZone: null,
          verification: { ...verification, state: "verified" } } },
      ],
    }));
    expect(feed.match(/BEGIN:VEVENT/gu)).toHaveLength(1);
    expect(feed).toContain("DTSTART;VALUE=DATE:20270203\r\nSUMMARY:[verified] Test University / Computing: Reply");
    const verifiedApplication = unfold(composeCalendarFeed({ ...input, applications: [{ ...application,
      verification: { ...verification, state: "verified" } }] }));
    expect(verifiedApplication).toContain("SUMMARY:[verified] Test University / Computing: Essay");
  });

  it("escapes property injection and punctuation in every text-bearing event and alarm field", () => {
    const hostile = "a\\b,c;d\r\nATTACH:https://example.invalid/payload\nEND:VEVENT\rBEGIN:VEVENT";
    const feed = unfold(composeCalendarFeed({ ...input,
      actions: [{ ...action, courseName: hostile, text: hostile }],
      deadlines: [{ ...deadline, course: hostile, title: hostile }],
      applications: [{ ...application, university: hostile, programName: hostile, label: hostile }],
      workflows: [{ ...workflow, university: hostile, programName: hostile, label: hostile }],
    }));
    const escaped = "a\\\\b\\,c\\;d\\nATTACH:https://example.invalid/payload\\nEND:VEVENT\\nBEGIN:VEVENT";
    expect(feed).toContain(`SUMMARY:${escaped}: ${escaped} (25 min)`);
    expect(feed).toContain(`SUMMARY:${escaped}: ${escaped}\r\nBEGIN:VALARM`);
    expect(feed).toContain(`DESCRIPTION:${escaped}: ${escaped}\r\nEND:VALARM`);
    expect(feed.split("\r\n").filter((line) => line.startsWith("SUMMARY:[unverified]")))
      .toEqual(Array(2).fill(`SUMMARY:[unverified] ${escaped} / ${escaped}: ${escaped}`));
    expect(feed.split("\r\n").filter((line) => line === "BEGIN:VEVENT")).toHaveLength(4);
    expect(feed).not.toMatch(/\r\nATTACH:/u);
  });

  it("strips controls including bidi overrides without dropping printable Unicode", () => {
    const feed = composeCalendarFeed({ ...input, actions: [{ ...action, text: "é\u0000\t\u007f\u0085\u202e🙂" }] });
    expect(unfold(feed)).toContain("SUMMARY:Chemistry: é🙂 (25 min)");
    expect(feed.replace(/\r\n/gu, "")).not.toMatch(/\p{C}/u);
  });

  it("folds at 75 UTF-8 octets including continuation spaces without splitting code points", () => {
    const feed = composeCalendarFeed({ ...input, actions: [{ ...action, text: "é🙂".repeat(100) }] });
    const lines = feed.split("\r\n");
    expect(lines.some((line) => line.startsWith(" "))).toBe(true);
    expect(lines.every((line) => new TextEncoder().encode(line).byteLength <= 75)).toBe(true);
    expect(lines.every((line) => line.isWellFormed())).toBe(true);
    expect(unfold(feed)).toContain(`SUMMARY:Chemistry: ${"é🙂".repeat(100)} (25 min)`);
    const exact = composeCalendarFeed({ ...input, actions: [{ ...action, courseName: "A", text: "x".repeat(55) }] });
    expect(exact.split("\r\n")).toContain(`SUMMARY:A: ${"x".repeat(55)} (25 min)`);
  });
});
