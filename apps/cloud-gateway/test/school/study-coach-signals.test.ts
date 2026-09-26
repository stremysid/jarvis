import { describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { StudyDeadlineCandidate } from "../../src/deadlines/deadline-types.js";
import type { SchoolObservationStudySnapshot } from "../../src/school/school-observation-types.js";
import { chooseStudyCheckIn, deriveStudySignals } from "../../src/school/study-coach-signals.js";
import type { StudyCoachSnapshot, StudyEvidencePoint } from "../../src/school/study-coach-types.js";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const COURSE_ID = "01k5fb9pg00000000000007000" as Ulid;

function snapshot(evidence: readonly StudyEvidencePoint[] = []): StudyCoachSnapshot {
  return {
    principalId: "principal:signal-test",
    preference: { enabled: true, allowedDaysMask: 127, quietStartMinute: 1320, quietEndMinute: 420 },
    activeQuiz: null,
    courses: [{
      courseId: COURSE_ID,
      name: "Chemistry",
      facts: [],
      topics: evidence.length === 0 ? [] : [{
        topic: "stoichiometry",
        topicKey: "stoichiometry",
        evidence,
        judgement: evidence.length > 1 ? "supported" : "tentative",
        confidence: evidence.length > 1 ? "medium" : "low",
      }],
    }],
  };
}

function quizEvidence(overrides: Partial<StudyEvidencePoint> = {}): StudyEvidencePoint {
  return {
    evidenceId: "01k5fb9pg00000000000007001" as Ulid,
    topic: "stoichiometry",
    topicKey: "stoichiometry",
    outcome: "wrong",
    evidenceKind: "practice_result",
    sourceRecordId: "01k5fb9pg00000000000007002",
    evidenceText: "owner answer",
    confidence: "medium",
    observedAt: "2026-09-16T10:00:00.000Z",
    practiceDueOn: "2026-09-16",
    lastPromptedOn: null,
    ...overrides,
  };
}

function observations(overrides: Partial<SchoolObservationStudySnapshot> = {}): SchoolObservationStudySnapshot {
  return { grades: [], missingWork: [], ...overrides };
}

function deadline(overrides: Partial<StudyDeadlineCandidate> = {}): StudyDeadlineCandidate {
  return {
    deadline: {
      deadlineId: "deadline-chemistry",
      sourceId: "google-classroom",
      externalId: "chemistry:work",
      course: "SCH4U Chemistry",
      title: "Untrusted worksheet title",
      dueAt: "2026-09-16T14:00:00.000Z",
      status: "open",
      contentHash: "a".repeat(64),
      firstSeenAt: "2026-09-15T12:00:00.000Z",
      lastSeenAt: "2026-09-16T11:00:00.000Z",
    },
    sourceKind: "classroom",
    sourceLastSuccessAt: "2026-09-16T11:00:00.000Z",
    sourceLastFailure: null,
    ...overrides,
  };
}

describe("study weak-spot signal derivation", () => {
  it("derives no grade signal until Classroom supplies both max points and its own grade timestamp", () => {
    const signals = deriveStudySignals(snapshot(), { observations: observations({
      grades: [{
        observationId: "01k5fb9pg00000000000007101", deadlineId: "grade-latest",
        course: "Chemistry", title: "Do not infer stoichiometry from me", assignedGrade: 6,
        maxPoints: null, gradeUpdatedAt: null,
        source: "google_classroom_api", contentChangedAt: "2026-09-16T10:00:00.000Z",
        lastSeenAt: "2026-09-16T11:00:00.000Z", sourceLastSuccessAt: "2026-09-16T11:00:00.000Z",
        sourceLastFailure: null,
      }],
    }) }, NOW);

    expect(signals).toEqual([]);
  });

  it("compares Classroom percentages and dates grade evidence with the provider timestamp", () => {
    const common = {
      course: "Chemistry", source: "google_classroom_api" as const,
      lastSeenAt: "2026-09-16T11:00:00.000Z",
      sourceLastSuccessAt: "2026-09-16T11:00:00.000Z", sourceLastFailure: null,
    };
    const strong = deriveStudySignals(snapshot(), { observations: observations({ grades: [
      {
        ...common, observationId: "01k5fb9pg00000000000007101", deadlineId: "grade-latest",
        title: "Ten-point quiz", assignedGrade: 9, maxPoints: 10,
        gradeUpdatedAt: "2026-09-16T09:00:00.000Z", contentChangedAt: "2026-09-16T10:00:00.000Z",
      },
      {
        ...common, observationId: "01k5fb9pg00000000000007102", deadlineId: "grade-prior",
        title: "Fifty-point essay", assignedGrade: 45, maxPoints: 50,
        gradeUpdatedAt: "2026-09-10T09:00:00.000Z", contentChangedAt: "2026-09-16T10:00:00.000Z",
      },
    ] }) }, NOW);
    expect(strong).toEqual([]);

    const low = deriveStudySignals(snapshot(), { observations: observations({ grades: [{
      ...common, observationId: "01k5fb9pg00000000000007103", deadlineId: "grade-low",
      title: "Ten-point retest", assignedGrade: 6, maxPoints: 10,
      gradeUpdatedAt: "2026-09-15T09:00:00.000Z", contentChangedAt: "2026-09-16T10:00:00.000Z",
    }] }) }, NOW);

    expect(low).toHaveLength(1);
    expect(low[0]?.citations[0]).toMatchObject({
      observedAt: "2026-09-15T09:00:00.000Z",
      course: "Chemistry",
      itemLabel: "Ten-point retest",
    });
    expect(low[0]?.citations[0]?.detail).toContain("60.0% (6/10)");
  });

  it("derives a cited missing-work signal and keeps it explicitly derived", () => {
    const signals = deriveStudySignals(snapshot(), { observations: observations({
      missingWork: [{
        transitionId: "01k5fb9pg00000000000007201", deadlineId: "missing-deadline",
        course: "Chemistry", title: "Untrusted lab title", dueAt: "2026-09-15T12:00:00.000Z",
        classification: "derived", state: "no_submission_seen",
        lastSeenAt: "2026-09-16T11:00:00.000Z", sourceLastSuccessAt: "2026-09-16T11:00:00.000Z",
        sourceLastFailure: null,
      }],
    }) }, NOW);

    expect(signals).toEqual([expect.objectContaining({
      courseName: "Chemistry", topic: null, score: 100,
      citations: [expect.objectContaining({
        sourceKey: "missing_work:01k5fb9pg00000000000007201",
        sourceRecordId: "01k5fb9pg00000000000007201",
        verification: "derived", observedAt: "2026-09-16T11:00:00.000Z",
      })],
    })]);
    expect(signals[0]?.topic).toBeNull();
    expect(signals[0]?.citations[0]?.itemLabel).toBe("Untrusted lab title");
  });

  it("ignores past deadlines and derives only near-due unfinished deadlines", () => {
    const past = deadline({ deadline: { ...deadline().deadline,
      deadlineId: "deadline-past", dueAt: "2026-09-16T10:00:00.000Z",
    } });
    const nearDue = deadline({ deadline: { ...deadline().deadline,
      deadlineId: "deadline-near", dueAt: "2026-09-17T12:00:00.000Z",
    } });
    const signals = deriveStudySignals(snapshot(), { deadlines: [past, nearDue] }, NOW);

    expect(signals.map((signal) => signal.citations[0]?.sourceRecordId))
      .toEqual(["deadline-near"]);
    expect(signals[0]?.outcome).toBe("uncertain");
    expect(signals.every((signal) => signal.topic === null)).toBe(true);
  });

  it("does not cite an open past deadline for a returned on-time Classroom grade", () => {
    const past = deadline({ deadline: { ...deadline().deadline,
      deadlineId: "deadline-returned", dueAt: "2026-09-15T12:00:00.000Z",
    } });
    const signals = deriveStudySignals(snapshot(), {
      deadlines: [past],
      observations: observations({ grades: [{
        observationId: "01k5fb9pg00000000000007111", deadlineId: "deadline-returned",
        course: "Chemistry", title: "Returned quiz", assignedGrade: 9, maxPoints: 10,
        gradeUpdatedAt: "2026-09-15T13:00:00.000Z", source: "google_classroom_api",
        contentChangedAt: "2026-09-16T10:00:00.000Z", lastSeenAt: "2026-09-16T11:00:00.000Z",
        sourceLastSuccessAt: "2026-09-16T11:00:00.000Z", sourceLastFailure: null,
      }] }),
    }, NOW);

    expect(signals).toEqual([]);
  });

  it("derives a topic-specific quiz signal from the existing cited outcome", () => {
    const signals = deriveStudySignals(snapshot([quizEvidence()]), {}, NOW);
    expect(signals[0]).toMatchObject({
      topic: "stoichiometry",
      outcome: "wrong",
      citations: [{
        sourceKind: "quiz_outcome",
        sourceRecordId: "01k5fb9pg00000000000007002",
        observedAt: "2026-09-16T10:00:00.000Z",
      }],
    });
  });

  it("returns no signal when every source is empty", () => {
    expect(deriveStudySignals(snapshot(), { observations: observations(), deadlines: [] }, NOW)).toEqual([]);
    expect(chooseStudyCheckIn([])).toBeNull();
  });

  it("labels stale and owner-reported source data instead of presenting it as current verified fact", () => {
    const staleGrade = observations({ grades: [{
      observationId: "01k5fb9pg00000000000007301", deadlineId: "grade-stale",
      course: "Chemistry", title: "Ignored", assignedGrade: 60,
      maxPoints: 100, gradeUpdatedAt: "2026-09-14T10:00:00.000Z",
      source: "google_classroom_api", contentChangedAt: "2026-09-14T10:00:00.000Z",
      lastSeenAt: "2026-09-14T10:00:00.000Z", sourceLastSuccessAt: "2026-09-14T10:00:00.000Z",
      sourceLastFailure: null,
    }] });
    const manual = deadline({
      sourceKind: "manual", sourceLastSuccessAt: null,
      deadline: { ...deadline().deadline, deadlineId: "manual-deadline" },
    });
    const signals = deriveStudySignals(snapshot(), { observations: staleGrade, deadlines: [manual] }, NOW);

    expect(signals.find((signal) => signal.citations[0]?.sourceKind === "verified_grade")?.citations[0])
      .toMatchObject({ verification: "verified", freshness: "stale" });
    expect(signals.find((signal) => signal.citations[0]?.sourceRecordId === "manual-deadline")?.citations[0])
      .toMatchObject({ verification: "owner_reported", freshness: "current" });
  });

  it("counts only same-topic evidence toward a topic target and keeps it tentative", () => {
    const inputs: SchoolObservationStudySnapshot = observations({ missingWork: [{
      transitionId: "01k5fb9pg00000000000007401", deadlineId: "missing-ranked",
      course: "Chemistry", title: "Ignored", dueAt: "2026-09-15T12:00:00.000Z",
      classification: "derived", state: "no_submission_seen",
      lastSeenAt: "2026-09-16T11:00:00.000Z", sourceLastSuccessAt: "2026-09-16T11:00:00.000Z",
      sourceLastFailure: null,
    }] });
    const signals = deriveStudySignals(snapshot([quizEvidence()]), {
      observations: inputs, deadlines: [deadline()],
    }, NOW);
    const chosen = chooseStudyCheckIn(signals);

    expect(chosen).toMatchObject({
      courseName: "Chemistry", topic: "stoichiometry", confidence: "low", evidenceCount: 1,
    });
    expect(chosen?.citations.map((point) => point.sourceKind))
      .toEqual(["quiz_outcome"]);
  });

  it("raises a stored evidence point only when it is due and has not already been prompted", () => {
    expect(deriveStudySignals(snapshot([quizEvidence({ practiceDueOn: "2026-09-17" })]), {
      today: "2026-09-16",
    }, NOW)).toEqual([]);
    expect(deriveStudySignals(snapshot([quizEvidence({ lastPromptedOn: "2026-09-16" })]), {
      today: "2026-09-16",
    }, NOW)).toEqual([]);
    expect(deriveStudySignals(snapshot([quizEvidence()]), { today: "2026-09-16" }, NOW)).toHaveLength(1);
  });

  it("does not attribute a deadline when contained course matching is ambiguous", () => {
    const ambiguous: StudyCoachSnapshot = {
      ...snapshot(),
      courses: [
        { ...snapshot().courses[0]!, name: "Chemistry Period 1" },
        { ...snapshot().courses[0]!, courseId: "01k5fb9pg00000000000007999" as Ulid, name: "Chemistry Period 2" },
      ],
    };
    const candidate = deadline({ deadline: { ...deadline().deadline, course: "Chemistry" } });
    expect(deriveStudySignals(ambiguous, { deadlines: [candidate] }, NOW)).toEqual([]);
  });
});
