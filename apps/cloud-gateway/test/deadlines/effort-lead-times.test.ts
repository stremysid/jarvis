import { describe, expect, it } from "vitest";
import { DEFAULT_LEAD_MINUTES } from "../../src/deadlines/effort-lead-times.js";
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
});
