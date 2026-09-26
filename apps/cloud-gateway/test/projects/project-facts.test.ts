import { describe, expect, it } from "vitest";
import {
  projectFacts,
  readProjectDates,
} from "../../src/projects/project-facts.js";
import { MAX_EXCERPT_CHARACTERS } from "../../src/projects/project-types.js";
import { projectStatus } from "./project-fixture.js";

/**
 * The facts reader has one job left: report what a document said about time
 * and what a repository's commit history says, without deciding what it means.
 *
 * The tests that matter most are the ones about text the reader refuses: an
 * unreadable date must be reported as unreadable, never folded into "no date".
 * The model makes the judgment, and it can only make it from facts that do not
 * hide an omission.
 */

const NOW = "2026-09-01T00:00:00.000Z";

function at(instant: string): () => Date {
  return () => new Date(instant);
}

const STALE_COMMIT = "2026-08-01T00:00:00.000Z";
const FRESH_COMMIT = "2026-08-30T00:00:00.000Z";

describe("readProjectDates", () => {
  it("reads an ISO calendar date", () => {
    const reading = readProjectDates("- Ship the poller by 2026-09-10\n");
    expect(reading.dates).toEqual(["2026-09-10"]);
    expect(reading.unreadable).toEqual([]);
  });

  it("reads the day out of an ISO timestamp", () => {
    const reading = readProjectDates("Due 2026-09-10T09:00:00Z\n");
    expect(reading.dates).toEqual(["2026-09-10"]);
    expect(reading.unreadable).toEqual([]);
  });

  it("keeps every date in the order the document wrote them rather than choosing one", () => {
    // Which date matters -- the earliest, the latest -- is the model's call.
    const reading = readProjectDates("2026-11-01 launch, 2026-09-05 freeze\n");
    expect(reading.dates).toEqual(["2026-11-01", "2026-09-05"]);
  });

  it("deduplicates a repeated day", () => {
    const reading = readProjectDates("by 2026-09-10, again 2026-09-10\n");
    expect(reading.dates).toEqual(["2026-09-10"]);
  });

  it("reports an ambiguous numeric date as unreadable rather than as no date", () => {
    // 03/04/2026 is March 4th in one country and April 3rd in another. Nothing
    // in the document says which, so guessing would be wrong by a month for
    // half its inputs.
    const reading = readProjectDates("- Ship the poller by 03/04/2026\n");
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual(["03/04/2026"]);
  });

  it("reports a month name as unreadable", () => {
    const reading = readProjectDates("- Freeze by Sep 15, launch March 4th\n");
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual(["Sep 15", "March 4th"]);
  });

  it("reports a relative date as unreadable, having no reference date to resolve it against", () => {
    const reading = readProjectDates("- Cut the release next Friday\n- Review EOW\n");
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual(["EOW", "next Friday"]);
  });

  it("reports an ISO-shaped string that is not a real calendar day as unreadable", () => {
    const reading = readProjectDates("Due 2026-02-30 and 2026-13-01\n");
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual(["2026-02-30", "2026-13-01"]);
  });

  it("does not read a version number as a date", () => {
    const reading = readProjectDates("- Bump fflate to 0.8.2, wrangler to 4.127.1\n");
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual([]);
  });

  it("does not read the word maybe as the month of May", () => {
    const reading = readProjectDates("- Maybe 3 more repositories should be tracked\n");
    expect(reading.unreadable).toEqual([]);
  });

  it("says nothing about time when the document says nothing about time", () => {
    const reading = readProjectDates("# Next steps\n- Finish the digest\n- Write the runbook\n");
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual([]);
    expect(reading.truncated).toBe(false);
  });

  it("flattens an unreadable sample to one short line", () => {
    // Untrusted text bound for a model or a digest. Displayed, never interpreted.
    const reading = readProjectDates(`Ship by ${"9".repeat(2)}/${"9".repeat(2)}/2026 \ndone`);
    expect(reading.unreadable).toEqual(["99/99/2026"]);
  });

  it("notes when the excerpt is at its bound and a date may sit past it", () => {
    const reading = readProjectDates("x".repeat(MAX_EXCERPT_CHARACTERS));
    expect(reading.truncated).toBe(true);
  });
});

