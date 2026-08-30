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

  it("does not underreport latest sequence when sealing and purge complete between live and state reads", async () => {
    let sealedThrough = 0;
    const calls: string[] = [];
    const tiered = new TieredEventReader({
      archive: { readArchivedRange: async () => [] },
      live: {
        latestSequence: async () => {
          calls.push("live");
          sealedThrough = 2;
          return 0;
        },
        readRange: async () => [],
      },
      state: {
        readState: async () => {
          calls.push("state");
          return {
            sealedThrough,
            circuitState: "closed",
            circuitReason: null,
            circuitOpenedAt: null,
          };
        },
      },
    });

    await expect(tiered.latestSequence()).resolves.toBe(2);
    expect(calls).toEqual(["live", "state"]);
  });

  it("retries against the new high-water when a live row moves to archive during readRange", async () => {
    let sealedThrough = 0;
    let liveReads = 0;
    let archiveReads = 0;
    const tiered = new TieredEventReader({
      archive: {
        readArchivedRange: async () => {
          archiveReads += 1;
          return [entry(1)];
        },
      },
      live: {
        latestSequence: async () => 1,
        readRange: async () => {
          liveReads += 1;
          sealedThrough = 1;
          return [];
        },
      },
      state: stateReader(() => sealedThrough),
    });

    expect((await tiered.readRange(0, 1)).map((event) => event.eventSequence)).toEqual([1]);
    expect(liveReads).toBe(1);
    expect(archiveReads).toBe(1);
  });

  it("defers provisional live seam validation until a moved high-water is re-read", async () => {
    let sealedThrough = 1;
    const liveAfter: number[] = [];
    const tiered = new TieredEventReader({
      archive: {
        readArchivedRange: async (afterSequence, limit) => Array.from(
          { length: limit },
          (_, index) => entry(afterSequence + index + 1),
        ),
      },
      live: {
        latestSequence: async () => 3,
        readRange: async (afterSequence) => {
          liveAfter.push(afterSequence);
          if (afterSequence === 1) sealedThrough = 2;
          return [entry(3)];
        },
      },
      state: stateReader(() => sealedThrough),
    });

    expect((await tiered.readRange(0, 3)).map((event) => event.eventSequence)).toEqual([1, 2, 3]);
    expect(liveAfter).toEqual([1, 2]);
  });

  it("fails closed after a bounded number of high-water changes", async () => {
    let sealedThrough = 0;
    let stateReads = 0;
    const tiered = new TieredEventReader({
      archive: {
        readArchivedRange: async (afterSequence) => [entry(afterSequence + 1)],
      },
      live: reader(4, []),
      state: {
        readState: async () => {
          stateReads += 1;
          if (stateReads % 2 === 0) sealedThrough += 1;
          return {
            sealedThrough,
            circuitState: "closed",
            circuitReason: null,
            circuitOpenedAt: null,
          };
        },
      },
    });

    await expect(tiered.readRange(0, 1)).rejects.toThrow("tiered_archive_state_unstable");
    expect(stateReads).toBe(6);
  });

  it("rejects already-read provisional data when the second state read opens the circuit", async () => {
    let stateReads = 0;
    const tiered = new TieredEventReader({
      archive: { readArchivedRange: async () => [] },
      live: reader(1, [entry(1)]),
      state: {
        readState: async () => {
          stateReads += 1;
          const open = stateReads === 2;
          return {
            sealedThrough: 0,
            circuitState: open ? "open" : "closed",
            circuitReason: open ? "archive_test_failure" : null,
            circuitOpenedAt: open ? "2026-12-01T00:00:00.000Z" : null,
          };
        },
      },
    });

    await expect(tiered.readRange(0, 1)).rejects.toThrow("archive_circuit_open");
    expect(stateReads).toBe(2);
  });

  it("returns a stable short live tail without inventing a missing event", async () => {
    const tiered = new TieredEventReader({
      archive: { readArchivedRange: async () => [] },
      live: reader(1, [entry(1)]),
      state: state(0),
    });

    expect((await tiered.readRange(0, 3)).map((event) => event.eventSequence)).toEqual([1]);
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

function stateReader(readSealedThrough: () => number) {
  return {
    readState: async () => ({
      sealedThrough: readSealedThrough(),
      circuitState: "closed" as const,
      circuitReason: null,
      circuitOpenedAt: null,
    }),
  };
}
