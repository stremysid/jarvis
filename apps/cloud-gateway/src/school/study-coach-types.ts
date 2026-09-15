import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { SchoolCourseFactKind, SchoolEvidenceSource } from "./school-catchup-types.js";

export type StudyOutcome = "easy" | "uncertain" | "wrong";
export type StudyEvidenceKind = "owner_statement" | "course_context" | "practice_result";
export type StudyConfidence = "low" | "medium" | "high";
export type StudyPracticeMode = "quiz" | "flashcard";

export interface StudyCourseFactSource {
  readonly factId: Ulid;
  readonly kind: SchoolCourseFactKind;
  readonly statement: string;
  readonly evidenceSource: SchoolEvidenceSource;
  readonly observedAt: string;
}

export interface StudyEvidencePoint {
  readonly evidenceId: Ulid;
  readonly topic: string;
  readonly topicKey: string;
  readonly outcome: StudyOutcome;
  readonly evidenceKind: StudyEvidenceKind;
  readonly evidenceText: string;
  readonly confidence: StudyConfidence;
  readonly observedAt: string;
  readonly practiceDueOn: string;
  readonly lastPromptedOn: string | null;
}

export interface StudyTopicSummary {
  readonly topic: string;
  readonly topicKey: string;
  readonly evidence: readonly StudyEvidencePoint[];
  /** One weak signal stays tentative regardless of that point's source confidence. */
  readonly judgement: "tentative" | "supported" | "strong";
  readonly confidence: StudyConfidence;
}

export interface StudyCourseSnapshot {
  readonly courseId: Ulid;
  readonly name: string;
  readonly facts: readonly StudyCourseFactSource[];
  readonly topics: readonly StudyTopicSummary[];
}

export interface StudyPreference {
  readonly enabled: boolean;
  /** Sunday is bit 0 and Saturday is bit 6, matching Date.getDay(). */
  readonly allowedDaysMask: number;
  readonly quietStartMinute: number;
  readonly quietEndMinute: number;
}

export interface StudyPracticeItem {
  readonly itemId: Ulid;
  readonly practiceId: Ulid;
  readonly courseId: Ulid;
  readonly courseName: string;
  readonly mode: StudyPracticeMode;
  readonly position: number;
  readonly question: string;
  readonly answer: string;
  readonly answerSupport: "supported" | "uncertain";
  readonly sourceKind: "owner_topic" | "course_fact";
  readonly sourceExcerpt: string;
  readonly sourceObservedAt: string;
}

export interface StudyCoachSnapshot {
  readonly principalId: string;
  readonly courses: readonly StudyCourseSnapshot[];
  readonly preference: StudyPreference;
  readonly activeQuiz: StudyPracticeItem | null;
}

export interface StudyCheckIn {
  readonly courseName: string;
  readonly topic: string;
  readonly outcome: "uncertain" | "wrong";
  readonly evidenceCount: number;
  readonly confidence: StudyConfidence;
  readonly observedAt: string;
}

export interface GeneratedPracticeItem {
  readonly question: string;
  readonly answer: string;
  readonly sourceQuote: string;
}

export type PracticeSource =
  | {
    readonly kind: "owner_topic";
    readonly turnId: Ulid;
    readonly excerpt: string;
    readonly observedAt: string;
  }
  | {
    readonly kind: "course_fact";
    readonly factId: Ulid;
    readonly excerpt: string;
    readonly observedAt: string;
  };
