import type { Ulid } from "../../../../packages/contracts/src/index.js";

export type SchoolEvidenceSource = "owner_reported" | "platform_confirmed";
export type SchoolCourseFactKind = "missed_work" | "due_work" | "weak_area";
export type SchoolCourseFactStatus = "active" | "resolved";
export type SchoolCatchupActionStatus = "planned" | "completed" | "superseded";

export interface SchoolCourseFact {
  readonly factId: Ulid;
  readonly kind: SchoolCourseFactKind;
  readonly statement: string;
  readonly evidenceSource: SchoolEvidenceSource;
  readonly observedAt: string;
  readonly status: SchoolCourseFactStatus;
  readonly resolvedAt: string | null;
}

export interface SchoolCatchupAction {
  readonly actionId: Ulid;
  readonly courseId: Ulid;
  readonly courseName: string;
  readonly localDate: string;
  readonly sequenceRank: number;
  readonly text: string;
  readonly estimatedMinutes: number;
  readonly status: SchoolCatchupActionStatus;
}

export interface SchoolCourseCard {
  readonly courseId: Ulid;
  readonly name: string;
  readonly nameSource: "owner_reported";
  readonly platform: string | null;
  readonly platformSource: SchoolEvidenceSource | null;
  readonly ownerReportedFacts: readonly SchoolCourseFact[];
  readonly platformConfirmedFacts: readonly SchoolCourseFact[];
  readonly recentResolvedFacts: readonly SchoolCourseFact[];
  readonly currentNextAction: SchoolCatchupAction | null;
}

export interface SchoolCatchupSnapshot {
  readonly principalId: string;
  readonly courses: readonly SchoolCourseCard[];
}

export interface OwnerFactAddition {
  readonly kind: SchoolCourseFactKind;
  readonly statement: string;
}

export interface OwnerCourseUpdate {
  /** Existing course ULID or a response-local reference such as `new-1`. */
  readonly courseRef: string;
  readonly name: string | null;
  readonly platform: string | null;
  readonly addFacts: readonly OwnerFactAddition[];
  readonly resolveFactIds: readonly Ulid[];
}

export interface CatchupPlanAction {
  readonly courseRef: string;
  readonly localDate: string;
  readonly sequenceRank: number;
  readonly text: string;
  readonly estimatedMinutes: number;
}

export interface OwnerCatchupPlan {
  readonly engaged: boolean;
  readonly reply: string;
  readonly courseUpdates: readonly OwnerCourseUpdate[];
  readonly completeActionIds: readonly Ulid[];
  /** Full replacement for planned actions from `today` onward when engaged. */
  readonly plan: readonly CatchupPlanAction[];
}

export interface ApplyOwnerCatchupPlanInput {
  readonly principalId: string;
  readonly turnId: Ulid;
  readonly today: string;
  readonly responseHash: string;
  readonly plan: OwnerCatchupPlan;
  readonly now: Date;
}
