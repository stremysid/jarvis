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
  it("emits deduplicated alerts at exact 70 and 85 percent for each resource", async () => {
    const source = new MutableSource(healthy({ d1: 0.70 }));
    const sink = new IdempotentSink();
    const capacity = guard(source, sink);

    await capacity.assertAcceptingNewTurn();
    await capacity.assertAcceptingNewTurn();
    source.estimates = healthy({ d1: 0.85, r2: 0.70, "provider:model": 0.85 });
    await capacity.assertAcceptingNewTurn();
    await capacity.assertAcceptingNewTurn();

    expect(sink.alerts).toEqual([
      "d1:capacity_70",
      "d1:capacity_85",
      "r2:capacity_70",
      "provider:model:capacity_70",
      "provider:model:capacity_85",
    ]);
  });

  it("rearms each recovered crossing so a later equality crossing alerts again", async () => {
    const source = new MutableSource(healthy({ d1: 0.85 }));
    const sink = new IdempotentSink();
    const capacity = guard(source, sink);
    await capacity.assertAcceptingNewTurn();

    source.estimates = healthy({ d1: 0.69 });
    await capacity.assertAcceptingNewTurn();
    source.estimates = healthy({ d1: 0.70 });
    await capacity.assertAcceptingNewTurn();

    expect(sink.rearms).toContain("capacity:d1:70");
    expect(sink.rearms).toContain("capacity:d1:85");
    expect(sink.alerts.filter((alert) => alert === "d1:capacity_70")).toHaveLength(2);
  });

  it("rejects at exact 95 percent before the caller reads or persists content", async () => {
    const source = new MutableSource(healthy({ r2: 0.95 }));
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

  it("fails closed when telemetry or safe alert delivery is unavailable", async () => {
    const unavailable: CapacityEstimateSource = {
      readEstimates: async () => { throw new Error("provider secret response"); },
    };
    await expect(guard(unavailable).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");

    const failedSink: CapacityAlertSink = {
      emit: async () => { throw new Error("alert transport unavailable"); },
      rearm: async () => undefined,
    };
    await expect(guard(new MutableSource(healthy({ d1: 0.70 })), failedSink).assertAcceptingNewTurn())
      .rejects.toThrow("capacity_unavailable");
  });
});
