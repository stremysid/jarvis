import type { Ulid } from "../../../../packages/contracts/src/index.js";

export type UniversityVerificationState = "verified" | "unverified";
export type UniversityTrackerItemKind = "requirement" | "date";
export type UniversityApplicationItemKind =
  | "supplementary_application"
  | "essay"
  | "personal_statement"
  | "reference"
  | "transcript"
  | "scholarship";
export type UniversityApplicationItemStatus =
  | "not_started"
  | "drafting"
  | "ready"
  | "submitted_by_sid"
  | "not_needed_by_sid";
export type UniversityWorkflowKind =
  | "submission_step"
  | "upload_step"
  | "contact_step"
  | "signup_step"
  | "payment_step"
  | "transcript_order_step"
  | "offer"
  | "offer_condition"
  | "offer_response";
export type UniversityWorkflowOwner = "sid" | "referee" | "guidance" | "school" | "university";
export type UniversityWorkflowStatus =
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

export interface UniversityVerification {
  readonly state: UniversityVerificationState;
  readonly sourceUrl: string | null;
  readonly cycle: string | null;
  readonly verifiedAt: string | null;
}

export interface UniversityTrackerItem {
  readonly itemId: Ulid;
  readonly kind: UniversityTrackerItemKind;
  readonly label: string;
  readonly detail: string | null;
  readonly date: string | null;
  readonly verification: UniversityVerification;
}

export interface UniversityApplicationItem {
  readonly itemId: Ulid;
  readonly kind: UniversityApplicationItemKind;
  readonly label: string;
  readonly status: UniversityApplicationItemStatus;
  readonly dueDate: string | null;
  readonly verification: UniversityVerification;
  readonly sourceTurnId: Ulid;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
}

export interface UniversityApplicationDigestItem extends UniversityApplicationItem {
  readonly university: string;
  readonly programName: string;
}

export interface UniversityWorkflowDeadline {
  readonly date: string | null;
  readonly instant: string | null;
  readonly timeZone: string | null;
  readonly verification: UniversityVerification;
}

export interface UniversityWorkflowItem {
  readonly workflowId: Ulid;
  readonly eventId: Ulid;
  readonly revision: number;
  readonly applicationItemId: Ulid | null;
  readonly kind: UniversityWorkflowKind;
  readonly label: string;
  readonly owner: UniversityWorkflowOwner;
  readonly status: UniversityWorkflowStatus;
  /** Generated drafts and imported text remain untrusted display data. */
  readonly preparedDetails: string | null;
  readonly executionBoundary: "owner_only";
  readonly deadline: UniversityWorkflowDeadline;
  readonly sourceTurnId: Ulid;
  readonly updatedAt: string;
}

export interface UniversityWorkflowDigestItem extends UniversityWorkflowItem {
  readonly university: string;
  readonly programName: string;
}

export interface UniversityProgram {
  readonly programId: Ulid;
  readonly university: string;
  readonly campus: string | null;
  readonly programName: string;
  readonly ouacCode: string | null;
  readonly verification: UniversityVerification;
  readonly requirements: readonly UniversityTrackerItem[];
  readonly dates: readonly UniversityTrackerItem[];
  readonly applicationItems: readonly UniversityApplicationItem[];
  /** Absent only on snapshots produced by pre-step-6 callers. */
  readonly workflowItems?: readonly UniversityWorkflowItem[];
}

export interface UniversityTrackerSnapshot {
  readonly principalId: string;
  readonly programs: readonly UniversityProgram[];
}

export interface OwnerUniversityVerification {
  readonly state: UniversityVerificationState;
  readonly sourceUrl: string | null;
  readonly cycle: string | null;
}

export interface OwnerUniversityRequirementAddition {
  readonly label: string;
  readonly detail: string;
  readonly verification: OwnerUniversityVerification;
}

export interface OwnerUniversityDateAddition {
  readonly label: string;
  readonly date: string | null;
  readonly verification: OwnerUniversityVerification;
}

export interface OwnerUniversityProgramUpdate {
  /** Existing program ULID or a response-local reference such as `new-1`. */
  readonly programRef: string;
  readonly university: string | null;
  readonly campus: string | null;
  readonly programName: string | null;
  readonly ouacCode: string | null;
  readonly verification: OwnerUniversityVerification | null;
  readonly addRequirements: readonly OwnerUniversityRequirementAddition[];
  readonly addDates: readonly OwnerUniversityDateAddition[];
  readonly resolveItemIds: readonly Ulid[];
}

export interface OwnerApplicationDueDateUpdate {
  readonly date: string | null;
  readonly verification: OwnerUniversityVerification;
  /** Exact current-owner text supporting either the supplied date or its absence. */
  readonly evidence: string;
}

export interface OwnerUniversityApplicationUpdate {
  /** Existing item ULID or a response-local reference such as `new-item-1`. */
  readonly itemRef: string;
  /** Existing program ULID or a response-local program reference from this response. */
  readonly programRef: string;
  readonly kind: UniversityApplicationItemKind | null;
  readonly label: string | null;
  readonly status: UniversityApplicationItemStatus | null;
  /** Exact current-owner text supporting a status change. */
  readonly statusEvidence: string | null;
  readonly dueDate: OwnerApplicationDueDateUpdate | null;
}

export interface OwnerUniversityWorkflowDeadlineUpdate {
  readonly date: string | null;
  readonly instant: string | null;
  readonly timeZone: string | null;
  readonly verification: OwnerUniversityVerification;
  /** Exact current-owner text supporting the deadline or its absence. */
  readonly evidence: string;
}

export interface OwnerUniversityWorkflowUpdate {
  /** Existing workflow ULID or a response-local reference such as `new-workflow-1`. */
  readonly workflowRef: string;
  /** Existing program ULID or a response-local program reference from this response. */
  readonly programRef: string;
  /** Existing application item ULID, a same-response item reference, or null for offer records. */
  readonly applicationItemRef: string | null;
  readonly kind: UniversityWorkflowKind | null;
  readonly label: string | null;
  readonly owner: UniversityWorkflowOwner | null;
  readonly status: UniversityWorkflowStatus | null;
  /** Exact current-owner text supporting a status change. */
  readonly statusEvidence: string | null;
  readonly preparedDetails: string | null;
  readonly deadline: OwnerUniversityWorkflowDeadlineUpdate | null;
  /** This literal is mandatory so model output cannot request execution. */
  readonly executionBoundary: "owner_only";
}

export interface OwnerUniversityPlan {
  readonly engaged: boolean;
  readonly programUpdates: readonly OwnerUniversityProgramUpdate[];
  readonly applicationUpdates: readonly OwnerUniversityApplicationUpdate[];
  readonly workflowUpdates: readonly OwnerUniversityWorkflowUpdate[];
}

export interface ApplyOwnerUniversityPlanInput {
  readonly principalId: string;
  readonly turnId: Ulid;
  readonly responseHash: string;
  readonly plan: Omit<OwnerUniversityPlan, "workflowUpdates"> & {
    /** Older direct repository callers have no workflow mutations. */
    readonly workflowUpdates?: readonly OwnerUniversityWorkflowUpdate[];
  };
  readonly now: Date;
}
