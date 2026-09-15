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

export interface OwnerUniversityPlan {
  readonly engaged: boolean;
  readonly programUpdates: readonly OwnerUniversityProgramUpdate[];
  readonly applicationUpdates: readonly OwnerUniversityApplicationUpdate[];
}

export interface ApplyOwnerUniversityPlanInput {
  readonly principalId: string;
  readonly turnId: Ulid;
  readonly responseHash: string;
  readonly plan: OwnerUniversityPlan;
  readonly now: Date;
}
