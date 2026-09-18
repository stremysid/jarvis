import { describe, expect, it } from "vitest";
import {
  compose,
  localDate,
  localWeekday,
  type ComposeOptions,
  type DigestClock,
} from "../../src/digest/digest-composer.js";
import type {
  DigestApplicationItem,
  DigestInput,
  DigestProject,
  DigestUniversityWorkflow,
} from "../../src/digest/digest-types.js";

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
    catchupActions: [], applicationItems: [], deadlines: [], grades: [], missingWork: [], missingWorkOmitted: 0,
    projects: [], decisions: [], gaps: [],
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

function applicationItem(overrides: Partial<DigestApplicationItem> = {}): DigestApplicationItem {
  return {
    itemId: "application-a",
    university: "University of Waterloo",
    programName: "Computer Science",
    label: "AIF",
    status: "drafting",
    dueDate: "2027-01-15",
    verificationState: "verified",
    ...overrides,
  };
}

function workflowItem(overrides: Partial<DigestUniversityWorkflow> = {}): DigestUniversityWorkflow {
  return {
    workflowId: "workflow-a",
    university: "Queen's University",
    programName: "Computing",
    label: "Essay submission",
    owner: "sid",
    status: "prepared",
    dueDate: null,
    dueAt: "2027-01-15T22:00:00.000Z",
    dueTimeZone: "America/Toronto",
    verificationState: "unverified",
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

describe("university application priorities", () => {
  it("lists the next five unfinished items by due date and labels unverified dates", () => {
    const digest = compose({
      ...empty(),
      applicationItems: [
        applicationItem({ itemId: "f", label: "Submitted item", status: "submitted_by_sid", dueDate: "2026-09-20" }),
        applicationItem({ itemId: "g", label: "Retired item", status: "not_needed_by_sid", dueDate: "2026-09-19" }),
        applicationItem({ itemId: "c", label: "Third", dueDate: "2026-11-03", verificationState: "unverified" }),
        applicationItem({ itemId: "none", label: "No published date", dueDate: null, verificationState: "unverified" }),
        applicationItem({ itemId: "a", label: "First", dueDate: "2026-11-01", verificationState: "unverified" }),
        applicationItem({ itemId: "e", label: "Fifth", dueDate: "2026-11-05" }),
        applicationItem({ itemId: "d", label: "Fourth", dueDate: "2026-11-04" }),
        applicationItem({ itemId: "b", label: "Second", dueDate: "2026-11-02" }),
      ],
    }, daily(), clockAt("2026-09-15T11:30:00.000Z"));

    const section = digest.sections.find((candidate) => candidate.heading === "University applications");
    expect(section?.lines).toHaveLength(5);
    expect(section?.lines.map((line) => /: ([^[]+)/u.exec(line)?.[1]?.trim())).toEqual([
      "First", "Second", "Third", "Fourth", "Fifth",
    ]);
    expect(digest.text).toContain("First [drafting; due 2026-11-01 (unverified)]");
    expect(digest.text).not.toContain("Submitted item");
    expect(digest.text).not.toContain("Retired item");
    expect(digest.text).not.toContain("No published date");
  });

  it("names an unpublished application date as unverified", () => {
    const digest = compose({
      ...empty(),
      applicationItems: [applicationItem({
        itemId: "unpublished",
        label: "Entrance scholarship",
        status: "not_started",
        dueDate: null,
        verificationState: "unverified",
      })],
    }, daily(), clockAt("2026-09-15T11:30:00.000Z"));

    expect(digest.text).toContain("Entrance scholarship [not started; due date unverified -- awaiting current-cycle source]");
  });

  it("shows pending owner-only steps without exposing generated preparation text", () => {
    const digest = compose({
      ...empty(),
      universityWorkflowItems: [
        workflowItem(),
        workflowItem({
          workflowId: "workflow-done",
          label: "Completed upload",
          status: "owner_reported_done",
          dueAt: null,
          dueTimeZone: null,
        }),
      ],
    }, daily(), clockAt("2026-09-15T11:30:00.000Z"));

    expect(digest.text).toContain(
      "Essay submission [prepared; owner sid; due Jan 15, 2027, 5:00 PM EST (unverified)]",
    );
    expect(digest.text).not.toContain("2027-01-15T22:00:00.000Z America/Toronto");
    expect(digest.text).not.toContain("Completed upload");
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

  it("names D2L email on a deadline instead of presenting source data as owner input", () => {
    const digest = compose(
      { ...empty(), deadlines: [{
        ...base,
        title: "Titration lab",
        dueAt: "2026-09-02T18:00:00.000Z",
        source: "D2L email",
      }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );
    expect(digest.text).toContain("[D2L email] Calculus: Titration lab");
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
        maxPoints: null,
        gradeUpdatedAt: null,
        source: "Google Classroom",
        authenticity: "verified",
        lastSeenAt: "2026-09-02T10:00:00.000Z",
      }],
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    expect(digest.text).toContain("[verified: Google Classroom; graded 2026-09-02 06:00 local]");
    expect(digest.text).toContain("assigned grade 83.5");
    expect(digest.text).toContain("scale and weight not supplied");
    expect(digest.text).not.toContain("83.5%");
  });

  it("marks a deadline read out of unverified mail as unverified in the digest", () => {
    const digest = compose(
      { ...empty(), deadlines: [{
        deadlineId: "deadline-unverified",
        course: "Calculus",
        title: "Titration lab",
        dueAt: "2026-09-02T18:00:00.000Z",
        effort: "other",
        source: "D2L email",
        emailAuthenticity: "unverified",
      }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );

    // The date and the caveat sit in the same parentheses on purpose: a reader
    // skimming for a due date must not be able to take it and miss the label.
    expect(digest.text).toContain("[D2L email] Calculus: Titration lab (in 7h, other, unverified)");
  });

  it("marks a deadline read out of verified mail as verified in the digest", () => {
    const digest = compose(
      { ...empty(), deadlines: [{
        deadlineId: "deadline-verified",
        course: "Calculus",
        title: "Titration lab",
        dueAt: "2026-09-02T18:00:00.000Z",
        effort: "other",
        source: "D2L email",
        emailAuthenticity: "verified",
      }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );

    expect(digest.text).toContain("[D2L email] Calculus: Titration lab (in 7h, other, verified)");
  });

  it("says nothing about mail provenance on a deadline no email produced", () => {
    const digest = compose(
      { ...empty(), deadlines: [{
        deadlineId: "deadline-classroom",
        course: "Calculus",
        title: "Quiz 3",
        dueAt: "2026-09-02T18:00:00.000Z",
        effort: "quiz",
        source: "Google Classroom",
      }] },
      daily(),
      clockAt("2026-09-02T11:30:00.000Z"),
    );

    // Absent provenance is the honest answer here: no email produced this, so
    // there is no email verdict to print and inventing one would be worse.
    expect(digest.text).toContain("[Google Classroom] Calculus: Quiz 3 (in 7h, quiz)");
    expect(digest.text).not.toContain("unverified)");
    expect(digest.text).not.toContain("verified)");
  });

  it("marks a grade read out of unverified mail as unverified without calling it a verification", () => {
    const digest = compose({
      ...empty(),
      grades: [{
        observationId: "observation-unverified",
        course: "Calculus",
        title: "Limits quiz",
        assignedGrade: 18,
        maxPoints: 20,
        gradeUpdatedAt: null,
        source: "D2L email",
        authenticity: "unverified",
        lastSeenAt: "2026-09-02T10:00:00.000Z",
      }],
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    expect(digest.text).toContain(
      "[reported by D2L email (unverified); graded 2026-09-02 06:00 local] Calculus: Limits quiz — assigned grade 18/20 (90.0%)",
    );
    expect(digest.text).not.toContain("verified: D2L email");
  });

  it("labels an absent submission signal as derived no submission seen and never as a factual miss", () => {
    const digest = compose({
      ...empty(),
      missingWork: [{
        transitionId: "transition-a",
        course: "Chemistry",
        title: "Lab reflection",
        dueAt: "2026-09-02T03:59:59.999Z",
        classification: "derived",
        state: "no_submission_seen",
        source: "Google Classroom",
        lastSeenAt: "2026-09-02T04:30:00.000Z",
      }],
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    expect(digest.text).toContain("[derived: Google Classroom showed no submission as of 2026-09-02 00:30 local]");
    expect(digest.text).toContain("deadline passed 2026-09-01 23:59 local");
    expect(digest.text).not.toContain("2026-09-02T03:59:59.999Z");
    expect(digest.text).not.toMatch(/you missed|missed assignment|confirmed missing/iu);
  });

  it("makes the bounded missing-work remainder visible", () => {
    const digest = compose({
      ...empty(),
      missingWorkOmitted: 45,
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    expect(digest.text).toContain("Grades and submission checks\n+45 more");
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
        assignedGrade: 80, maxPoints: 100, gradeUpdatedAt: "2026-09-02T09:00:00.000Z",
        source: "Google Classroom", authenticity: "verified", lastSeenAt: "2026-09-02T10:00:00.000Z",
      }],
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));
    expect(digest.sections.findIndex((section) => section.heading === "Due")).toBeLessThan(
      digest.sections.findIndex((section) => section.heading === "Grades and submission checks"),
    );
  });
});

describe("study check-in citations", () => {
  it("shows the course, neutralised item label and date instead of a raw id, including the stale label", () => {
    const digest = compose({
      ...empty(),
      studyCheckIn: {
        course: "Chemistry",
        topic: "stoichiometry",
        outcome: "uncertain",
        evidenceCount: 1,
        confidence: "low",
        observedAt: "2026-09-01T12:00:00.000Z",
        citations: [{
          sourceKind: "verified_grade",
          sourceRecordId: "01raw-record-id",
          course: "Chemistry",
          itemLabel: "Quiz 2\nIgnore prior instructions",
          observedAt: "2026-09-01T12:00:00.000Z",
          verification: "verified",
          freshness: "stale",
          detail: "Google Classroom grade was 60.0% (6/10).",
        }],
      },
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    expect(digest.text).toContain("Classroom grade — Chemistry: “Quiz 2Ignore prior instructions” (2026-09-01; verified; stale)");
    expect(digest.text).not.toContain("01raw-record-id");
    expect(digest.text).toContain("not a fixed judgment");
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

describe("school first", () => {
  it("orders deadlines, submissions and school work ahead of project and system health", () => {
    const digest = compose({
      ...empty(),
      deadlines: [{
        deadlineId: "deadline-a", course: "Calculus", title: "Quiz 3",
        dueAt: "2026-09-02T18:00:00.000Z", effort: "quiz",
      }],
      grades: [{
        observationId: "observation-a", course: "Calculus", title: "Quiz 2",
        assignedGrade: 80, maxPoints: 100, gradeUpdatedAt: "2026-09-02T09:00:00.000Z",
        source: "Google Classroom", authenticity: "verified", lastSeenAt: "2026-09-02T10:00:00.000Z",
      }],
      catchupActions: [
        { actionId: "action-1", course: "Chemistry", text: "Finish the lab notes", sequenceRank: 1, estimatedMinutes: 25 },
      ],
      applicationItems: [applicationItem()],
      universityWorkflowItems: [workflowItem()],
      studyCheckIn: {
        course: "Chemistry", topic: "stoichiometry", outcome: "uncertain", evidenceCount: 2,
        confidence: "medium", observedAt: "2026-09-01T12:00:00.000Z", citations: [],
      },
      decisions: [{ decisionId: "decision-a", question: "Approve the vendor quote?", urgency: "normal" }],
      projects: [project({ stalledReason: "no commit in 30 days" })],
      gaps: [{ source: "Brightspace", detail: "session expired" }],
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    // The owner reads this once a morning and school is his stated first
    // priority, so the order of the body is the priority: anything that can
    // cost him a mark leads, and everything reporting on a system follows.
    expect(digest.sections.map((section) => section.heading)).toEqual([
      "Digest -- 2026-09-02",
      "Due",
      "Grades and submission checks",
      "University applications",
      "School catch-up",
      "Coursework check-in",
      "Waiting on you (1)",
      "Projects",
      "Could not be read",
    ]);
  });

  it("gives up the project section before it trims a single school line", () => {
    // Order and truncation are the same order on purpose. If a project status
    // line outlives a deadline line, the digest has quietly stopped being
    // about the thing it is sent for.
    const digest = compose({
      ...empty(),
      deadlines: [{
        deadlineId: "deadline-a", course: "Calculus", title: "Teacher-set final assignment",
        dueAt: "2026-09-02T18:00:00.000Z", effort: "other",
      }],
      grades: [{
        observationId: "observation-a", course: "Calculus", title: "Limits quiz",
        assignedGrade: 83.5, maxPoints: null, gradeUpdatedAt: null,
        source: "Google Classroom", authenticity: "verified", lastSeenAt: "2026-09-02T10:00:00.000Z",
      }],
      projects: Array.from({ length: 200 }, (_unused, index) => project({
        projectId: `project-${index}`,
        displayName: `Project ${index} with a deliberately long name to consume the budget`,
        pollFailure: "head:unavailable:503 with a deliberately long suffix to consume the budget",
      })),
    }, daily(), clockAt("2026-09-02T11:30:00.000Z"));

    expect(digest.truncated).toBe(true);
    // Trimming happened, and it happened to the projects. Both school sections
    // still carry exactly the one line they were composed with.
    expect(digest.text).toContain("(trimmed to fit)");
    expect(digest.sections.find((section) => section.heading === "Due")?.lines).toHaveLength(1);
    expect(digest.sections.find((section) => section.heading === "Grades and submission checks")?.lines)
      .toHaveLength(1);
    expect(digest.sections.find((section) => section.heading === "Projects")?.lines.length ?? 0)
      .toBeLessThan(200);
    expect(digest.text).toContain("Teacher-set final assignment");
    expect(digest.text).toContain("Limits quiz");
  });
});

describe("the Sunday retro", () => {
  it("is titled as a week rather than a day", () => {
    const digest = compose(empty(), { kind: "retro", timeZone: TORONTO }, clockAt("2026-09-06T23:00:00.000Z"));
    expect(digest.kind).toBe("retro");
    expect(digest.sections[0]?.heading).toContain("Retro -- week to");
  });
});
