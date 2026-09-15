import type { Sha256Hex, Ulid } from "../../../../packages/contracts/src/index.js";

export const MEMORY_ROOT_DISPLAY_NAME = "Memory";
export const MEMORY_INBOX_DISPLAY_NAME = "Inbox / Needs filing";
export const MEMORY_TOPIC_REDIRECT_LIMIT = 64;

export type MemoryKind = "fact" | "preference" | "plan" | "decision" | "relationship";
export type MemoryBasis = "stated" | "confirmed" | "observed" | "inferred" | "third_party";
export type MemoryOrigin =
  | "authenticated_first_person"
  | "deterministic_observation"
  | "model"
  | "third_party";
export type MemorySensitivity = "normal" | "sensitive";
export type MemoryLifecycleState =
  | "proposed"
  | "active"
  | "rejected"
  | "superseded"
  | "forgotten"
  | "expired";
export type MemorySourceLocation = "live" | "archived";
export type MemorySourceChannel = "telegram" | "voice" | "system";
export type MemoryFilingSource = "rule" | "model";

export type MemoryRepositoryErrorCode =
  | "memory_ambiguous"
  | "memory_corrupt"
  | "memory_not_found"
  | "memory_refused"
  | "memory_unavailable";

/** Stable public failure. D1 diagnostics remain inside the repository boundary. */
export class MemoryRepositoryError extends Error {
  constructor(readonly code: MemoryRepositoryErrorCode) {
    super(code);
    this.name = "MemoryRepositoryError";
  }
}

export interface InitialMemorySourceInput {
  readonly sourceId: Ulid;
  readonly eventId: Ulid;
  readonly eventSequence: number;
  readonly sourceLocation: MemorySourceLocation;
  readonly r2SegmentId: Sha256Hex | null;
  readonly excerpt: string;
  readonly excerptHash: Sha256Hex;
  readonly channel: MemorySourceChannel;
  readonly occurredAt: string;
}

export interface InitialMemoryVersionInput {
  readonly versionId: Ulid;
  readonly text: string;
  readonly textHash: Sha256Hex;
  readonly basis: MemoryBasis;
  readonly origin: MemoryOrigin;
  readonly uncertain: boolean;
  readonly sensitivity: MemorySensitivity;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly extractorVersion: string;
  readonly extractorModelId: string | null;
}

export interface CommitInitialMemoryInput {
  readonly principalId: string;
  readonly itemId: Ulid;
  readonly kind: MemoryKind;
  readonly creationEventId: Ulid;
  readonly creationEventSequence: number;
  readonly version: InitialMemoryVersionInput;
  readonly sources: readonly InitialMemorySourceInput[];
  readonly transition: Readonly<{
    transitionId: Ulid;
    lifecycleState: "proposed" | "active";
    reason: string;
    policyVersion: string;
  }>;
  readonly placement: Readonly<{
    placementId: Ulid;
    placementEventId: Ulid;
    topicId: Ulid;
    filingSource: MemoryFilingSource;
    confidence: number;
    reason: string;
  }>;
}

export interface CanonicalMemorySource {
  readonly sourceId: Ulid;
  readonly position: number;
  readonly eventId: Ulid;
  readonly eventSequence: number;
  readonly sourceLocation: MemorySourceLocation;
  readonly r2SegmentId: Sha256Hex | null;
  readonly excerpt: string;
  readonly excerptHash: Sha256Hex;
  readonly channel: MemorySourceChannel;
  readonly occurredAt: string;
  readonly createdAt: string;
}

export interface CanonicalTopicPathEntry {
  readonly topicId: Ulid;
  readonly displayName: string;
}

export interface CanonicalMemoryItem {
  readonly principalId: string;
  readonly itemId: Ulid;
  readonly kind: MemoryKind;
  readonly creationEventId: Ulid;
  readonly creationEventSequence: number;
  readonly createdAt: string;
  readonly version: Readonly<{
    versionId: Ulid;
    versionNumber: number;
    text: string;
    textHash: Sha256Hex;
    basis: MemoryBasis;
    origin: MemoryOrigin;
    uncertain: boolean;
    sensitivity: MemorySensitivity;
    validFrom: string | null;
    validTo: string | null;
    extractorVersion: string;
    extractorModelId: string | null;
    createdAt: string;
  }>;
  readonly lifecycle: Readonly<{
    state: MemoryLifecycleState;
    transitionId: Ulid;
    transitionNumber: number;
    actor: "owner" | "rules";
    reason: string;
    policyVersion: string;
    ownerAuthorizingEventId: Ulid | null;
    occurredAt: string;
  }>;
  readonly sources: readonly CanonicalMemorySource[];
  readonly primaryPlacement: Readonly<{
    placementId: Ulid;
    topicId: Ulid;
    filingSource: "owner" | MemoryFilingSource;
    confidence: number;
    reason: string;
    updatedAt: string;
  }>;
  readonly topicPath: readonly CanonicalTopicPathEntry[];
}

export interface CommitInitialMemoryResult {
  readonly item: CanonicalMemoryItem;
  readonly replayed: boolean;
}

export interface BootstrapMemoryTopicsResult {
  readonly root: CanonicalTopicPathEntry;
  readonly inbox: CanonicalTopicPathEntry;
  readonly replayed: boolean;
}

export interface ResolvedMemoryTopic {
  readonly topicId: Ulid;
  readonly path: readonly CanonicalTopicPathEntry[];
  readonly matchedBy: "current" | "alias";
}
