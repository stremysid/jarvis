import type { StudyDeadlineCandidate } from "../deadlines/deadline-types.js";
import type { SchoolObservationStudySnapshot } from "./school-observation-types.js";
import type {
  StudyCheckIn,
  StudyCoachSnapshot,
  StudyConfidence,
  StudyCourseSnapshot,
  StudySignalCitation,
  StudySignalFreshness,
  StudySignalVerification,
  StudyWeakSpotSignal,
} from "./study-coach-types.js";

const SCHOOL_SOURCE_STALE_AFTER_MS = 12 * 60 * 60 * 1_000;
const DEADLINE_SOURCE_STALE_AFTER_MS = 3 * 60 * 60 * 1_000;
const LOW_GRADE_SIGNAL_MAXIMUM = 70;
const FALLING_GRADE_MINIMUM_DROP = 5;
const MAX_SIGNALS = 64;
export const MAX_CHECK_IN_CITATIONS = 4;

export interface StudySignalInputs {
  readonly observations?: SchoolObservationStudySnapshot | null;
  readonly deadlines?: readonly StudyDeadlineCandidate[];
}

export type StudyCheckInSelection = Omit<StudyCheckIn, "claimedAt">;

function normalizedPhrase(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-CA")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function phraseContains(left: string, right: string): boolean {
  return left === right || ` ${left} `.includes(` ${right} `) || ` ${right} `.includes(` ${left} `);
}

function matchCourse(courses: readonly StudyCourseSnapshot[], value: string): StudyCourseSnapshot | null {
  const key = normalizedPhrase(value);
  if (key.length < 3) return null;
  const exact = courses.filter((course) => normalizedPhrase(course.name) === key);
  if (exact.length === 1) return exact[0]!;
  const contained = courses.filter((course) => phraseContains(normalizedPhrase(course.name), key));
  return contained.length === 1 ? contained[0]! : null;
}

function freshness(
  lastSuccessAt: string | null,
  failure: string | null,
  now: Date,
  maximumAgeMs: number,
): StudySignalFreshness {
  if (failure !== null || lastSuccessAt === null) return "stale";
  const observed = Date.parse(lastSuccessAt);
  const age = now.getTime() - observed;
  return Number.isFinite(observed) && age >= 0 && age <= maximumAgeMs ? "current" : "stale";
}

function citation(input: StudySignalCitation): StudySignalCitation {
  return Object.freeze(input);
}

function signal(input: StudyWeakSpotSignal): StudyWeakSpotSignal {
  return Object.freeze({ ...input, citations: Object.freeze([...input.citations]) });
}

function scoreConfidence(score: number): StudyConfidence {
  return score >= 90 ? "high" : score >= 70 ? "medium" : "low";
}

function evidenceSignals(snapshot: StudyCoachSnapshot): StudyWeakSpotSignal[] {
  const signals: StudyWeakSpotSignal[] = [];
  for (const course of snapshot.courses) {
    for (const topic of course.topics) {
      for (const point of topic.evidence) {
        if (point.outcome === "easy") continue;
        const base = point.evidenceKind === "practice_result"
          ? point.outcome === "wrong" ? 82 : 68
          : point.evidenceKind === "owner_statement"
            ? point.outcome === "wrong" ? 76 : 64
            : 58;
        const score = Math.min(100, base + (topic.judgement === "strong" ? 12 : topic.judgement === "supported" ? 6 : 0));
        const fact = course.facts.find((candidate) => candidate.factId === point.sourceRecordId);
        const verification: StudySignalVerification = point.evidenceKind === "practice_result"
          ? "verified"
          : point.evidenceKind === "owner_statement"
            ? "owner_reported"
            : fact?.evidenceSource === "platform_confirmed" ? "verified" : "owner_reported";
        const sourceKind = point.evidenceKind === "practice_result"
          ? "quiz_outcome" as const
          : point.evidenceKind === "owner_statement" ? "owner_report" as const : "course_context" as const;
        const detail = point.evidenceKind === "practice_result"
          ? `A source-supported quiz answer was ${point.outcome}.`
          : point.evidenceKind === "owner_statement"
            ? `Sid reported this topic as ${point.outcome}.`
            : `The active course card names this as a weak area.`;
        signals.push(signal({
          courseId: course.courseId,
          courseName: course.name,
          topic: point.topic,
          outcome: point.outcome,
          confidence: topic.confidence,
          score,
          observedAt: point.observedAt,
          citations: [citation({
            sourceKey: `evidence:${point.evidenceId}`,
            sourceKind,
            sourceRecordId: point.sourceRecordId,
            observedAt: point.observedAt,
            verification,
            freshness: "current",
            detail,
          })],
        }));
      }
    }
  }
  return signals;
}

