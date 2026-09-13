export type CapacityResource = "d1" | "r2" | `provider:${string}`;

export interface CapacityEstimate {
  resource: CapacityResource;
  used: number;
  budget: number;
  observedAt: string;
}

export interface CapacityEstimateSource {
  readEstimates(): Promise<readonly CapacityEstimate[]>;
}

export type CapacityAlert =
  | {
    idempotencyKey: string;
    resource: CapacityResource;
    threshold: 70 | 85;
    code: "capacity_70" | "capacity_85";
  }
  | {
    idempotencyKey: "capacity:provider:model:remaining-1-usd";
    resource: "provider:model";
    threshold: "remaining_1_usd";
    code: "deepseek_balance_1_usd";
  };

export interface CapacityAlertSink {
  emit(alert: CapacityAlert): Promise<void>;
  rearm(idempotencyKey: string): Promise<void>;
}

export interface CapacityGuardOptions {
  source: CapacityEstimateSource;
  sink: CapacityAlertSink;
  now: () => Date;
  maximumTelemetryAgeMs: number;
}

const utcMilliseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const safeResource = /^(?:d1|r2|provider:[a-z0-9][a-z0-9_-]{0,63})$/;
const thresholds = [70, 85] as const;

function unavailable(): Error {
  return new Error("capacity_unavailable");
}

function alertFor(resource: CapacityResource, threshold: 70 | 85): CapacityAlert {
  return {
    idempotencyKey: `capacity:${resource}:${threshold}`,
    resource,
    threshold,
    code: `capacity_${threshold}`,
  };
}

const deepSeekBalanceNotice = Object.freeze({
  idempotencyKey: "capacity:provider:model:remaining-1-usd",
  resource: "provider:model",
  threshold: "remaining_1_usd",
  code: "deepseek_balance_1_usd",
} as const satisfies CapacityAlert);

function atOrAbove(estimate: CapacityEstimate, percentage: number): boolean {
  return estimate.used * 100 >= estimate.budget * percentage;
}

/** Fail-closed pre-content capacity gate over fresh injected telemetry only. */
export class CapacityGuard {
  constructor(private readonly options: CapacityGuardOptions) {
    if (!Number.isSafeInteger(options.maximumTelemetryAgeMs) || options.maximumTelemetryAgeMs <= 0) {
      throw new RangeError("maximumTelemetryAgeMs must be a positive integer");
    }
  }

  async assertAcceptingNewTurn(): Promise<void> {
    try {
      const estimates = await this.options.source.readEstimates();
      // A production collector can finish after the guard started. Compare its
      // observation to this clock, then recheck after asynchronous alert delivery.
      const now = this.options.now();
      const nowMilliseconds = now.getTime();
      if (!Number.isFinite(nowMilliseconds)) throw unavailable();
      if (!Array.isArray(estimates) || estimates.length < 3) throw unavailable();

      const resources = new Set<string>();
      let hasD1 = false;
      let hasR2 = false;
      let hasProvider = false;
      let critical = false;
      let oldestObservation = Infinity;
      let newestObservation = -Infinity;
      for (const estimate of estimates) {
        if (!safeResource.test(estimate.resource) || resources.has(estimate.resource)) throw unavailable();
        resources.add(estimate.resource);
        hasD1 ||= estimate.resource === "d1";
        hasR2 ||= estimate.resource === "r2";
        hasProvider ||= estimate.resource.startsWith("provider:");
        if (!Number.isFinite(estimate.used) || estimate.used < 0
          || !Number.isFinite(estimate.budget) || estimate.budget <= 0
          || !utcMilliseconds.test(estimate.observedAt)) {
          throw unavailable();
        }
        const observedMilliseconds = Date.parse(estimate.observedAt);
        if (!Number.isFinite(observedMilliseconds) || new Date(observedMilliseconds).toISOString() !== estimate.observedAt) {
          throw unavailable();
        }
        const age = nowMilliseconds - observedMilliseconds;
        if (age < 0 || age >= this.options.maximumTelemetryAgeMs) throw unavailable();
        oldestObservation = Math.min(oldestObservation, observedMilliseconds);
        newestObservation = Math.max(newestObservation, observedMilliseconds);

        if (estimate.resource === "provider:model") {
          if (estimate.budget - estimate.used <= 1) {
            // This one-time migration reminder is advisory. Its durable lease
            // retries a failed send later, but delivery never decides whether
            // a voice turn is admitted; the separate 95% floor does that.
            try { await this.options.sink.emit(deepSeekBalanceNotice); } catch { /* best effort */ }
          }
        } else {
          for (const threshold of thresholds) {
            const alert = alertFor(estimate.resource, threshold);
            if (atOrAbove(estimate, threshold)) await this.options.sink.emit(alert);
            else await this.options.sink.rearm(alert.idempotencyKey);
          }
        }
        critical ||= atOrAbove(estimate, 95);
      }
      if (!hasD1 || !hasR2 || !hasProvider || critical) throw unavailable();
      const completedAt = this.options.now().getTime();
      if (!Number.isFinite(completedAt) || completedAt < newestObservation
        || completedAt - oldestObservation >= this.options.maximumTelemetryAgeMs) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
}
