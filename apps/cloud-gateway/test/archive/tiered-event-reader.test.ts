import { describe, expect, it } from "vitest";
import type { AppendedEvent, SyncEventReader } from "../../src/persistence/event-repository.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";

function entry(eventSequence: number): AppendedEvent {
  return { eventSequence, envelope: { eventSequence } as AppendedEvent["envelope"], replayed: true };
}

function reader(latest: number, events: readonly AppendedEvent[]): SyncEventReader {
  return {
    latestSequence: async () => latest,
    readRange: async () => events,
  };
}

function state(sealedThrough: number, circuitState: "closed" | "open" = "closed") {
  return {
    readState: async () => ({
      sealedThrough,
      circuitState,
      circuitReason: circuitState === "open" ? "archive_test_failure" : null,
      circuitOpenedAt: circuitState === "open" ? "2026-12-01T00:00:00.000Z" : null,
    }),
  };
}

describe("TieredEventReader", () => {
  it("returns one global contiguous page across the verified R2 and live D1 seam", async () => {
    const tiered = new TieredEventReader({
      archive: { readArchivedRange: async () => [entry(1), entry(2)] },
      live: reader(3, [entry(3)]),
      state: state(2),
    });

    expect(await tiered.latestSequence()).toBe(3);
    expect((await tiered.readRange(0, 3)).map((event) => event.eventSequence)).toEqual([1, 2, 3]);
  });

  it("rejects archive gaps and duplicates before returning a partial page", async () => {
    for (const archived of [[entry(1), entry(3)], [entry(1), entry(1)]]) {
      const tiered = new TieredEventReader({
        archive: { readArchivedRange: async () => archived },
        live: reader(3, []),
        state: state(3),
      });
      await expect(tiered.readRange(0, 3)).rejects.toThrow("tiered_archive_range_incomplete");
    }
  });

  it("rejects a live D1 gap or duplicate at the exact archive seam", async () => {
    for (const live of [[entry(4)], [entry(2)]]) {
      const tiered = new TieredEventReader({
        archive: { readArchivedRange: async () => [entry(1), entry(2)] },
        live: reader(4, live),
        state: state(2),
      });
      await expect(tiered.readRange(0, 3)).rejects.toThrow("tiered_live_range_incomplete");
    }
  });

  it("fails all global reads closed while the persistent archive circuit is open", async () => {
    const tiered = new TieredEventReader({
      archive: { readArchivedRange: async () => [entry(1)] },
      live: reader(2, [entry(2)]),
      state: state(1, "open"),
    });

    await expect(tiered.latestSequence()).rejects.toThrow("archive_circuit_open");
    await expect(tiered.readRange(0, 2)).rejects.toThrow("archive_circuit_open");
  });
});
