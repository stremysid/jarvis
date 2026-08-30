import { describe, expectTypeOf, it } from "vitest";
import type {
  SequencedEventV1,
  SyncAckReceiptV1,
  SyncEventsAckBodyV1,
  SyncEventsPageV1,
  SyncEventsPullBodyV1,
} from "../src/sync.js";

describe("sync contracts", () => {
  it("owns the frozen page and durable ACK protocol shapes", () => {
    expectTypeOf<SyncEventsPullBodyV1>().toEqualTypeOf<{
      readonly schemaVersion: "1.0";
      readonly consumerId: string;
      readonly afterSequence: number;
      readonly pageSize: number;
      readonly snapshotToken: string | null;
    }>();
    expectTypeOf<SyncEventsPageV1>().toEqualTypeOf<{
      readonly snapshotId: string;
      readonly snapshotToken: string;
      readonly fromSequence: number;
      readonly toSequence: number;
      readonly events: readonly SequencedEventV1[];
      readonly hasMore: boolean;
    }>();
    expectTypeOf<SyncEventsAckBodyV1>().toEqualTypeOf<{
      readonly schemaVersion: "1.0";
      readonly snapshotId: string;
      readonly expectedCurrent: number;
      readonly throughSequence: number;
    }>();
    expectTypeOf<SyncAckReceiptV1>().toEqualTypeOf<{
      readonly schemaVersion: "1.0";
      readonly currentSequence: number;
      readonly replayed: boolean;
    }>();
  });
});
