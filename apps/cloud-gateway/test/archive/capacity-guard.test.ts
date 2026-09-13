import { describe, expect, it } from "vitest";
import {
  CapacityGuard,
  type CapacityAlert,
  type CapacityAlertSink,
  type CapacityEstimate,
  type CapacityEstimateSource,
} from "../../src/archive/capacity-guard.js";

const now = new Date("2026-12-01T00:00:00.000Z");
const observedAt = now.toISOString();

class MutableSource implements CapacityEstimateSource {
  constructor(public estimates: readonly CapacityEstimate[]) {}
  async readEstimates(): Promise<readonly CapacityEstimate[]> {
    return this.estimates;
  }
}

class IdempotentSink implements CapacityAlertSink {
  readonly alerts: string[] = [];
  readonly rearms: string[] = [];
  private readonly active = new Set<string>();

  async emit(alert: CapacityAlert): Promise<void> {
    if (this.active.has(alert.idempotencyKey)) return;
    this.active.add(alert.idempotencyKey);
    this.alerts.push(`${alert.resource}:${alert.code}`);
  }

  async rearm(idempotencyKey: string): Promise<void> {
    this.active.delete(idempotencyKey);
    this.rearms.push(idempotencyKey);
  }
}

function estimate(resource: CapacityEstimate["resource"], ratio: number, timestamp = observedAt): CapacityEstimate {
  return { resource, used: ratio * 1000, budget: 1000, observedAt: timestamp };
}

function healthy(overrides: Partial<Record<CapacityEstimate["resource"], number>> = {}): readonly CapacityEstimate[] {
  return [
    estimate("d1", overrides.d1 ?? 0.1),
    estimate("r2", overrides.r2 ?? 0.1),
    estimate("provider:model", overrides["provider:model"] ?? 0.1),
  ];
}

function guard(source: CapacityEstimateSource, sink: CapacityAlertSink = new IdempotentSink()): CapacityGuard {
  return new CapacityGuard({ source, sink, now: () => new Date(now), maximumTelemetryAgeMs: 60_000 });
}

