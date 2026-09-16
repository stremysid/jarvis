export type SchoolSubmissionState =
  | "new"
  | "created"
  | "turned_in"
  | "returned"
  | "reclaimed"
  | "edited_after_turn_in";

export const SCHOOL_PROGRESS_ITEMS_PER_SWEEP = 48;

export interface RawSchoolSubmissionObservation {
  readonly externalId: string;
  readonly state: SchoolSubmissionState;
  readonly late: boolean | null;
  /** Provider update time when supplied. Absence stays null. */
  readonly sourceUpdatedAt: string | null;
}

export interface RawSchoolProgressItem {
  readonly externalId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly maximumPoints: number | null;
  readonly submission: RawSchoolSubmissionObservation | null;
  /** The assigned grade visible to the student. Draft grades are never stored. */
  readonly assignedPoints: number | null;
}

export interface SchoolProgressSourceState {
  readonly principalId: string;
  readonly sourceId: "google-classroom";
  readonly route: "classroom_api";
  readonly checkpointCourseId: string | null;
  readonly checkpointWorkItemExternalId: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailure: string | null;
  readonly lastFailureAt: string | null;
}

export interface SchoolGradeDigestItem {
  readonly workItemId: string;
  readonly course: string;
  readonly title: string;
  readonly assignedPoints: number;
  readonly maximumPoints: number | null;
  readonly source: "Google Classroom API";
  readonly observedAt: string;
  readonly sourceUpdatedAt: string | null;
}

export interface SchoolMissingWorkDigestItem {
  readonly workItemId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string;
  readonly source: "Google Classroom API";
  readonly checkedAt: string;
  readonly derivedAt: string;
  readonly label: "derived_no_submission_seen";
}

export interface SchoolProgressDigestSnapshot {
  readonly grades: readonly SchoolGradeDigestItem[];
  readonly missingWork: readonly SchoolMissingWorkDigestItem[];
  readonly sourceState: SchoolProgressSourceState | null;
}

export interface IngestSchoolProgressInput {
  readonly principalId: string;
  readonly sourceId: "google-classroom";
  readonly items: readonly RawSchoolProgressItem[];
  /** Last successfully processed course. Null restarts the bounded cycle. */
  readonly checkpointCourseId: string | null;
  /** Present while the bounded walk is still inside that course. */
  readonly checkpointWorkItemExternalId: string | null;
  /** Fixed health code for a bounded or partially rejected provider result. */
  readonly healthGap:
    | "classroom_progress_items_truncated"
    | "classroom_progress_items_rejected"
    | "classroom_progress_items_rejected_and_truncated"
    | null;
  readonly now: Date;
}
