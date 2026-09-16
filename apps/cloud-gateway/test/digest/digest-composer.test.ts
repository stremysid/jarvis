import { describe, expect, it } from "vitest";
import {
  compose,
  localDate,
  localWeekday,
  type ComposeOptions,
  type DigestClock,
} from "../../src/digest/digest-composer.js";
import type { DigestInput, DigestProject } from "../../src/digest/digest-types.js";

/**
 * A digest that omits a failure is indistinguishable from a digest reporting
 * a quiet day.
 *
 * That is the property most of this file is about. The rest is about the two
 * ways borrowed text can lie on its way to the owner's screen: by claiming to
 * be a heading Jarvis wrote, and by reordering itself with bidirectional
 * control characters.
 */

const TORONTO = "America/Toronto";

function clockAt(iso: string): DigestClock {
  return { now: () => new Date(iso) };
}

function daily(zone = TORONTO): ComposeOptions {
  return { kind: "daily", timeZone: zone };
}

function empty(): DigestInput {
  return {
    catchupActions: [], deadlines: [], grades: [], missingWork: [], projects: [], decisions: [], gaps: [],
  };
}

function project(overrides: Partial<DigestProject> = {}): DigestProject {
  return {
    projectId: "project-a",
    displayName: "St. Remy Efficiency",
    lastCommitAt: "2026-09-01T12:00:00.000Z",
    nextStepsExcerpt: null,
    stalledReason: null,
    pollFailure: null,
    changedDocuments: [],
    ...overrides,
  };
}

describe("the local day the digest speaks about", () => {
  it("names the local date, not the UTC one", () => {
    // 01:30 UTC on the 3rd is still the evening of the 2nd in Toronto. A
    // digest that says the 3rd here is talking about tomorrow.
    expect(localDate(new Date("2026-09-03T01:30:00.000Z"), TORONTO)).toBe("2026-09-02");
  });

  it("still names the local date after the daylight-saving boundary moves the offset", () => {
    // The cron fires at a fixed UTC hour all year. In November the offset has
    // moved by an hour, and arithmetic on a fixed offset would name the wrong
    // day for half the year.
    expect(localDate(new Date("2026-11-10T11:30:00.000Z"), TORONTO)).toBe("2026-11-10");
    expect(localDate(new Date("2026-07-10T11:30:00.000Z"), TORONTO)).toBe("2026-07-10");
  });

  it("reports the local weekday so the retro lands on a Sunday in the owner's week", () => {
    // 03:00 UTC Monday is Sunday evening in Toronto.
    expect(localWeekday(new Date("2026-09-07T03:00:00.000Z"), TORONTO)).toBe(0);
    expect(localWeekday(new Date("2026-09-07T14:00:00.000Z"), TORONTO)).toBe(1);
  });
});

describe("a digest with nothing in it", () => {
  it("says so rather than sending nothing at all", () => {
    // Silence is what a broken scheduler looks like. The owner should not have
    // to tell a quiet day from a dead cron by guessing.
    const digest = compose(empty(), daily(), clockAt("2026-09-02T11:30:00.000Z"));
    expect(digest.text).toContain("Nothing due, nothing changed, nothing waiting on you.");
    expect(digest.truncated).toBe(false);
  });
});