function gradeSignals(
  courses: readonly StudyCourseSnapshot[],
  observations: SchoolObservationStudySnapshot,
  now: Date,
): StudyWeakSpotSignal[] {
  const signals: StudyWeakSpotSignal[] = [];
  const byCourse = new Map<string, Array<{ readonly course: StudyCourseSnapshot; readonly index: number }>>();
  for (const [index, grade] of observations.grades.entries()) {
    const course = matchCourse(courses, grade.course);
    if (course === null) continue;
    const currentFreshness = freshness(
      grade.sourceLastSuccessAt, grade.sourceLastFailure, now, SCHOOL_SOURCE_STALE_AFTER_MS,
    );
    const point = citation({
      sourceKey: `grade:${grade.observationId}`,
      sourceKind: "verified_grade",
      sourceRecordId: grade.observationId,
      observedAt: grade.lastSeenAt,
      verification: "verified",
      freshness: currentFreshness,
      detail: `Google Classroom assigned grade ${String(grade.assignedGrade)}. Scale and weight are not supplied, so a low interpretation is tentative.`,
    });
    if (grade.assignedGrade <= LOW_GRADE_SIGNAL_MAXIMUM && grade.assignedGrade <= 100) {
      const score = currentFreshness === "current" ? 72 : 38;
      signals.push(signal({
        courseId: course.courseId, courseName: course.name, topic: null,
        outcome: "uncertain", confidence: scoreConfidence(score), score,
        observedAt: grade.lastSeenAt, citations: [point],
      }));
    }
    const entries = byCourse.get(course.courseId) ?? [];
    entries.push({ course, index });
    byCourse.set(course.courseId, entries);
  }
  for (const entries of byCourse.values()) {
    const ordered = entries.map(({ course, index }) => ({ course, grade: observations.grades[index]! }))
      .sort((left, right) => right.grade.contentChangedAt.localeCompare(left.grade.contentChangedAt));
    const latest = ordered[0];
    const previous = ordered[1];
    if (latest === undefined || previous === undefined
      || previous.grade.assignedGrade - latest.grade.assignedGrade < FALLING_GRADE_MINIMUM_DROP) continue;
    const currentFreshness = freshness(
      latest.grade.sourceLastSuccessAt, latest.grade.sourceLastFailure, now, SCHOOL_SOURCE_STALE_AFTER_MS,
    );
    const citations = [latest.grade, previous.grade].map((grade) => citation({
      sourceKey: `grade:${grade.observationId}`,
      sourceKind: "verified_grade",
      sourceRecordId: grade.observationId,
      observedAt: grade.lastSeenAt,
      verification: "verified",
      freshness: currentFreshness,
      detail: `Google Classroom assigned grade ${String(grade.assignedGrade)}. Cross-assignment scales and weights are not supplied.`,
    }));
    const score = currentFreshness === "current" ? 84 : 46;
    signals.push(signal({
      courseId: latest.course.courseId, courseName: latest.course.name, topic: null,
      outcome: "uncertain", confidence: scoreConfidence(score), score,
      observedAt: latest.grade.lastSeenAt, citations,
    }));
  }
  return signals;
}

function missingWorkSignals(
  courses: readonly StudyCourseSnapshot[],
  observations: SchoolObservationStudySnapshot,
  now: Date,
): StudyWeakSpotSignal[] {
  return observations.missingWork.flatMap((item) => {
    const course = matchCourse(courses, item.course);
    if (course === null) return [];
    const currentFreshness = freshness(
      item.sourceLastSuccessAt, item.sourceLastFailure, now, SCHOOL_SOURCE_STALE_AFTER_MS,
    );
    const score = currentFreshness === "current" ? 100 : 62;
    return [signal({
      courseId: course.courseId, courseName: course.name, topic: null,
      outcome: "wrong", confidence: scoreConfidence(score), score,
      observedAt: item.lastSeenAt,
      citations: [citation({
        sourceKey: `missing_work:${item.transitionId}`,
        sourceKind: "derived_missing_work",
        sourceRecordId: item.transitionId,
        observedAt: item.lastSeenAt,
        verification: "derived",
        freshness: currentFreshness,
        detail: "Google Classroom showed no submission after the deadline. This is derived, not a confirmed miss.",
      })],
    })];
  });
}

