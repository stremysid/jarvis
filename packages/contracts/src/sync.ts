import type { EventEnvelopeV1 } from "./envelope.js";

export interface SyncEventsPullBodyV1 {
  readonly schemaVersion: "1.0";
  readonly consumerId: string;
  readonly afterSequence: number;
  readonly pageSize: number;
  readonly snapshotToken: string | null;
}

export interface SequencedEventV1 {
  readonly eventSequence: number;
  readonly envelope: EventEnvelopeV1;
}

export interface SyncEventsPageV1 {
  readonly snapshotId: string;
  readonly snapshotToken: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly events: readonly SequencedEventV1[];
  readonly hasMore: boolean;
}

export interface SyncEventsAckBodyV1 {
  readonly schemaVersion: "1.0";
  readonly snapshotId: string;
  readonly expectedCurrent: number;
  readonly throughSequence: number;
}

export interface SyncAckReceiptV1 {
  readonly schemaVersion: "1.0";
  readonly currentSequence: number;
  readonly replayed: boolean;
}