describe("CapacityGuard", () => {
  it("warns every resource at 85 and 95 percent, then refuses at the configured limit", async () => {
    const source = new MutableSource(healthy({ d1: 0.85 }));
    const sink = new IdempotentSink();
    const capacity = guard(source, sink);

    await capacity.assertAcceptingNewTurn();
    await capacity.assertAcceptingNewTurn();
    source.estimates = [estimate("d1", 0.95), estimate("r2", 0.85), estimate("provider:model", 0.95)];
    await capacity.assertAcceptingNewTurn();
    source.estimates = healthy({ r2: 1 });
    await expect(capacity.assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");

    expect(sink.alerts).toEqual([
      "d1:capacity_85",
      "d1:capacity_95",
      "r2:capacity_85",
      "provider:model:capacity_85",
      "provider:model:capacity_95",
      "r2:capacity_95",
    ]);
  });

  it("keeps every failed or leased warning best-effort for every resource", async () => {
    const alerts: string[] = [];
    const sink: CapacityAlertSink = {
      async emit(alert) {
        alerts.push(alert.idempotencyKey);
        throw new Error("telegram unavailable");
      },
      async rearm() { throw new Error("receipt storage unavailable"); },
    };
    const source = new MutableSource([
      estimate("d1", 0.85), estimate("r2", 0.95), estimate("provider:model", 0.95), estimate("provider:voice", 0.95),
    ]);
    const capacity = guard(source, sink);

    await expect(capacity.assertAcceptingNewTurn()).resolves.toBeUndefined();
    expect(alerts).toEqual([
      "capacity:d1:85",
      "capacity:r2:85", "capacity:r2:95",
      "capacity:provider:model:85", "capacity:provider:model:95",
      "capacity:provider:voice:85", "capacity:provider:voice:95",
    ]);
  });

  it("rearms each recovered crossing so a later equality crossing alerts again", async () => {
    const source = new MutableSource(healthy({ d1: 0.95 }));
    const sink = new IdempotentSink();
    const capacity = guard(source, sink);
    await capacity.assertAcceptingNewTurn();

    source.estimates = healthy({ d1: 0.84 });
    await capacity.assertAcceptingNewTurn();
    source.estimates = healthy({ d1: 0.85 });
    await capacity.assertAcceptingNewTurn();

    expect(sink.rearms).toContain("capacity:d1:85");
    expect(sink.rearms).toContain("capacity:d1:95");
    expect(sink.alerts.filter((alert) => alert === "d1:capacity_85")).toHaveLength(2);
  });

  it("rejects at exact 100 percent before the caller reads or persists content", async () => {
    const source = new MutableSource(healthy({ r2: 1 }));
    let contentReads = 0;
    const acceptTurn = async (): Promise<void> => {
      await guard(source).assertAcceptingNewTurn();
      contentReads += 1;
    };

    await expect(acceptTurn()).rejects.toThrow("capacity_unavailable");
    expect(contentReads).toBe(0);
  });

  it("fails closed for exact-stale, future, invalid, incomplete, or duplicate telemetry", async () => {
    const cases: readonly (readonly CapacityEstimate[])[] = [
      healthy().map((item) => ({ ...item, observedAt: new Date(now.getTime() - 60_000).toISOString() })),
      healthy().map((item) => ({ ...item, observedAt: new Date(now.getTime() + 1).toISOString() })),
      [estimate("d1", Number.NaN), estimate("r2", 0.1), estimate("provider:model", 0.1)],
      [estimate("d1", 0.1), estimate("r2", 0.1)],
      [estimate("d1", 0.1), estimate("d1", 0.2), estimate("r2", 0.1), estimate("provider:model", 0.1)],
    ];

    for (const snapshot of cases) {
      await expect(guard(new MutableSource(snapshot)).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
    }
  });

  it("fails closed when telemetry is unavailable", async () => {
    const unavailable: CapacityEstimateSource = {
      readEstimates: async () => { throw new Error("provider secret response"); },
    };
    await expect(guard(unavailable).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");

  });

  it("uses the collection completion time so a fresh measurement is not rejected as future telemetry", async () => {
    let clock = now.valueOf();
    const capacity = new CapacityGuard({
      source: { async readEstimates() {
        clock += 1;
        return healthy().map((item) => ({ ...item, observedAt: new Date(clock).toISOString() }));
      } },
      sink: new IdempotentSink(), now: () => new Date(clock), maximumTelemetryAgeMs: 60_000,
    });
    await expect(capacity.assertAcceptingNewTurn()).resolves.toBeUndefined();
  });

  it.each(["collection", "alert delivery"] as const)("refuses telemetry that becomes stale during %s", async (stage) => {
    let clock = now.valueOf();
    const capacity = new CapacityGuard({
      source: { async readEstimates() {
        if (stage === "collection") clock += 60_000;
        return healthy({ d1: 0.85 });
      } },
      sink: { async emit() { if (stage === "alert delivery") clock += 60_000; }, async rearm() {} },
      now: () => new Date(clock), maximumTelemetryAgeMs: 60_000,
    });
    await expect(capacity.assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
  });

  it("rejects an already-stale observation before sending or rearming its alert", async () => {
    const sink = new IdempotentSink();
    const stale = healthy({ d1: 0.85 }).map((item) => ({ ...item,
      observedAt: new Date(now.valueOf() - 60_000).toISOString() }));
    await expect(guard(new MutableSource(stale), sink).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
    expect(sink.alerts).toEqual([]);
    expect(sink.rearms).toEqual([]);
  });

  it.each(["d1", "r2"] as const)("refuses a missing %s measurement even when multiple provider rows keep the list long enough", async (missing) => {
    const rows = [...healthy().filter((item) => item.resource !== missing), estimate("provider:twilio", 0.1)];
    expect(rows).toHaveLength(3);
    await expect(guard(new MutableSource(rows)).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
  });

  it.each([
    ["used", -1], ["used", Infinity], ["used", Number.NaN],
    ["budget", 0], ["budget", -1], ["budget", Infinity], ["budget", Number.NaN],
  ] as const)("refuses an invalid %s measurement instead of interpreting it as available capacity", async (field, value) => {
    const rows = healthy().map((item) => item.resource === "d1" ? { ...item, [field]: value } : item);
    const sink = new IdempotentSink();
    await expect(guard(new MutableSource(rows), sink).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
    expect(sink.alerts).toEqual([]);
    expect(sink.rearms).toEqual([]);
  });
});