describe("projectFacts", () => {
  it("reports the commit age as arithmetic and nothing about what it means", () => {
    const status = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "NEXT_STEPS.md": "- Ship the poller by 2026-09-10\n" },
    });

    const [facts] = projectFacts([status], { now: at(NOW) });

    expect(facts.daysSinceLastCommit).toBe(31);
    expect(facts.lastCommitAt).toBe(STALE_COMMIT);
    expect(facts.nextStepsDates).toEqual(["2026-09-10"]);
    // The verdicts the detector used to compute are gone, not merely renamed.
    for (const gone of ["stale", "escalate", "reasons", "blind", "deadline"]) {
      expect(facts).not.toHaveProperty(gone);
    }
  });

  it("returns every project, in trouble or not, so the decision stays with the model", () => {
    const statuses = [
      projectStatus({
        project: { projectId: "project:late", displayName: "Late" },
        lastCommitAt: STALE_COMMIT,
        documents: { "NEXT_STEPS.md": "- Ship by 2026-09-05\n" },
      }),
      projectStatus({
        project: { projectId: "project:calm", displayName: "Calm" },
        lastCommitAt: FRESH_COMMIT,
        documents: { "NEXT_STEPS.md": "- Nothing due\n" },
      }),
    ];

    expect(projectFacts(statuses, { now: at(NOW) }).map((entry) => entry.projectId))
      .toEqual(["project:late", "project:calm"]);
  });

  it("carries a failing poll and its failure text as facts", () => {
    const status = projectStatus({
      lastCommitAt: FRESH_COMMIT,
      documents: { "NEXT_STEPS.md": "- Nothing urgent\n" },
      pollHealth: "failing",
    });

    const [facts] = projectFacts([status], { now: at(NOW) });

    expect(facts.pollHealth).toBe("failing");
    expect(facts.lastFailure).toBe("head:unavailable:500");
  });

  it("says a project was never observed rather than guessing at its age", () => {
    const status = projectStatus({ pollHealth: "never_polled" });

    const [facts] = projectFacts([status], { now: at(NOW) });

    expect(facts.everObserved).toBe(false);
    expect(facts.daysSinceLastCommit).toBeNull();
    expect(facts.nextStepsPresent).toBe(false);
    expect(facts.nextStepsDates).toEqual([]);
  });

  it("says NEXT_STEPS.md is absent and that an excerpt may continue", () => {
    const absent = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "KNOWN_ISSUES.md": "- None\n" },
    });
    const truncated = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "NEXT_STEPS.md": "x".repeat(MAX_EXCERPT_CHARACTERS) },
    });

    expect(projectFacts([absent], { now: at(NOW) })[0]!.nextStepsPresent).toBe(false);
    expect(projectFacts([truncated], { now: at(NOW) })[0]!.nextStepsTruncated).toBe(true);
  });

  it("hands over every stored document excerpt", () => {
    const status = projectStatus({
      lastCommitAt: FRESH_COMMIT,
      documents: {
        "NEXT_STEPS.md": "- Keep going\n",
        "KNOWN_ISSUES.md": "- One open question\n",
        "DECISIONS.md": "- Chose the poller\n",
        "CHANGELOG.md": "- v0.1\n",
      },
    });

    const [facts] = projectFacts([status], { now: at(NOW) });

    expect(facts.documents.map((document) => document.path).sort())
      .toEqual(["CHANGELOG.md", "DECISIONS.md", "KNOWN_ISSUES.md", "NEXT_STEPS.md"]);
    expect(facts.documents.find((document) => document.path === "NEXT_STEPS.md")?.excerpt)
      .toBe("- Keep going\n");
  });

  it("refuses a clock that cannot say what time it is", () => {
    expect(() => projectFacts([], { now: () => new Date(Number.NaN) })).toThrow("project_clock_invalid");
  });
});
