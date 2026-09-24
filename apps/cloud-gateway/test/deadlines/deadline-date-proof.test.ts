import { describe, expect, it } from "vitest";
import { proveDeadlineDue } from "../../src/deadlines/deadline-date-proof.js";

const context = { ownerZone: "America/Toronto", messageAt: "2026-09-23T14:00:00.000Z" };
const proof = (dueExcerpt: string, dueAt: string, changes = {}) => proveDeadlineDue({ ...context, dueExcerpt, dueAt, ...changes });

describe("proof of a deadline due phrase", () => {
  it.each([
    ["Friday at 11:59pm", "2026-09-26T03:59:00.000Z"],
    ["tomorrow at 3pm", "2026-09-24T19:00:00.000Z"],
    ["today at 3:30 p.m.", "2026-09-23T19:30:00.000Z"],
    ["Sept 25 at 3pm", "2026-09-25T19:00:00.000Z"],
    ["25th at 3pm", "2026-09-25T19:00:00.000Z"],
    ["25 September at 15:30", "2026-09-25T19:30:00.000Z"],
    ["September 25, 2026 at 12pm", "2026-09-25T16:00:00.000Z"],
    ["2026-09-25 12am", "2026-09-25T04:00:00.000Z"],
    ["this Friday at 3pm", "2026-09-25T19:00:00.000Z"],
    ["next week on Monday at 3pm", "2026-09-28T19:00:00.000Z"],
  ])("proves the complete due expression %s against the message timestamp", (phrase, instant) => {
    expect(proof(phrase!, instant!)).toMatchObject({ dueAt: instant, dateOnly: false });
  });

  it("refuses a resolved date that disagrees with the relative expression", () => {
    expect(() => proof("tomorrow at 3pm", "2026-09-25T19:00:00.000Z")).toThrow("deadline_resolved_date_mismatch");
  });
  it("uses the owner's local date when UTC is already the following day", () => {
    expect(proof("tomorrow at 3pm", "2026-09-23T19:00:00.000Z", { messageAt: "2026-09-23T02:00:00Z" }).dueAt)
      .toBe("2026-09-23T19:00:00.000Z");
  });
  it("rolls a missing year to the next occurrence at the year boundary", () => {
    expect(proof("Jan 2 at 3pm", "2027-01-02T20:00:00.000Z", { messageAt: "2026-12-31T18:00:00Z" }).dueAt)
      .toBe("2027-01-02T20:00:00.000Z");
  });
  it("skips a short month when resolving the next stated ordinal day", () => {
    expect(proof("31st at 3pm", "2026-10-31T19:00:00.000Z").dueAt).toBe("2026-10-31T19:00:00.000Z");
  });
  it.each(["2026-02-30 at 3pm", "32nd at 3pm", "February 29, 2026 at 3pm"])("refuses the nonexistent calendar date %s", (phrase) => {
    expect(() => proof(phrase, "2026-03-02T20:00:00.000Z")).toThrow("deadline_ambiguous_date");
  });
  it.each(["Friday at 13pm", "Friday at 0am", "Friday at 25:00", "Friday at 3:60pm"])("refuses the invalid clock in %s", (phrase) => {
    expect(() => proof(phrase, "2026-09-25T19:00:00.000Z")).toThrow("deadline_invalid_time");
  });
  it("stores an ambiguous clock as date-only without choosing am or pm", () => {
    expect(proof("Friday at 3:30", "2026-09-25")).toMatchObject({ dateOnly: true, dueAt: "2026-09-26T03:59:59.999Z",
      note: "date-only: the clock was ambiguous without am/pm" });
  });
  it.each(["2026-11-01 01:30", "2026-03-08 02:30"])("stores the ambiguous daylight saving clock %s as date-only", (phrase) => {
    const result = proof(phrase, phrase.slice(0, 10));
    expect(result.dateOnly).toBe(true);
    expect(result.note).toContain("repeated or nonexistent");
    expect(result.dueAt).toBe(phrase.startsWith("2026-11") ? "2026-11-02T04:59:59.999Z" : "2026-03-09T03:59:59.999Z");
  });
  it("stores a week without a day as an explicitly unconfirmed date-only bound", () => {
    expect(proof("next week", "2026-10-04")).toMatchObject({ dateOnly: true, dueAt: "2026-10-05T03:59:59.999Z",
      note: "unconfirmed date-only bound: end of next week; the exact day was not stated" });
  });
  it("refuses an invented clock when the due phrase only proves a date", () => {
    expect(() => proof("Friday", "2026-09-25T19:00:00.000Z")).toThrow("deadline_missing_time");
  });
  it("refuses an absent durable timestamp instead of anchoring to the runtime clock", () => {
    expect(() => proof("Friday at 3pm", "2026-09-25T19:00:00.000Z", { messageAt: "unknown" })).toThrow("deadline_message_time_missing");
  });
  it("refuses a due excerpt containing separate date and clock sentences", () => {
    expect(() => proof("September 25, 2026. Physics quiz October 2, 2026 at 9:00 am", "2026-09-25T13:00:00.000Z"))
      .toThrow("deadline_ambiguous_date");
  });
  it("refuses an unknown IANA zone before parsing the date", () => {
    expect(() => proof("Friday at 3pm", "2026-09-25T19:00:00.000Z", { ownerZone: "Not/AZone" })).toThrow("deadline_zone_mismatch");
  });
  it("returns a missing date reason when the due phrase only names a zone", () => {
    expect(() => proof("America/Toronto", "2026-09-25")).toThrow("deadline_missing_date");
  });
  it("refuses an offsetless resolved instant even when its wall clock matches", () => {
    expect(() => proof("Friday at 3pm", "2026-09-25T15:00:00")).toThrow("deadline_invalid_time");
  });
  it("refuses an end of day on a local date removed by a zone transition", () => {
    expect(() => proof("2011-12-30", "2011-12-30", { ownerZone: "Pacific/Apia" })).toThrow("deadline_ambiguous_date");
  });
  it("requires an ambiguous clock to remain date-only even when an offset could choose a side", () => {
    expect(() => proof("2026-11-01 01:30", "2026-11-01T01:30:00-05:00")).toThrow("deadline_ambiguous_date");
  });
});
