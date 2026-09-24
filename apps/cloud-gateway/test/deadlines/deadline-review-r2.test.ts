import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DeadlineProofError, proveDeadlineDue } from "../../src/deadlines/deadline-date-proof.js";
import { recordDeadline } from "../../src/deadlines/deadline-tool.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { resetDeadlineTables } from "./deadline-fixture.js";

const messageAt = "2026-09-23T14:00:00.000Z";
const context = { messageAt, ownerZone: "America/Toronto" };
const prove = (dueExcerpt: string, dueAt: string, changes = {}) => proveDeadlineDue({ ...context, dueExcerpt, dueAt, ...changes });
const rows = async () => (await env.DB.prepare("SELECT * FROM deadlines").all()).results;
const record = (message: string, course: string, title: string, dueExcerpt: string, dueAt = "2026-10-02T13:00:00.000Z") => recordDeadline(env.DB,
  { userText: message, principalId: "principal:deadline-round-two" } as ModelAdapterStreamInput,
  { id: "round-two", name: "deadline_record", arguments: JSON.stringify({ course, title, dueExcerpt, dueAt, effort: "quiz", evidenceExcerpt: message }) },
  new Date(messageAt), context);

describe("deadline review round two", () => {
  beforeEach(resetDeadlineTables);

  it.each(["3pm", "at 3pm", "tonight at 11:59pm"])("proves the bare clock %s on the message's local date", (phrase) => {
    const dueAt = phrase.startsWith("tonight") ? "2026-09-24T03:59:00.000Z" : "2026-09-23T19:00:00.000Z";
    expect(prove(phrase, dueAt)).toMatchObject({ dueAt, dateOnly: false });
  });

  it("anchors a bare clock to the owner date even when UTC and processing dates differ", () => {
    expect(prove("tonight at 11:59pm", "2026-09-24T06:59:00.000Z",
      { messageAt: "2026-09-24T05:00:00.000Z", ownerZone: "America/Vancouver" }).dueAt).toBe("2026-09-24T06:59:00.000Z");
  });

  it.each(["2026-09-23T19:00:00.000Z", "2026-09-24T19:00:00.000Z"])("refuses a passed bare clock instead of silently storing %s", (dueAt) => {
    expect(() => prove("3pm", dueAt, { messageAt: "2026-09-24T00:00:00.000Z" })).toThrow("deadline_time_already_passed");
  });

  it("refuses a model's tomorrow resolution for a bare clock that still lies ahead today", () => {
    expect(() => prove("3pm", "2026-09-24T19:00:00.000Z")).toThrow("deadline_resolved_date_mismatch");
  });

  it("records a bare clock through the deadline tool with the actual local due time", async () => {
    const result = await record("Chem lab due 3pm", "Chem", "lab", "3pm", "2026-09-23T19:00:00.000Z");
    expect(await rows()).toMatchObject([{ due_at: "2026-09-23T19:00:00.000Z" }]);
    expect(result.receipt).toContain("3:00");
  });

  it.each(["2026-09-25T19:00:00.000Z", "2026-10-02T19:00:00.000Z"])("asks which supported Friday was meant instead of accepting %s by convention", (dueAt) => {
    let error: unknown;
    try { prove("next Friday at 3pm", dueAt); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DeadlineProofError);
    expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
    expect((error as DeadlineProofError).detail).toContain("2026-09-25");
    expect((error as DeadlineProofError).detail).toContain("2026-10-02");
  });

  it.each(["2026-09-25T12:00:00.000Z", "2026-09-26T00:00:00.000Z"])("asks about today or next week for a bare same-day weekday sent at %s", (at) => {
    let error: unknown;
    try { prove("Friday at 3pm", "2026-09-25T19:00:00.000Z", { messageAt: at }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ reason: "deadline_ambiguous_date" });
    expect((error as DeadlineProofError).detail).toContain("2026-09-25");
    expect((error as DeadlineProofError).detail).toContain("2026-10-02");
  });

  it("refuses an already-passed clock even when this Friday names the current day", () => {
    expect(() => prove("this Friday at 3pm", "2026-09-25T19:00:00.000Z", { messageAt: "2026-09-26T00:00:00.000Z" }))
      .toThrow("deadline_time_already_passed");
  });

  it("preserves an explicitly stated historical date instead of treating it as an implicit today", () => {
    expect(prove("2020-09-23 at 3pm", "2020-09-23T19:00:00.000Z")).toMatchObject({ dueAt: "2020-09-23T19:00:00.000Z", dateOnly: false });
  });

  it("does not place the Physics quiz under the Chem course in the previous sentence", async () => {
    const result = await record("Chem due September 25, 2026. Physics quiz October 2, 2026 at 9:00 am",
      "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_course_not_tied_to_assignment");
    expect(await rows()).toEqual([]);
  });

  it("refuses a course appearing only after the due phrase", async () => {
    const result = await record("quiz October 2, 2026 at 9:00 am for Chem", "Chem", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_course_not_tied_to_assignment");
    expect(await rows()).toEqual([]);
  });

  it("asks which course is meant instead of silently merging Chem into Chemistry", async () => {
    await record("Chem quiz October 2, 2026 at 9:00 am", "Chem", "quiz", "October 2, 2026 at 9:00 am");
    const result = await record("Chemistry quiz October 2, 2026 at 9:00 am", "Chemistry", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_ambiguous_match");
    expect(await rows()).toHaveLength(1);
  });

  it("requires the stated course spelling instead of inventing the Chemistry expansion", async () => {
    const result = await record("Chem quiz October 2, 2026 at 9:00 am", "Chemistry", "quiz", "October 2, 2026 at 9:00 am");
    expect(result.providerResult.content).toContain("deadline_fields_not_in_evidence");
    expect(await rows()).toEqual([]);
  });
});
