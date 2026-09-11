import type { Sha256Hex, Ulid } from "./ids.js";

export type MemoryFactOriginV1 =
  | "authenticated_first_person"
  | "deterministic_observation"
  | "model"
  | "third_party";

export type MemoryFactSensitivityV1 = "normal" | "sensitive";

export interface MemoryFactSourceV1 {
  readonly eventId: Ulid;
  readonly eventSequence: number;
  readonly excerpt: string;
}

export interface MemoryFactProjectionV1 {
  readonly factId: string;
  readonly text: string;
  readonly origin: MemoryFactOriginV1;
  readonly sensitivity: MemoryFactSensitivityV1;
  readonly confidence: number;
  readonly distillerVersion: string;
  readonly distilledAt: string;
  readonly contentHash: Sha256Hex;
  readonly sources: readonly MemoryFactSourceV1[];
}

export interface MemoryFactProjectionPageV1 {
  readonly schemaVersion: "1.0";
  readonly operation: "page";
  readonly projectionVersion: number;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly totalFactCount: number;
  readonly pageHash: Sha256Hex;
  readonly manifestHash: Sha256Hex;
  readonly facts: readonly MemoryFactProjectionV1[];
}

export interface MemoryFactProjectionCommitV1 {
  readonly schemaVersion: "1.0";
  readonly operation: "commit";
  readonly projectionVersion: number;
  readonly pageCount: number;
  readonly totalFactCount: number;
  readonly manifestHash: Sha256Hex;
}

export interface MemoryFactProjectionReceiptV1 {
  readonly schemaVersion: "1.0";
  readonly projectionVersion: number;
  readonly manifestHash: Sha256Hex;
  readonly pageIndex: number | null;
  readonly pageHash: Sha256Hex | null;
  readonly published: boolean;
  readonly replayed: boolean;
}

export type MemoryFactProjectBodyV1 = MemoryFactProjectionPageV1 | MemoryFactProjectionCommitV1;
