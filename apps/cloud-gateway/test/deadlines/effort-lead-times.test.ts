import { describe, expect, it } from "vitest";
import { DEFAULT_LEAD_MINUTES, leadMinutesForWrite } from "../../src/deadlines/effort-lead-times.js";
import type { DeadlineEffort } from "../../src/deadlines/deadline-types.js";

const EFFORTS: readonly DeadlineEffort[] = ["quiz", "test", "exam", "essay", "project", "other"];

describe("default lead times", () => {
  it("covers every stored effort, so no deadline can be left without a default", () => {
    expect([...Object.keys(DEFAULT_LEAD_MINUTES)].sort()).toEqual([...EFFORTS].sort());
  });

  it("gives an unknown item more warning than a quiz and less than a test", () => {
    expect(DEFAULT_LEAD_MINUTES.other).toBeGreaterThan(DEFAULT_LEAD_MINUTES.quiz);
    expect(DEFAULT_LEAD_MINUTES.other).toBeLessThan(DEFAULT_LEAD_MINUTES.test);
  });

  it("takes a named lead over everything else", () => {
    expect(leadMinutesForWrite(45, { effort: "exam", leadMinutes: 10_080 }, "project")).toBe(45);
  });

  it("keeps the stored lead when no lead is named and the effort has not changed", () => {
    // The stored lead is a setting the model chose, not a per-call default.
    expect(leadMinutesForWrite(null, { effort: "exam", leadMinutes: 45 }, "exam")).toBe(45);
  });

  it("falls back to the new effort's default when the kind of work changes", () => {
    expect(leadMinutesForWrite(null, { effort: "exam", leadMinutes: 45 }, "quiz")).toBe(DEFAULT_LEAD_MINUTES.quiz);
  });

  it("uses the effort's default when nothing is stored yet", () => {
    expect(leadMinutesForWrite(null, null, "essay")).toBe(DEFAULT_LEAD_MINUTES.essay);
  });
});
