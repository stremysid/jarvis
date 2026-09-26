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
  /** Null when the source states no due date. The digest says so rather than guessing. */
  readonly dueAt: string | null;
  /** Fixed adapter label. Optional only for older fixture callers. */
  readonly source?: "Google Classroom" | "Brightspace calendar" | "D2L email" | "Manual" | "Brightspace";
}

export interface DigestProject {
  readonly projectId: string;
  readonly displayName: string;
  /** ISO instant of the most recent commit, or null when the poll failed. */
  readonly lastCommitAt: string | null;
  /** Fractional days since the last readable commit; null when there is none. */
  readonly daysSinceLastCommit: number | null;
  /** First lines of NEXT_STEPS.md. Untrusted repository text -- see below. */
  readonly nextStepsExcerpt: string | null;
  /** ISO days the NEXT_STEPS.md excerpt names, in the order the document wrote them. */
  readonly nextStepsDates: readonly string[];
  /** Date-shaped text in NEXT_STEPS.md this reader will not interpret. */
  readonly nextStepsUnreadable: readonly string[];
  /** The stored NEXT_STEPS.md excerpt is at its bound and may continue. */
  readonly nextStepsTruncated: boolean;
  /** Set when the most recent poll failed rather than succeeded. */
  readonly pollFailure: string | null;
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

export interface DigestUniversityWorkflow {
  readonly workflowId: string;
  readonly university: string;
  readonly programName: string;
  readonly label: string;
  readonly owner: "sid" | "referee" | "guidance" | "school" | "university";
  readonly status:
    | "prepared"
    | "owner_reported_done"
    | "owner_reported_not_done"
    | "owner_reported_offered"
    | "owner_reported_waitlisted"
    | "owner_reported_rejected"
    | "owner_reported_withdrawn"
    | "owner_reported_pending"
    | "owner_reported_satisfied"
    | "owner_reported_unsatisfied"
    | "owner_reported_accepted"
    | "owner_reported_declined"
    | "not_needed_by_sid";
  readonly dueDate: string | null;
  readonly dueAt: string | null;
  readonly dueTimeZone: string | null;
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
  readonly course: string;
  readonly itemLabel: string;
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
  readonly maxPoints: number | null;
  readonly gradeUpdatedAt: string | null;
  readonly source: "Google Classroom" | "D2L email";
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
  readonly universityWorkflowItems?: readonly DigestUniversityWorkflow[];
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