describe("sources that could not be read", () => {
  it("reports a gap rather than leaving it out", () => {
    const digest = compose(
      { ...empty(), gaps: [{ source: "Brightspace", detail: "session expired" }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).toContain("Could not be read");
    expect(digest.text).toContain("Brightspace: session expired");
  });

  it("keeps the gap section when everything else has been trimmed away", () => {
    // The whole reason a failed source is recorded is that a silent omission
    // reads as good news. Trimming it to fit would restore exactly that.
    const noisy = Array.from({ length: 400 }, (_unused, index) =>
      project({
        projectId: `project-${index}`,
        displayName: `Project ${index} with a deliberately long name to consume the budget`,
        stalledReason: "no commit in 30 days with a deadline on 2026-09-05",
      }),
    );
    const digest = compose(
      { ...empty(), projects: noisy, gaps: [{ source: "Brightspace", detail: "session expired" }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );

    expect(digest.truncated).toBe(true);
    expect(digest.text).toContain("Brightspace: session expired");
    expect(digest.text).toContain("(trimmed to fit)");
    expect(digest.text.length).toBeLessThanOrEqual(4_096 + "\n\n(trimmed to fit)".length);
  });

  it("reports a project whose poll failed instead of showing it as quiet", () => {
    const digest = compose(
      { ...empty(), projects: [project({ pollFailure: "403 from GitHub" })] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).toContain("could not be read (403 from GitHub)");
  });
});

describe("deadlines", () => {
  const base = {
    deadlineId: "deadline-a",
    course: "Calculus",
    effort: "quiz" as const,
  };

  it("orders the nearest deadline first and describes how far away each is", () => {
    const digest = compose(
      {
        ...empty(),
        deadlines: [
          { ...base, deadlineId: "d2", title: "Essay", dueAt: "2026-09-05T16:00:00.000Z", effort: "essay" },
          { ...base, deadlineId: "d1", title: "Quiz 3", dueAt: "2026-09-02T18:00:00.000Z" },
        ],
      },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    const due = digest.sections.find((section) => section.heading === "Due");
    expect(due?.lines[0]).toContain("Quiz 3");
    expect(due?.lines[1]).toContain("Essay");
  });

  it("keeps a deadline whose due date will not parse rather than dropping it", () => {
    // A deadline nobody can read is still a deadline. Filtering it out is how
    // something goes missing with no trace that it ever existed.
    const digest = compose(
      { ...empty(), deadlines: [{ ...base, title: "Lab", dueAt: "sometime next week" }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).toContain("Lab");
    expect(digest.text).toContain("unreadable date");
  });

  it("marks a passed deadline overdue rather than hiding it", () => {
    const digest = compose(
      { ...empty(), deadlines: [{ ...base, title: "Quiz 2", dueAt: "2026-09-01T18:00:00.000Z" }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).toContain("overdue");
  });

  it("leaves out a deadline past the horizon", () => {
    const digest = compose(
      { ...empty(), deadlines: [{ ...base, title: "Final", dueAt: "2026-12-01T18:00:00.000Z" }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).not.toContain("Final");
  });
});

describe("today's school catch-up", () => {
  it("keeps real deadlines ahead of the proposed sequence and neutralises course text", () => {
    const digest = compose(
      {
        ...empty(),
        catchupActions: [
          { actionId: "action-2", course: "Calculus", text: "Do questions 4-8", sequenceRank: 2, estimatedMinutes: 35 },
          { actionId: "action-1", course: "Chemistry\nCould not be read", text: "Finish the lab notes", sequenceRank: 1, estimatedMinutes: 25 },
        ],
        deadlines: [{
          deadlineId: "deadline-a", course: "Calculus", title: "Quiz 3",
          dueAt: "2026-09-02T18:00:00.000Z", effort: "quiz",
        }],
      },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );

    const section = digest.sections.find((entry) => entry.heading === "School catch-up");
    expect(section?.lines).toEqual([
      "1. ChemistryCould not be read: Finish the lab notes (25 min)",
      "2. Calculus: Do questions 4-8 (35 min)",
    ]);
    expect(digest.sections.findIndex((entry) => entry.heading === "Due")).toBeLessThan(
      digest.sections.indexOf(section!),
    );
  });

  it("keeps due dates when an oversized proposed sequence must be trimmed", () => {
    const digest = compose(
      {
        ...empty(),
        catchupActions: Array.from({ length: 100 }, (_, index) => ({
          actionId: `action-${index}`,
          course: `Course ${index}`,
          text: `Proposed study step ${index} ${"x".repeat(220)}`,
          sequenceRank: index + 1,
          estimatedMinutes: 20,
        })),
        deadlines: [{
          deadlineId: "deadline-protected",
          course: "Calculus",
          title: "Teacher-set final assignment",
          dueAt: "2026-09-02T18:00:00.000Z",
          effort: "other",
        }],
      },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );

    expect(digest.truncated).toBe(true);
    expect(digest.text).toContain("Teacher-set final assignment");
    expect(digest.sections.some((section) => section.heading === "Due")).toBe(true);
  });
});

describe("verified grades and derived submission checks", () => {
  it("shows an assigned grade only with its verified source and freshness", () => {
    const digest = compose({
      ...empty(),
      grades: [{
        observationId: "observation-a",
        course: "Calculus",
        title: "Limits quiz",
        assignedGrade: 83.5,
        source: "Google Classroom",
        lastSeenAt: "2026-09-02T10:00:00.000Z",
      }],
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    expect(digest.text).toContain("[verified: Google Classroom; checked 2026-09-02T10:00:00.000Z]");
    expect(digest.text).toContain("assigned grade 83.5");
    expect(digest.text).toContain("scale and weight not supplied");
    expect(digest.text).not.toContain("83.5%");
  });

  it("labels an absent submission signal as derived no submission seen and never as a factual miss", () => {
    const digest = compose({
      ...empty(),
      missingWork: [{
        transitionId: "transition-a",
        course: "Chemistry",
        title: "Lab reflection",
        dueAt: "2026-09-01T20:00:00.000Z",
        classification: "derived",
        state: "no_submission_seen",
        source: "Google Classroom",
        derivedAt: "2026-09-02T10:00:00.000Z",
      }],
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    expect(digest.text).toContain("[derived: no submission seen; Google Classroom scan 2026-09-02T10:00:00.000Z]");
    expect(digest.text).not.toMatch(/you missed|missed assignment|confirmed missing/iu);
  });

  it("keeps due work ahead of grade and submission observations", () => {
    const digest = compose({
      ...empty(),
      deadlines: [{
        deadlineId: "deadline-a", course: "Calculus", title: "Quiz 3",
        dueAt: "2026-09-02T18:00:00.000Z", effort: "quiz",
      }],
      grades: [{
        observationId: "observation-a", course: "Calculus", title: "Quiz 2",
        assignedGrade: 80, source: "Google Classroom", lastSeenAt: "2026-09-02T10:00:00.000Z",
      }],
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));
    expect(digest.sections.findIndex((section) => section.heading === "Due")).toBeLessThan(
      digest.sections.findIndex((section) => section.heading === "Grades and submission checks"),
    );
  });
});

describe("borrowed text", () => {
  it("quotes a repository excerpt so it cannot read as a line Jarvis wrote", () => {
    const digest = compose(
      { ...empty(), projects: [project({ nextStepsExcerpt: "Could not be read\nship the thing" })] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );

    // The file contains a line identical to one of the digest's own headings.
    // It must appear as a quoted line, not as a section of its own.
    expect(digest.text).toContain("| Could not be read");
    expect(digest.sections.map((section) => section.heading)).not.toContain("Could not be read");
  });

  it("strips a right-to-left override that would reorder what the owner reads", () => {
    const digest = compose(
      {
        ...empty(),
        projects: [project({ nextStepsExcerpt: "pay ‮dnetfil‬ now" })],
      },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).not.toContain("‮");
    expect(digest.text).not.toContain("‬");
  });

  it("bounds a single long line rather than letting one file fill the message", () => {
    const digest = compose(
      { ...empty(), projects: [project({ nextStepsExcerpt: "x".repeat(5_000) })] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    const quoted = digest.sections
      .flatMap((section) => section.lines)
      .find((line) => line.startsWith("| "));
    expect(quoted).toBeDefined();
    expect(quoted!.length).toBeLessThanOrEqual(2 + 240);
  });

  it("takes only the first few lines of a long excerpt", () => {
    const digest = compose(
      { ...empty(), projects: [project({ nextStepsExcerpt: "a\nb\nc\nd\ne" })] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).toContain("| a");
    expect(digest.text).not.toContain("| d");
  });
});

describe("the decision queue in the digest", () => {
  it("puts urgent items above normal ones and marks them", () => {
    const digest = compose(
      {
        ...empty(),
        decisions: [
          { decisionId: "d1", question: "Approve the invoice?", urgency: "normal" },
          { decisionId: "d2", question: "Vendor is asking to reschedule", urgency: "urgent" },
        ],
      },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    const section = digest.sections.find((entry) => entry.heading.startsWith("Waiting on you"));
    expect(section?.heading).toBe("Waiting on you (2)");
    expect(section?.lines[0]).toBe("! Vendor is asking to reschedule");
    expect(section?.lines[1]).toBe("Approve the invoice?");
  });

  it("shows a question made entirely of control characters as unreadable, not as a blank line", () => {
    const digest = compose(
      { ...empty(), decisions: [{ decisionId: "d3", question: "​‮", urgency: "normal" }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).toContain("(unreadable) d3");
  });
});

describe("the Sunday retro", () => {
  it("is titled as a week rather than a day", () => {
    const digest = compose(empty(), { kind: "retro", timeZone: TORONTO }, clockAt("2026-09-06T23:00:00.000Z"));
    expect(digest.kind).toBe("retro");
    expect(digest.sections[0]?.heading).toContain("Retro -- week to");
  });
});
