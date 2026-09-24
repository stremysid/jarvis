import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DeadlineProofError, proveDeadlineDue } from "../../src/deadlines/deadline-date-proof.js";
import { recordDeadline } from "../../src/deadlines/deadline-tool.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { resetDeadlineTables } from "./deadline-fixture.js";

const ownerZone = "America/Toronto";
const messageAt = "2026-09-23T14:00:00.000Z";
const prove = (dueExcerpt: string, dueAt: string, changes = {}) => proveDeadlineDue({
  ownerZone, messageAt, dueExcerpt, dueAt, ...changes,
});
const rows = async () => (await env.DB.prepare("SELECT * FROM deadlines").all()).results;
const record = (message: string, course: string, title: string, dueExcerpt: string) => recordDeadline(env.DB,
  { userText: message, principalId: "principal:deadline-round-three" } as ModelAdapterStreamInput,
  { id: "round-three", name: "deadline_record", arguments: JSON.stringify({
    course, title, dueExcerpt, dueAt: "2026-10-02T13:00:00.000Z", effort: "quiz", evidenceExcerpt: message,
  }) }, new Date(messageAt), { ownerZone, messageAt });

function refusedProof(run: () => unknown): DeadlineProofError {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(DeadlineProofError);
  return error as DeadlineProofError;
}

describe("deadline review round three", () => {
  beforeEach(resetDeadlineTables);

  it("resolves this Wednesday on Sunday to the next Wednesday", () => {
    expect(prove("this Wednesday at 3pm", "2026-09-30T19:00:00.000Z",
      { messageAt: "2026-09-27T16:00:00.000Z" }).dueAt).toBe("2026-09-30T19:00:00.000Z");
  });

  it("resolves this Monday on Thursday to the next Monday", () => {
    expect(prove("this Monday at 3pm", "2026-09-28T19:00:00.000Z",
      { messageAt: "2026-09-24T14:00:00.000Z" }).dueAt).toBe("2026-09-28T19:00:00.000Z");
  });

  it("resolves this Friday on Saturday to the next Friday", () => {
    expect(prove("this Friday at 3pm", "2026-10-02T19:00:00.000Z",
      { messageAt: "2026-09-26T14:00:00.000Z" }).dueAt).toBe("2026-10-02T19:00:00.000Z");
  });

  it("refuses a comma-separated date from tying Chem to the later Physics quiz", async () => {
    const result = await record("Chem lab report due Friday, Physics quiz October 2, 2026 at 9:00 am",
      "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_course_not_tied_to_assignment");
    expect(await rows()).toEqual([]);
  });

  it("refuses an and-separated date from tying Chem to the later Physics quiz", async () => {
    const result = await record("Chem lab is due Friday and the Physics quiz is October 2, 2026 at 9:00 am",
      "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_course_not_tied_to_assignment");
    expect(await rows()).toEqual([]);
  });

  it("refuses another date and clock between the title and its proposed due phrase", async () => {
    const result = await record("Chem quiz Friday at 3pm, and Chem essay October 2, 2026 at 9:00 am",
      "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_ambiguous_date");
    expect(await rows()).toEqual([]);
  });

  it("refuses an intervening date without relying on a clause separator", async () => {
    const result = await record("Chem lab report due Friday Physics quiz October 2, 2026 at 9:00 am",
      "Chem", "lab report", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_ambiguous_date");
    expect(await rows()).toEqual([]);
  });

  it("refuses an intervening clock without relying on a clause separator", async () => {
    const result = await record("Chem quiz at 3pm Physics essay October 2, 2026 at 9:00 am",
      "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_ambiguous_date");
    expect(await rows()).toEqual([]);
  });

  it("refuses a comma-separated assignment without relying on another date or clock", async () => {
    const result = await record("Chem quiz, Physics quiz October 2, 2026 at 9:00 am",
      "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_ambiguous_date");
    expect(await rows()).toEqual([]);
  });

  it("refuses an and-separated assignment without relying on another date or clock", async () => {
    const result = await record("Chem quiz and Physics quiz October 2, 2026 at 9:00 am",
      "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_ambiguous_date");
    expect(await rows()).toEqual([]);
  });

  it("refuses a title from the previous sentence even when the course shares the due sentence", async () => {
    const result = await record("Physics quiz. Chem due October 2, 2026 at 9:00 am",
      "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_ambiguous_date");
    expect(await rows()).toEqual([]);
  });

  it("uses the next calendar date for tomorrow while the small-hours window is unset", () => {
    expect(prove("tomorrow at 9am", "2026-09-24T13:00:00.000Z",
      { messageAt: "2026-09-23T04:30:00.000Z" })).toMatchObject({
      dueAt: "2026-09-24T13:00:00.000Z", dateOnly: false,
    });
  });

  it.each([
    ["tonight at 12am", "2026-09-24T04:00:00.000Z"],
    ["tonight at 1am", "2026-09-24T05:00:00.000Z"],
  ])("asks which date %s means after the message date's evening", (dueExcerpt, dueAt) => {
    const error = refusedProof(() => prove(dueExcerpt, dueAt, { messageAt: "2026-09-24T02:00:00.000Z" }));
    expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
    expect(error.detail).toContain("2026-09-23");
    expect(error.detail).toContain("2026-09-24");
  });

  it("refuses today's clock after that clock has passed", () => {
    const error = refusedProof(() => prove("today at 9am", "2026-09-23T13:00:00.000Z"));
    expect(error).toMatchObject({ reason: "deadline_time_already_passed" });
  });

  it("reports a repeated clock as ambiguous while its second occurrence is still ahead", () => {
    const error = refusedProof(() => prove("1:30am", "2026-11-01T01:30:00-05:00",
      { messageAt: "2026-11-01T06:00:00.000Z" }));
    expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
  });
});
