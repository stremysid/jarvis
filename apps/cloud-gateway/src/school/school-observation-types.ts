/** Structured school data from the approved read-only Classroom route. */

export type SchoolSubmissionState =
  | "new"
  | "created"
  | "turned_in"
  | "returned"
  | "reclaimed_by_student"
  | "student_edited_after_turn_in";

export type DerivedMissingWorkState =
  | "not_due"
  | "no_submission_seen"
  | "submission_seen"
  | "closed";

/**
 * One normalized API observation before it reaches D1.
 *
 * Course, title and due time are deliberately absent. They come from the
 * existing verified Classroom deadline row, so an observation cannot invent
 * any of them or smuggle source text into a second authority path.
 */
export interface RawSchoolSubmissionObservation {
  readonly deadlineExternalId: string;
  readonly externalSubmissionId: string;
  readonly state: SchoolSubmissionState;
  readonly late: boolean | null;
  readonly assignedGrade: number | null;
  readonly sourceUpdatedAt: string | null;
}

export interface SchoolObservationSyncState {
  readonly principalId: string;
  readonly sourceId: string;
  readonly checkpointCourseId: string | null;
  readonly checkpointPageToken: string | null;
  readonly scanStartedAt: string | null;
  readonly derivationScanAt: string | null;
  readonly derivationStartedAt: string | null;
  readonly derivationAfterDeadlineId: string | null;
  readonly lastBatchAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastSuccessStartedAt: string | null;
  readonly lastFailure: string | null;
  readonly lastFailureAt: string | null;
}

export interface SchoolGradeObservation {
  readonly observationId: string;
  readonly deadlineId: string;
  readonly course: string;
  readonly title: string;
  /** Classroom's assigned grade exactly as supplied. No denominator or weight is inferred. */
  readonly assignedGrade: number;
  readonly source: "google_classroom_api";
  readonly contentChangedAt: string;
  readonly lastSeenAt: string;
}

export interface SchoolDerivedMissingWork {
  readonly transitionId: string;
  readonly deadlineId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string;
  readonly classification: "derived";
  readonly state: "no_submission_seen";
  /** When Classroom was actually read as showing no submitted work. */
  readonly lastSeenAt: string;
}

export interface SchoolObservationDigestSnapshot {
  readonly source: SchoolObservationSyncState | null;
  readonly grades: readonly SchoolGradeObservation[];
  readonly missingWork: readonly SchoolDerivedMissingWork[];
  /** Matching missing-work rows beyond the bounded digest page. */
  readonly missingWorkOmitted: number;
}