function deadlineSignals(
  courses: readonly StudyCourseSnapshot[],
  deadlines: readonly StudyDeadlineCandidate[],
  now: Date,
): StudyWeakSpotSignal[] {
  return deadlines.flatMap((item) => {
    const course = matchCourse(courses, item.deadline.course);
    if (course === null) return [];
    const due = Date.parse(item.deadline.dueAt);
    if (!Number.isFinite(due)) return [];
    const hours = (due - now.getTime()) / 3_600_000;
    const currentFreshness = item.sourceKind === "manual"
      ? "current"
      : freshness(item.sourceLastSuccessAt, item.sourceLastFailure, now, DEADLINE_SOURCE_STALE_AFTER_MS);
    const base = hours < 0 ? 92 : 52;
    const score = Math.max(20, base - (currentFreshness === "stale" ? 35 : 0));
    const verification: StudySignalVerification = item.sourceKind === "manual" ? "owner_reported" : "verified";
    const timing = hours < 0
      ? `The open deadline was overdue as of ${now.toISOString().slice(0, 10)}.`
      : `The open deadline is due within ${Math.max(1, Math.ceil(hours))} hours.`;
    return [signal({
      courseId: course.courseId, courseName: course.name, topic: null,
      outcome: hours < 0 ? "wrong" : "uncertain", confidence: scoreConfidence(score), score,
      observedAt: item.deadline.lastSeenAt,
      citations: [citation({
        sourceKey: `deadline:${item.deadline.deadlineId}`,
        sourceKind: "deadline",
        sourceRecordId: item.deadline.deadlineId,
        observedAt: item.deadline.lastSeenAt,
        verification,
        freshness: currentFreshness,
        detail: timing,
      })],
    })];
  });
}

function ordered(signals: readonly StudyWeakSpotSignal[]): StudyWeakSpotSignal[] {
  return [...signals].sort((left, right) => right.score - left.score
    || right.observedAt.localeCompare(left.observedAt)
    || left.courseName.localeCompare(right.courseName)
    || left.citations[0]!.sourceKey.localeCompare(right.citations[0]!.sourceKey));
}

export function deriveStudySignals(
  snapshot: StudyCoachSnapshot,
  inputs: StudySignalInputs,
  nowValue: Date,
): readonly StudyWeakSpotSignal[] {
  const now = new Date(nowValue.getTime());
  if (!Number.isFinite(now.getTime())) throw new TypeError("study_signal_time_invalid");
  const observations = inputs.observations ?? { grades: [], missingWork: [] };
  return Object.freeze(ordered([
    ...evidenceSignals(snapshot),
    ...gradeSignals(snapshot.courses, observations, now),
    ...missingWorkSignals(snapshot.courses, observations, now),
    ...deadlineSignals(snapshot.courses, inputs.deadlines ?? [], now),
  ]).slice(0, MAX_SIGNALS));
}

export function chooseStudyCheckIn(
  signals: readonly StudyWeakSpotSignal[],
  retiredSourceKeys: ReadonlySet<string> = new Set(),
): StudyCheckInSelection | null {
  const candidates = ordered(signals.filter((candidate) =>
    candidate.citations.every((point) => !retiredSourceKeys.has(point.sourceKey))));
  const primary = candidates[0];
  if (primary === undefined) return null;
  const topicSignal = primary.topic === null
    ? candidates.find((candidate) => candidate.courseId === primary.courseId && candidate.topic !== null)
    : primary;
  const selectedTopic = topicSignal?.topic ?? null;
  const sameCourse = candidates.filter((candidate) => candidate.courseId === primary.courseId
    && (candidate.topic === null || candidate.topic === selectedTopic));
  const citations: StudySignalCitation[] = [];
  const seen = new Set<string>();
  for (const candidate of [primary, ...(topicSignal === undefined ? [] : [topicSignal]), ...sameCourse]) {
    for (const point of candidate.citations) {
      if (seen.has(point.sourceKey)) continue;
      seen.add(point.sourceKey);
      citations.push(point);
      if (citations.length === MAX_CHECK_IN_CITATIONS) break;
    }
    if (citations.length === MAX_CHECK_IN_CITATIONS) break;
  }
  const confidence: StudyConfidence = primary.topic !== null
    ? primary.confidence
    : primary.score >= 90 && citations.length >= 2
      ? "high" : primary.score >= 70 || citations.length >= 2 ? "medium" : "low";
  return Object.freeze({
    courseId: primary.courseId,
    courseName: primary.courseName,
    topic: topicSignal?.topic ?? `${primary.courseName} review`,
    outcome: primary.outcome,
    evidenceCount: citations.length,
    confidence,
    observedAt: citations.reduce((latest, point) => point.observedAt > latest ? point.observedAt : latest, citations[0]!.observedAt),
    citations: Object.freeze(citations),
  });
}
