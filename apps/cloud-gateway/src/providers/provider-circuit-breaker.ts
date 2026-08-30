import {
  ProviderCircuitOpenError,
  ProviderPermitError,
  isTransientProviderFailure,
  type ProviderOperation,
  type ProviderPermit,
  type ProviderUnavailableCategory,
} from "./provider-types.js";

const FAILURE_THRESHOLD = 5;
const FAILURE_WINDOW_MS = 60_000;
const RECOVERY_DELAY_MS = 30_000;

interface CircuitState {
  failures: number[];
  openedAt: number | null;
  probePermit: ProviderPermit | null;
  generation: number;
}

interface PermitRecord {
  readonly operation: ProviderOperation;
  readonly kind: "ordinary" | "probe";
  readonly generation: number;
  consumed: boolean;
}

function timeOf(now: Date): number {
  const value = now.getTime();
  if (!Number.isFinite(value)) throw new RangeError("provider_circuit_invalid_time");
  return value;
}

function unavailableCategory(operation: ProviderOperation): ProviderUnavailableCategory {
  switch (operation) {
    case "model.voice.streamText":
    case "twilio.createCall":
      return "voice_provider_unavailable";
    case "model.telegram.streamText":
    case "telegram.sendMessage":
      return "telegram_provider_unavailable";
    case "model.completeJson":
      return "background_model_unavailable";
  }
}

/** Operation-keyed rolling failure breaker with one synchronously reserved recovery probe. */
export class ProviderCircuitBreaker {
  private readonly states = new Map<ProviderOperation, CircuitState>();
  private readonly permits = new WeakMap<ProviderPermit, PermitRecord>();

  acquire(operation: ProviderOperation, now: Date): ProviderPermit | null {
    const observedAt = timeOf(now);
    const state = this.stateFor(operation);
    this.prune(state, observedAt);

    if (state.openedAt === null) return this.issue(operation, "ordinary", state.generation);
    if (observedAt - state.openedAt < RECOVERY_DELAY_MS || state.probePermit !== null) return null;

    const permit = this.issue(operation, "probe", state.generation);
    state.probePermit = permit;
    return permit;
  }

  assertAllowed(operation: ProviderOperation, now: Date): ProviderPermit {
    const permit = this.acquire(operation, now);
    if (permit === null) throw new ProviderCircuitOpenError(operation, unavailableCategory(operation));
    return permit;
  }

  recordFailure(permit: ProviderPermit, error: unknown, now: Date): void {
    const observedAt = timeOf(now);
    const record = this.consume(permit);
    const state = this.stateFor(record.operation);

    if (record.kind === "probe") {
      if (state.probePermit !== permit) return;
      if (isTransientProviderFailure(error)) {
        state.failures = [observedAt];
        state.openedAt = observedAt;
        state.generation += 1;
      }
      state.probePermit = null;
      return;
    }

    if (state.openedAt !== null || record.generation !== state.generation || !isTransientProviderFailure(error)) return;

    this.prune(state, observedAt);
    state.failures.push(observedAt);
    if (state.failures.length >= FAILURE_THRESHOLD) {
      state.openedAt = observedAt;
      state.probePermit = null;
      state.generation += 1;
    }
  }

  recordSuccess(permit: ProviderPermit): void {
    const record = this.consume(permit);
    if (record.kind !== "probe") return;
    const state = this.states.get(record.operation);
    if (state === undefined || state.openedAt === null || state.probePermit !== permit) return;

    state.failures = [];
    state.openedAt = null;
    state.probePermit = null;
    state.generation += 1;
  }

  private stateFor(operation: ProviderOperation): CircuitState {
    const existing = this.states.get(operation);
    if (existing !== undefined) return existing;

    const created: CircuitState = { failures: [], openedAt: null, probePermit: null, generation: 0 };
    this.states.set(operation, created);
    return created;
  }

  private issue(operation: ProviderOperation, kind: PermitRecord["kind"], generation: number): ProviderPermit {
    const permit = Object.freeze({ operation }) as ProviderPermit;
    this.permits.set(permit, { operation, kind, generation, consumed: false });
    return permit;
  }

  private consume(permit: ProviderPermit): PermitRecord {
    if (typeof permit !== "object" || permit === null) throw new ProviderPermitError("provider_permit_invalid");
    const record = this.permits.get(permit);
    if (record === undefined) throw new ProviderPermitError("provider_permit_invalid");
    if (record.consumed) throw new ProviderPermitError("provider_permit_consumed");
    record.consumed = true;
    return record;
  }

  private prune(state: CircuitState, now: number): void {
    const cutoff = now - FAILURE_WINDOW_MS;
    state.failures = state.failures.filter((failureAt) => failureAt > cutoff);
  }
}
