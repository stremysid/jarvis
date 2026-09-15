import type { Ulid } from "../../../../packages/contracts/src/index.js";

export type UniversityVerificationState = "verified" | "unverified";
export type UniversityTrackerItemKind = "requirement" | "date";

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

export interface UniversityProgram {
  readonly programId: Ulid;
  readonly university: string;
  readonly campus: string | null;
  readonly programName: string;
  readonly ouacCode: string | null;
  readonly verification: UniversityVerification;
  readonly requirements: readonly UniversityTrackerItem[];
  readonly dates: readonly UniversityTrackerItem[];
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

export interface OwnerUniversityPlan {
  readonly engaged: boolean;
  readonly programUpdates: readonly OwnerUniversityProgramUpdate[];
}

export interface ApplyOwnerUniversityPlanInput {
  readonly principalId: string;
  readonly turnId: Ulid;
  readonly responseHash: string;
  readonly plan: OwnerUniversityPlan;
  readonly now: Date;
}
