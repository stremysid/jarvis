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

const record = (message: string, course: string, title: string) => recordDeadline(env.DB,
  { userText: message, principalId: "principal:deadline-round-seven" } as ModelAdapterStreamInput,
  { id: "round-seven", name: "deadline_record", arguments: JSON.stringify({
    course, title, dueExcerpt: fridayDueExcerpt, dueAt: fridayDueAt,
    effort: "other", evidenceExcerpt: message,
  }) }, new Date(messageAt), { ownerZone, messageAt });

const prove = (dueExcerpt: string, dueAt: string, receivedAt: string) => proveDeadlineDue({
  ownerZone, messageAt: receivedAt, dueExcerpt, dueAt,
});

function refusedProof(run: () => unknown): DeadlineProofError {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(DeadlineProofError);
  return error as DeadlineProofError;
}

describe("deadline review round seven", () => {
  beforeEach(resetDeadlineTables);

  it.each([
    ["a hyphen", "Math quiz - English essay due Friday at 3pm"],
    ["an en dash", "Math quiz – English essay due Friday at 3pm"],
    ["an em dash", "Math quiz — English essay due Friday at 3pm"],
    ["a pipe", "Math quiz | English essay due Friday at 3pm"],
    ["a bullet", "Math quiz • English essay due Friday at 3pm"],
    ["a colon", "Math quiz : English essay due Friday at 3pm"],
    ["an ellipsis", "Math quiz … English essay due Friday at 3pm"],
    ["parentheses", "Math quiz (English essay due Friday at 3pm)"],
    ["a Unicode line separator", "Math quiz\u2028English essay due Friday at 3pm"],
    ["a vertical tab", "Math quiz\vEnglish essay due Friday at 3pm"],
    ["a form feed", "Math quiz\fEnglish essay due Friday at 3pm"],
    ["a Unicode paragraph separator", "Math quiz\u2029English essay due Friday at 3pm"],
    ["a bare carriage return", "Math quiz\rEnglish essay due Friday at 3pm"],
  ])("refuses %s from tying Math quiz to the essay's due phrase", async (_label, message) => {
    const result = await record(message, "Math", "quiz");
    expect(result.providerResult.content).toContain("deadline_ambiguous_date");
    expect(await rows()).toEqual([]);
  });

  it.each([
    ["a colon and line break", "Chem:\nlab report due Friday at 3pm"],
    ["a filler-only hyphen", "Chem - lab report due Friday at 3pm"],
  ])("accepts %s between the course and title", async (_label, message) => {
    const result = await record(message, "Chem", "lab report");
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course: "Chem", title: "lab report", due_at: fridayDueAt }]);
  });

  it.each([
    ["Q&A worksheet", "Math Q&A worksheet due Friday at 3pm"],
    ["A/B testing lab", "Math A/B testing lab due Friday at 3pm"],
    ["Romeo and Juliet essay", "English Romeo and Juliet essay due Friday at 3pm"],
  ])("accepts the complete title %s", async (title, message) => {
    const course = title === "Romeo and Juliet essay" ? "English" : "Math";
    const result = await record(message, course, title);
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course, title, due_at: fridayDueAt }]);
  });

  it("accepts an unpunctuated unit number between the course and title", async () => {
    const message = "Math unit 3 quiz due Friday at 3pm";
    const result = await record(message, "Math", "quiz");
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course: "Math", title: "quiz", due_at: fridayDueAt }]);
  });

  it("accepts an apostrophe-only gap containing a content word between the course and title", async () => {
    const message = "Math Mr O’Brien’s quiz due Friday at 3pm";
    const result = await record(message, "Math", "quiz");
    expect(JSON.parse(result.providerResult.content)).toMatchObject({ status: "completed" });
    expect(await rows()).toMatchObject([{ course: "Math", title: "quiz", due_at: fridayDueAt }]);
  });

  it.each([
    ["tonight at 12pm", "2026-09-23T16:00:00.000Z"],
    ["tonight at 12 p.m.", "2026-09-23T16:00:00.000Z"],
    ["tonight at 12:30pm", "2026-09-23T16:30:00.000Z"],
  ])("asks which date %s means when sent at 09:00", (dueExcerpt, dueAt) => {
    const error = refusedProof(() => prove(dueExcerpt, dueAt, "2026-09-23T13:00:00.000Z"));
    expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
    expect(error.detail).toContain("2026-09-23");
    expect(error.detail).toContain("2026-09-24");
  });

  it.each([
    ["tonight at 12pm", "2026-09-23T16:00:00.000Z"],
    ["tonight at 12 p.m.", "2026-09-23T16:00:00.000Z"],
    ["tonight at 12:30pm", "2026-09-23T16:30:00.000Z"],
  ])("asks which date %s means when sent at 22:00", (dueExcerpt, dueAt) => {
    const error = refusedProof(() => prove(dueExcerpt, dueAt, "2026-09-24T02:00:00.000Z"));
    expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
    expect(error.detail).toContain("2026-09-23");
    expect(error.detail).toContain("2026-09-24");
  });

  it("keeps 12pm without tonight as noon on the message date", () => {
    expect(prove("12pm", "2026-09-23T16:00:00.000Z", "2026-09-23T13:00:00.000Z"))
      .toMatchObject({ dueAt: "2026-09-23T16:00:00.000Z", dateOnly: false });
  });
});
