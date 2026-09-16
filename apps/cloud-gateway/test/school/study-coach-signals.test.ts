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
      dueAt: "2026-09-16T10:00:00.000Z",
      effort: "other",
      leadMinutes: 60,
      status: "open",
      contentHash: "a".repeat(64),
      firstSeenAt: "2026-09-15T12:00:00.000Z",
      lastSeenAt: "2026-09-16T11:00:00.000Z",
      remindedAt: null,
    },
    sourceKind: "classroom",
    sourceLastSuccessAt: "2026-09-16T11:00:00.000Z",
    sourceLastFailure: null,
    ...overrides,
  };
}

describe("study weak-spot signal derivation", () => {
  it("derives low and falling grade signals while labelling the missing scale", () => {
    const signals = deriveStudySignals(snapshot(), { observations: observations({
      grades: [
        {
          observationId: "01k5fb9pg00000000000007101", deadlineId: "grade-latest",
          course: "Chemistry", title: "Do not infer stoichiometry from me", assignedGrade: 62,
          source: "google_classroom_api", contentChangedAt: "2026-09-16T10:00:00.000Z",
          lastSeenAt: "2026-09-16T11:00:00.000Z", sourceLastSuccessAt: "2026-09-16T11:00:00.000Z",
          sourceLastFailure: null,
        },
        {
          observationId: "01k5fb9pg00000000000007102", deadlineId: "grade-prior",
          course: "Chemistry", title: "Another untrusted title", assignedGrade: 78,
          source: "google_classroom_api", contentChangedAt: "2026-09-10T10:00:00.000Z",
          lastSeenAt: "2026-09-16T11:00:00.000Z", sourceLastSuccessAt: "2026-09-16T11:00:00.000Z",
          sourceLastFailure: null,
        },
      ],
    }) }, NOW);

    const gradeSignals = signals.filter((signal) => signal.citations[0]?.sourceKind === "verified_grade");
    expect(gradeSignals).toHaveLength(2);
    expect(gradeSignals.some((signal) => signal.citations.length === 2)).toBe(true);
    expect(gradeSignals.flatMap((signal) => signal.citations).map((point) => point.sourceRecordId))
      .toContain("01k5fb9pg00000000000007101");
    expect(gradeSignals[0]?.citations[0]?.detail).toMatch(/scale|weight/iu);
    expect(gradeSignals.every((signal) => signal.topic === null)).toBe(true);
    expect(JSON.stringify(gradeSignals)).not.toContain("Do not infer stoichiometry");
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
    expect(JSON.stringify(signals)).not.toContain("Untrusted lab title");
  });

  it("derives overdue and near-due deadline signals without using titles as topics", () => {
    const nearDue = deadline({ deadline: { ...deadline().deadline,
      deadlineId: "deadline-near", dueAt: "2026-09-17T12:00:00.000Z",
    } });
    const signals = deriveStudySignals(snapshot(), { deadlines: [deadline(), nearDue] }, NOW);

    expect(signals.map((signal) => signal.citations[0]?.sourceRecordId))
      .toEqual(["deadline-chemistry", "deadline-near"]);
    expect(signals[0]?.score).toBeGreaterThan(signals[1]?.score ?? 0);
    expect(signals.every((signal) => signal.topic === null)).toBe(true);
    expect(JSON.stringify(signals)).not.toContain("Untrusted worksheet title");
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

  it("ranks the strongest course signal while preserving the strongest topic-specific evidence", () => {
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

    expect(chosen).toMatchObject({ courseName: "Chemistry", topic: "stoichiometry", confidence: "high" });
    expect(chosen?.citations.map((point) => point.sourceKind))
      .toEqual(["derived_missing_work", "quiz_outcome", "deadline"]);
  });
});
