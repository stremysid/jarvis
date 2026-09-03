import { describe, expect, it } from "vitest";
import {
  assessStaleness,
  detectStalledProjects,
  readDeadlines,
} from "../../src/projects/stalled-detector.js";
import { MAX_EXCERPT_CHARACTERS } from "../../src/projects/project-types.js";
import { projectStatus } from "./project-fixture.js";

/**
 * The detector has two ways to fail and only one of them is visible.
 *
 * Flagging a project that is fine costs a line in a digest. Failing to flag one
 * that is late costs the thing the detector was built for, and leaves no trace
 * that anything was missed -- so the tests that matter most here are the ones
 * about text the parser refuses: an unreadable date must never come out the
 * same way as a document with no deadline in it.
 */

const NOW = "2026-09-01T00:00:00.000Z";
const DAY_MS = 86_400_000;

function at(instant: string): () => Date {
  return () => new Date(instant);
}

const STALE_COMMIT = "2026-08-01T00:00:00.000Z";
const FRESH_COMMIT = "2026-08-30T00:00:00.000Z";

describe("readDeadlines", () => {
  const nowMs = new Date(NOW).valueOf();
  const horizonMs = 14 * DAY_MS;

  it("parses an ISO calendar date", () => {
    const reading = readDeadlines("- Ship the poller by 2026-09-10\n", nowMs, horizonMs);
    expect(reading.dates).toEqual(["2026-09-10"]);
    expect(reading.nearest).toBe("2026-09-10");
    expect(reading.approaching).toBe(true);
    expect(reading.overdue).toBe(false);
    expect(reading.unreadable).toEqual([]);
  });

  it("parses the day out of an ISO timestamp", () => {
    const reading = readDeadlines("Due 2026-09-10T09:00:00Z\n", nowMs, horizonMs);
    expect(reading.dates).toEqual(["2026-09-10"]);
    expect(reading.unreadable).toEqual([]);
  });

  it("treats a deadline as met until the end of the day it names", () => {
    const dueToday = new Date("2026-09-10T12:00:00.000Z").valueOf();
    const nextDay = new Date("2026-09-11T00:00:00.001Z").valueOf();
    expect(readDeadlines("by 2026-09-10", dueToday, horizonMs).overdue).toBe(false);
    expect(readDeadlines("by 2026-09-10", nextDay, horizonMs).overdue).toBe(true);
  });

  it("takes the earliest date as the deadline that falls due first", () => {
    const reading = readDeadlines("2026-11-01 launch, 2026-09-05 freeze\n", nowMs, horizonMs);
    expect(reading.dates).toEqual(["2026-09-05", "2026-11-01"]);
    expect(reading.nearest).toBe("2026-09-05");
  });

  it("reports an ambiguous numeric date as unreadable rather than as no deadline", () => {
    // 03/04/2026 is March 4th in one country and April 3rd in another. Nothing
    // in the document says which, so guessing would be wrong by a month for
    // half its inputs.
    const reading = readDeadlines("- Ship the poller by 03/04/2026\n", nowMs, horizonMs);
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual(["03/04/2026"]);
  });

  it("reports a month name as unreadable", () => {
    const reading = readDeadlines("- Freeze by Sep 15, launch March 4th\n", nowMs, horizonMs);
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual(["Sep 15", "March 4th"]);
  });

  it("reports a relative deadline as unreadable, having no reference date to resolve it against", () => {
    const reading = readDeadlines("- Cut the release next Friday\n- Review EOW\n", nowMs, horizonMs);
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual(["EOW", "next Friday"]);
  });

  it("reports an ISO-shaped string that is not a real calendar day as unreadable", () => {
    const reading = readDeadlines("Due 2026-02-30 and 2026-13-01\n", nowMs, horizonMs);
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual(["2026-02-30", "2026-13-01"]);
  });

  it("does not read a version number as a date", () => {
    // The refused shapes fire an escalation on a stale project, so a pattern
    // that matched every dependency bump would make the detector useless by
    // firing on everything.
    const reading = readDeadlines("- Bump fflate to 0.8.2, wrangler to 4.127.1\n", nowMs, horizonMs);
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual([]);
  });

  it("does not read the word maybe as the month of May", () => {
    const reading = readDeadlines("- Maybe 3 more repositories should be tracked\n", nowMs, horizonMs);
    expect(reading.unreadable).toEqual([]);
  });

  it("says nothing about time when the document says nothing about time", () => {
    const reading = readDeadlines("# Next steps\n- Finish the digest\n- Write the runbook\n", nowMs, horizonMs);
    expect(reading.dates).toEqual([]);
    expect(reading.unreadable).toEqual([]);
    expect(reading.approaching).toBe(false);
    expect(reading.truncated).toBe(false);
  });

  it("flattens an unreadable sample to one short line", () => {
    // Untrusted text bound for a digest. It is displayed, never interpreted.
    const reading = readDeadlines(`Ship by ${"9".repeat(2)}/${"9".repeat(2)}/2026 \ndone`, nowMs, horizonMs);
    expect(reading.unreadable).toEqual(["99/99/2026"]);
  });

  it("notes when the excerpt is at its bound and a deadline may sit past it", () => {
    const reading = readDeadlines("x".repeat(MAX_EXCERPT_CHARACTERS), nowMs, horizonMs);
    expect(reading.truncated).toBe(true);
  });
});

