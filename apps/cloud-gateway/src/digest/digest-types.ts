/**
 * What the digest reads, expressed as the digest's own narrow interfaces.
 *
 * The composer declares what it needs rather than importing the deadline,
 * project and decision repositories. That is not ceremony: the digest is the
 * one place every subsystem meets, and importing four concrete repositories
 * would make it the file that has to change whenever any of them does. It
 * also makes the composer testable without a database, which matters because
 * the interesting behaviour here is what it says when a source is missing --
 * and a fixture can be missing in ways a real repository cannot easily be
 * made to be.
 */

/** Which kind of message a suppression window applies to. */
export type MessageClass = "digest" | "reminder" | "business" | "error" | "payment";

export interface DigestDeadline {
  readonly deadlineId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string;
  readonly effort: "quiz" | "test" | "exam" | "essay" | "project" | "other";
}

export interface DigestProject {
  readonly projectId: string;
  readonly displayName: string;
  /** ISO instant of the most recent commit, or null when the poll failed. */
  readonly lastCommitAt: string | null;
  /** First lines of NEXT_STEPS.md. Untrusted repository text -- see below. */
  readonly nextStepsExcerpt: string | null;
  /** Set when the project is stalled, saying why. */
  readonly stalledReason: string | null;
  /** Set when the most recent poll failed rather than succeeded. */
  readonly pollFailure: string | null;
  /** Documents whose content changed since the previous successful poll. */
  readonly changedDocuments: readonly string[];
}

export interface DigestDecision {
  readonly decisionId: string;
  readonly question: string;
  readonly urgency: "urgent" | "normal";
}

export interface DigestCatchupAction {
  readonly actionId: string;
  readonly course: string;
  readonly text: string;
  readonly sequenceRank: number;
  readonly estimatedMinutes: number;
}

export interface DigestApplicationItem {
  readonly itemId: string;
  readonly university: string;
  readonly programName: string;
  readonly label: string;
  readonly status: "not_started" | "drafting" | "ready" | "submitted_by_sid" | "not_needed_by_sid";
  readonly dueDate: string | null;
  readonly verificationState: "verified" | "unverified";
}

export interface DigestStudyCheckIn {
  readonly course: string;
  readonly topic: string;
  readonly outcome: "uncertain" | "wrong";
  readonly evidenceCount: number;
  readonly confidence: "low" | "medium" | "high";
  readonly observedAt: string;
  readonly citations: readonly DigestStudySignalCitation[];
}

export interface DigestStudySignalCitation {
  readonly sourceKind: "verified_grade" | "derived_missing_work" | "deadline" | "quiz_outcome" | "owner_report" | "course_context";
  readonly sourceRecordId: string;
  readonly observedAt: string;
  readonly verification: "verified" | "derived" | "owner_reported" | "unverified";
  readonly freshness: "current" | "stale";
  readonly detail: string;
}

export interface DigestGradeObservation {
  readonly observationId: string;
  readonly course: string;
  readonly title: string;
  readonly assignedGrade: number;
  readonly source: "Google Classroom";
  readonly lastSeenAt: string;
}

export interface DigestDerivedMissingWork {
  readonly transitionId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string;
  readonly classification: "derived";
  readonly state: "no_submission_seen";
  readonly source: "Google Classroom";
  readonly lastSeenAt: string;
}

/**
 * A source that could not be read.
 *
 * Present in the digest deliberately. The plan's rule is that an empty or
 * failed fetch alerts rather than quietly reading as "nothing due" -- a digest
 * that omits a broken source is indistinguishable from one reporting a quiet
 * day, and that is the failure mode this whole design exists to avoid.
 */
export interface DigestGap {
  readonly source: string;
  readonly detail: string;
}

export interface DigestInput {
  readonly catchupActions: readonly DigestCatchupAction[];
  readonly applicationItems: readonly DigestApplicationItem[];
  readonly deadlines: readonly DigestDeadline[];
  readonly grades: readonly DigestGradeObservation[];
  readonly missingWork: readonly DigestDerivedMissingWork[];
  readonly missingWorkOmitted: number;
  readonly projects: readonly DigestProject[];
  readonly decisions: readonly DigestDecision[];
  readonly gaps: readonly DigestGap[];
  readonly studyCheckIn?: DigestStudyCheckIn | null;
}

export interface DigestSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

export interface Digest {
  readonly kind: "daily" | "retro";
  /** The local day the digest speaks about, as YYYY-MM-DD in the owner's zone. */
  readonly localDate: string;
  readonly sections: readonly DigestSection[];
  /** True when content was dropped to fit the channel's limit. */
  readonly truncated: boolean;
  readonly text: string;
}
