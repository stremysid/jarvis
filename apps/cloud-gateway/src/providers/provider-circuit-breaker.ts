import {
  ProviderCircuitOpenError,
  isTransientProviderFailure,
  type ProviderOperation,
  type ProviderUnavailableCategory,
} from "./provider-types.js";

const FAILURE_THRESHOLD = 5;
const FAILURE_WINDOW_MS = 60_000;
const RECOVERY_DELAY_MS = 30_000;

interface CircuitState {
  failures: number[];
  openedAt: number | null;
  probeInFlight: boolean;
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

  allow(operation: ProviderOperation, now: Date): boolean {
    const observedAt = timeOf(now);
    const state = this.stateFor(operation);
    this.prune(state, observedAt);

    if (state.openedAt === null) return true;
    if (observedAt - state.openedAt < RECOVERY_DELAY_MS || state.probeInFlight) return false;

    state.probeInFlight = true;
    return true;
  }

  assertAllowed(operation: ProviderOperation, now: Date): void {
    if (!this.allow(operation, now)) {
      throw new ProviderCircuitOpenError(operation, unavailableCategory(operation));
    }
  }

  recordFailure(operation: ProviderOperation, error: unknown, now: Date): void {
    const observedAt = timeOf(now);
    const state = this.stateFor(operation);

    if (state.openedAt !== null && state.probeInFlight) {
      if (isTransientProviderFailure(error)) {
        state.failures = [observedAt];
        state.openedAt = observedAt;
      }
      state.probeInFlight = false;
      return;
    }

    if (state.openedAt !== null || !isTransientProviderFailure(error)) return;

    this.prune(state, observedAt);
    state.failures.push(observedAt);
    if (state.failures.length >= FAILURE_THRESHOLD) {
      state.openedAt = observedAt;
      state.probeInFlight = false;
    }
  }

  recordSuccess(operation: ProviderOperation): void {
    const state = this.states.get(operation);
    if (state === undefined || state.openedAt === null || !state.probeInFlight) return;

    state.failures = [];
    state.openedAt = null;
    state.probeInFlight = false;
  }

  private stateFor(operation: ProviderOperation): CircuitState {
    const existing = this.states.get(operation);
    if (existing !== undefined) return existing;

    const created: CircuitState = { failures: [], openedAt: null, probeInFlight: false };
    this.states.set(operation, created);
    return created;
  }

  private prune(state: CircuitState, now: number): void {
    const cutoff = now - FAILURE_WINDOW_MS;
    state.failures = state.failures.filter((failureAt) => failureAt > cutoff);
  }
}
