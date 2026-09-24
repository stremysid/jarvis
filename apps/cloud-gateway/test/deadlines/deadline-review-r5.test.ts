import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DeadlineProofError, proveDeadlineDue } from "../../src/deadlines/deadline-date-proof.js";
import { recordDeadline } from "../../src/deadlines/deadline-tool.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { resetDeadlineTables } from "./deadline-fixture.js";

const ownerZone = "America/Toronto";
const messageAt = "2026-09-23T14:00:00.000Z";
const fridayDueAt = "2026-09-25T19:00:00.000Z";
const fridayDueExcerpt = "Friday at 3pm";
const rows = async () => (await env.DB.prepare("SELECT course, title, due_at FROM deadlines").all()).results;

const record = (message: string, course: string, title: string,
  dueExcerpt = fridayDueExcerpt, dueAt = fridayDueAt) => recordDeadline(env.DB,
  { userText: message, principalId: "principal:deadline-round-five" } as ModelAdapterStreamInput,
  { id: "round-five", name: "deadline_record", arguments: JSON.stringify({
    course, title, dueExcerpt, dueAt, effort: "other", evidenceExcerpt: message,
  }) }, new Date(messageAt), { ownerZone, messageAt });

const prove = (dueExcerpt: string, dueAt: string, receivedAt: string,
  smallHoursEndHour?: number | null) => proveDeadlineDue({
  ownerZone, messageAt: receivedAt, dueExcerpt, dueAt,
}, smallHoursEndHour);

function refusedProof(run: () => unknown): DeadlineProofError {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(DeadlineProofError);
  return error as DeadlineProofError;
}

describe("deadline review round five", () => {
  beforeEach(resetDeadlineTables);

  it.each([
    ["a line break", "Math quiz\nEnglish essay due Friday at 3pm"],
    ["a line break and list marker", "Math quiz\n- English essay due Friday at 3pm"],
    ["an ampersand", "Math quiz & English essay due Friday at 3pm"],
    ["a plus sign", "Math quiz + English essay due Friday at 3pm"],
    ["a slash", "Math quiz / English essay due Friday at 3pm"],
    ["then", "Math quiz then English essay due Friday at 3pm"],
    ["or", "Math quiz or English essay due Friday at 3pm"],
    ["plus", "Math quiz plus English essay due Friday at 3pm"],
    ["also", "Math quiz also English essay due Friday at 3pm"],
  ])("refuses %s from tying Math quiz to the essay's due phrase", async (_label, message) => {
    const result = await record(message, "Math", "quiz");
    expect(result.providerResult.content).toContain("deadline_ambiguous_date");
    expect(await rows()).toEqual([]);
  });

  it("accepts a line break after course punctuation when it does not cross assignments", async () => {
    const message = "Chem:\nlab report due Friday at 3pm";
    const result = await record(message, "Chem", "lab report");
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course: "Chem", title: "lab report", due_at: fridayDueAt }]);
  });

  it.each(["12:00", "12:30"])("asks which date tonight at %s means at both 09:00 and 22:00", (clock) => {
    const minute = clock.endsWith(":30") ? "30" : "00";
    for (const receivedAt of ["2026-09-23T13:00:00.000Z", "2026-09-24T02:00:00.000Z"]) {
      const error = refusedProof(() => prove(`tonight at ${clock}`, `2026-09-23T16:${minute}:00.000Z`, receivedAt));
      expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
      expect(error.detail).toContain("2026-09-23");
      expect(error.detail).toContain("2026-09-24");
    }
  });

  it("accepts Math homework, it is due Friday at 3pm", async () => {
    const message = "Math homework, it is due Friday at 3pm";
    const result = await record(message, "Math", "homework");
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course: "Math", title: "homework", due_at: fridayDueAt }]);
  });

  it("accepts Chem lab report, I think it's due Friday at 3pm", async () => {
    const message = "Chem lab report, I think it's due Friday at 3pm";
    const result = await record(message, "Chem", "lab report");
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course: "Chem", title: "lab report", due_at: fridayDueAt }]);
  });

  it.each([
    ["which", "History essay, which is due Friday at 3pm", "History", "essay"],
    ["that", "History essay, that is due Friday at 3pm", "History", "essay"],
    ["that's", "History essay, that's due Friday at 3pm", "History", "essay"],
    ["like", "Art sketch, like, due Friday at 3pm", "Art", "sketch"],
    ["so and just", "Art sketch, so just due Friday at 3pm", "Art", "sketch"],
  ])("accepts %s as filler in a soft-separated gap", async (_label, message, course, title) => {
    const result = await record(message, course, title);
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course, title, due_at: fridayDueAt }]);
  });

  it("accepts a curly apostrophe in that's as filler", async () => {
    const message = "History essay, that’s due Friday at 3pm";
    const result = await record(message, "History", "essay");
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course: "History", title: "essay", due_at: fridayDueAt }]);
  });

  it("accepts at as filler in a soft-separated gap", async () => {
    const message = "Chem lab report, is due at 3pm";
    const result = await record(message, "Chem", "lab report", "3pm", "2026-09-23T19:00:00.000Z");
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{
      course: "Chem", title: "lab report", due_at: "2026-09-23T19:00:00.000Z",
    }]);
  });

  it("refuses a digit as content in a soft-separated course-to-title gap", async () => {
    const message = "Math is at 3, the essay is due Friday at 3pm";
    const result = await record(message, "Math", "essay");
    expect(result.providerResult.content).toContain("deadline_course_not_tied_to_assignment");
    expect(await rows()).toEqual([]);
  });

  it.each([
    ["tomorrow at 9am", "2026-09-24T13:00:00.000Z"],
    ["date-only tomorrow", "2026-09-24"],
    ["date-only today", "2026-09-23"],
  ])("asks which adjacent date %s means at 00:30 when the window ends at 4", (kind, dueAt) => {
    const dueExcerpt = kind === "date-only tomorrow" ? "tomorrow"
      : kind === "date-only today" ? "today" : kind;
    const error = refusedProof(() => prove(dueExcerpt, dueAt, "2026-09-23T04:30:00.000Z", 4));
    expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
  });

  it.each([
    ["tomorrow at 9am", "2026-09-24T13:00:00.000Z", "2026-09-24T13:00:00.000Z", false],
    ["date-only tomorrow", "2026-09-24", "2026-09-25T03:59:59.999Z", true],
    ["date-only today", "2026-09-23", "2026-09-24T03:59:59.999Z", true],
  ] as const)("resolves %s at 04:00 when the window ends at 4", (kind, dueAt, stored, dateOnly) => {
    const dueExcerpt = kind === "date-only tomorrow" ? "tomorrow"
      : kind === "date-only today" ? "today" : kind;
    expect(prove(dueExcerpt, dueAt, "2026-09-23T08:00:00.000Z", 4))
      .toMatchObject({ dueAt: stored, dateOnly });
  });
});
