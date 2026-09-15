// Reviewer probe (PR #51 M1/S1): passes when past-due items fill the 180 cap ahead of upcoming ones.
import { describe, expect, it } from "vitest";
import { selectBrightspaceWindow } from "../../src/jobs/job-table.js";

describe("zzreviewerpr51", () => {
  it("S1 past-due items fill the 180 cap ahead of upcoming ones", () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const hour = 3_600_000;
    const past = Array.from({ length: 70 }, (_, i) => ({ externalId: `past-${i}`, course: "C", title: `Past ${i}`, dueAt: new Date(now.getTime() - (i + 1) * hour).toISOString() }));
    const future = Array.from({ length: 250 }, (_, i) => ({ externalId: `future-${i}`, course: "C", title: `Future ${i}`, dueAt: new Date(now.getTime() + (i + 1) * hour).toISOString() }));
    const selected = selectBrightspaceWindow({ items: [...future, ...past], cancelled: [], rejected: 0 }, now);
    const keptPast = selected.items.filter((item) => item.externalId.startsWith("past-")).length;
    const keptFuture = selected.items.length - keptPast;
    console.log(`S1 REPORT keptPast=${keptPast} keptFuture=${keptFuture} truncated=${selected.truncatedCount}`);
    expect(keptPast).toBe(70);
    expect(keptFuture).toBe(110);
  });
});
