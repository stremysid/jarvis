import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DeadlineProofError, proveDeadlineDue } from "../../src/deadlines/deadline-date-proof.js";
import { recordDeadline } from "../../src/deadlines/deadline-tool.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { resetDeadlineTables } from "./deadline-fixture.js";

const ownerZone = "America/Toronto";
const messageAt = "2026-09-23T14:00:00.000Z";
const dueAt = "2026-09-25T19:00:00.000Z";
const dueExcerpt = "Friday at 3pm";
const rows = async () => (await env.DB.prepare("SELECT course, title, due_at FROM deadlines").all()).results;

const prove = (phrase: string, resolved: string, receivedAt: string) => proveDeadlineDue({
  ownerZone, messageAt: receivedAt, dueExcerpt: phrase, dueAt: resolved,
});

const record = (message: string, course: string, title: string) => recordDeadline(env.DB,
  { userText: message, principalId: "principal:deadline-round-four" } as ModelAdapterStreamInput,
  { id: "round-four", name: "deadline_record", arguments: JSON.stringify({
    course, title, dueExcerpt, dueAt, effort: "other", evidenceExcerpt: message,
  }) }, new Date(messageAt), { ownerZone, messageAt });

function refusedProof(run: () => unknown): DeadlineProofError {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(DeadlineProofError);
  return error as DeadlineProofError;
}

describe("deadline review round four", () => {
  beforeEach(resetDeadlineTables);

  it("accepts tomorrow at 3pm when sent at 10:00", () => {
    expect(prove("tomorrow at 3pm", "2026-09-24T19:00:00.000Z", "2026-09-23T14:00:00.000Z"))
      .toMatchObject({ dueAt: "2026-09-24T19:00:00.000Z", dateOnly: false });
  });

  it("accepts tomorrow at 11:59pm when sent at 20:00", () => {
    expect(prove("tomorrow at 11:59pm", "2026-09-25T03:59:00.000Z", "2026-09-24T00:00:00.000Z"))
      .toMatchObject({ dueAt: "2026-09-25T03:59:00.000Z", dateOnly: false });
  });

  it.each([
    ["today", "2026-09-23", "2026-09-24T03:59:59.999Z"],
    ["tomorrow", "2026-09-24", "2026-09-25T03:59:59.999Z"],
  ])("uses the calendar date for date-only %s while the small-hours window is unset", (phrase, resolved, stored) => {
    expect(prove(phrase, resolved, messageAt)).toMatchObject({ dueAt: stored, dateOnly: true });
  });

  it("asks which date tonight at 00:30 means when sent at 22:00", () => {
    const error = refusedProof(() => prove("tonight at 00:30", "2026-09-24T04:30:00.000Z",
      "2026-09-24T02:00:00.000Z"));
    expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
    expect(error.detail).toContain("2026-09-23");
    expect(error.detail).toContain("2026-09-24");
  });

  it.each([
    ["a filler-only comma between the course and title", "For Chem, the lab report is due Friday at 3pm", "Chem", "lab report"],
    ["a filler-only comma between the title and due phrase", "Chem lab report, due Friday at 3pm", "Chem", "lab report"],
    ["filler words around commas before the due phrase", "So my chem lab report is due, um, Friday at 3pm", "Chem", "lab report"],
    ["and inside an assignment title", "English Pride and Prejudice essay due Friday at 3pm", "English", "Pride and Prejudice essay"],
    ["an ordinal inside an assignment title", "English 1st draft due Friday at 3pm", "English", "1st draft"],
    ["a weekday inside an assignment title", "Bio Monday lab writeup due Friday at 3pm", "Bio", "Monday lab writeup"],
    ["punctuation inside an assignment title", "History Sun Yat-sen essay due Friday at 3pm", "History", "Sun Yat-sen essay"],
    ["a comma alone between the course and title", "French, oral presentation Friday at 3pm", "French", "oral presentation"],
    ["and with only filler words before the due phrase", "Chem lab report is due and on Friday at 3pm", "Chem", "lab report"],
  ])("accepts %s", async (_label, message, course, title) => {
    const result = await record(message, course, title);
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course, title, due_at: dueAt }]);
  });
});
