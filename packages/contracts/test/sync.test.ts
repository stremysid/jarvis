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
    expectTypeOf<SyncEventsPullBodyV1>().toMatchTypeOf<{
      schemaVersion: "1.0"; consumerId: string; afterSequence: number; pageSize: number; snapshotToken: string | null;
    }>();
    expectTypeOf<SyncEventsAckBodyV1>().toMatchTypeOf<{
      schemaVersion: "1.0"; snapshotId: string; expectedCurrent: number; throughSequence: number;
    }>();
    expectTypeOf<SyncEventsPageV1["events"]>().toEqualTypeOf<readonly SequencedEventV1[]>();
    expectTypeOf<SyncAckReceiptV1["replayed"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SyncAckReceiptV1>().toEqualTypeOf<{ schemaVersion: "1.0"; currentSequence: number; replayed: boolean }>();
  });
});