describe("detectStalledProjects", () => {
  it("flags a repository past its stale threshold that carries an approaching deadline", () => {
    const status = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "NEXT_STEPS.md": "- Ship the poller by 2026-09-10\n" },
    });

    const [report] = detectStalledProjects([status], { now: at(NOW) });

    expect(report.stale).toBe(true);
    expect(report.escalate).toBe(true);
    expect(report.reasons).toEqual(["approaching_deadline"]);
    expect(report.daysSinceLastCommit).toBe(31);
  });

  it("does not flag a repository past its stale threshold whose only deadline is months away", () => {
    const status = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "NEXT_STEPS.md": "- Launch by 2026-12-31\n" },
    });

    expect(detectStalledProjects([status], { now: at(NOW) })).toEqual([]);
    const [report] = assessStaleness([status], { now: at(NOW) });
    expect(report.stale).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it("does not flag a repository with an approaching deadline that is still being committed to", () => {
    const status = projectStatus({
      lastCommitAt: FRESH_COMMIT,
      documents: { "NEXT_STEPS.md": "- Ship the poller by 2026-09-02\n" },
    });

    expect(detectStalledProjects([status], { now: at(NOW) })).toEqual([]);
  });

  it("does not silently read an unparseable date as no deadline", () => {
    // The whole point. A stale project whose plan is written in prose is
    // exactly the one most likely to be late, and reading "by next Friday" as
    // "no deadline" would turn the detector into a thing that reports nothing.
    const status = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "NEXT_STEPS.md": "- Ship the poller by next Friday\n" },
    });

    const [report] = detectStalledProjects([status], { now: at(NOW) });

    expect(report.reasons).toEqual(["deadline_unreadable"]);
    expect(report.deadline.dates).toEqual([]);
    expect(report.deadline.unreadable).toEqual(["next Friday"]);
  });

  it("names an overdue deadline as overdue rather than as merely approaching", () => {
    const status = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "NEXT_STEPS.md": "- Ship the poller by 2026-08-20\n" },
    });

    const [report] = detectStalledProjects([status], { now: at(NOW) });

    expect(report.reasons).toEqual(["overdue_deadline"]);
    expect(report.deadline.overdue).toBe(true);
  });

  it("cannot rule out a deadline in a NEXT_STEPS.md the project does not have", () => {
    const status = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "KNOWN_ISSUES.md": "- None\n" },
    });

    const [report] = detectStalledProjects([status], { now: at(NOW) });

    expect(report.reasons).toEqual(["deadline_unseen"]);
    expect(report.deadline).toMatchObject({ available: false, unavailableReason: "document_absent" });
  });

  it("cannot rule out a deadline sitting past the end of a truncated excerpt", () => {
    const status = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "NEXT_STEPS.md": "x".repeat(MAX_EXCERPT_CHARACTERS) },
    });

    const [report] = detectStalledProjects([status], { now: at(NOW) });

    expect(report.reasons).toEqual(["deadline_possibly_truncated"]);
  });

  it("escalates a project whose polls have been failing even though its documents look calm", () => {
    // A source that has been quietly failing for a week is the failure this
    // design exists to prevent. Its last successful observation still says
    // everything is fine, and it will keep saying so.
    const status = projectStatus({
      lastCommitAt: FRESH_COMMIT,
      documents: { "NEXT_STEPS.md": "- Nothing urgent\n" },
      pollHealth: "failing",
    });

    const [report] = detectStalledProjects([status], { now: at(NOW) });

    expect(report.stale).toBe(false);
    expect(report.blind).toBe(true);
    expect(report.reasons).toEqual(["polling_failing"]);
  });

  it("escalates a project that has never been polled successfully", () => {
    const status = projectStatus({ pollHealth: "never_polled" });

    const [report] = detectStalledProjects([status], { now: at(NOW) });

    expect(report.reasons).toEqual(["never_polled"]);
    expect(report.daysSinceLastCommit).toBeNull();
    expect(report.deadline).toMatchObject({ available: false, unavailableReason: "never_observed" });
  });

  it("reports both reasons when a stalled project is also unreachable", () => {
    const status = projectStatus({
      lastCommitAt: STALE_COMMIT,
      documents: { "NEXT_STEPS.md": "- Ship the poller by 2026-09-10\n" },
      pollHealth: "failing",
    });

    const [report] = detectStalledProjects([status], { now: at(NOW) });

    expect(report.reasons).toEqual(["polling_failing", "approaching_deadline"]);
  });

  it("assesses every project, not only the ones in trouble", () => {
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

    expect(assessStaleness(statuses, { now: at(NOW) }).map((entry) => entry.projectId))
      .toEqual(["project:late", "project:calm"]);
    expect(detectStalledProjects(statuses, { now: at(NOW) }).map((entry) => entry.projectId))
      .toEqual(["project:late"]);
  });

  it("honours a project's own stale threshold rather than a single global one", () => {
    const documents = { "NEXT_STEPS.md": "- Ship by 2026-09-05\n" };
    const patient = projectStatus({
      project: { projectId: "project:patient", staleAfterDays: 60 },
      lastCommitAt: STALE_COMMIT,
      documents,
    });
    const impatient = projectStatus({
      project: { projectId: "project:impatient", staleAfterDays: 2 },
      lastCommitAt: STALE_COMMIT,
      documents,
    });

    expect(detectStalledProjects([patient, impatient], { now: at(NOW) }).map((entry) => entry.projectId))
      .toEqual(["project:impatient"]);
  });

  it("refuses a clock that cannot say what time it is", () => {
    expect(() => assessStaleness([], { now: () => new Date(Number.NaN) })).toThrow("project_clock_invalid");
  });
});
