import { permittedOutboundControls } from "../policy/outbound-controls-fixture.js";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapacityGuard, type CapacityEstimate } from "../../src/archive/capacity-guard.js";
import type { OutboundCallCommand, Ulid } from "../../../../packages/contracts/src/index.js";
import { OutboundCallDispatcher } from "../../src/calls/outbound-call-dispatcher.js";
import { CallRepository, type ProviderDispatchClaimCapability } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import type { DispatchPolicyCheck, OutboundCallRequest, PolicyDecision, PolicyEngineContract } from "../../src/policy/policy-types.js";
import {
  ProviderDispatchUnknownError,
  ProviderFailure,
  snapshotProviderFailure,
  type TwilioCreateCallInput,
  type TwilioProvider,
} from "../../src/providers/provider-types.js";
import {
  applyFoundationMigration,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const COMMAND_ID = "01k3s6k8000000000000000000" as Ulid;
const SECOND_COMMAND_ID = "01k3s6k8000000000000000004" as Ulid;
const ATTEMPT_0 = "01k3s6k8000000000000000001" as Ulid;
const ATTEMPT_1 = "01k3s6k8000000000000000002" as Ulid;
const ATTEMPT_2 = "01k3s6k8000000000000000003" as Ulid;
const CHECK_IDS = [
  "01k3s6k8000000000000000009",
  "01k3s6k800000000000000000a",
  "01k3s6k800000000000000000b",
  "01k3s6k800000000000000000c",
] as const satisfies readonly Ulid[];
const CALL_SID = `CA${"1".repeat(32)}`;
const CALL_SID_2 = `CA${"2".repeat(32)}`;
const CALL_SID_3 = `CA${"3".repeat(32)}`;
const AUDITED_DESTINATION = "+14165550123";
const NONCE_0 = `${"A".repeat(42)}A`;
const NONCE_1 = `${"B".repeat(42)}E`;
const NONCE_2 = `${"C".repeat(42)}I`;

function command(): OutboundCallCommand {
  return {
    commandId: COMMAND_ID,
    principalId: "principal:owner",
    purposeCode: "user_requested",
    destinationIdentityId: "identity:voice",
    urgency: "normal",
    authorizationExpiresAt: "2026-08-30T12:05:00.000Z",
    idempotencyKey: "call:test",
    issuedBy: "telegram_call_command",
  };
}

class RecordingPolicy implements PolicyEngineContract {
  readonly rechecks: { request: OutboundCallRequest; attemptId: Ulid }[] = [];
  private releaseGate: (() => void) | undefined;
  private blockedGate: Promise<void> | undefined;
  private signalBlocked: (() => void) | undefined;

  async evaluateOutboundCall(): Promise<PolicyDecision> {
    return { decision: "allow", reason: "allowed" };
  }

  blockFinalRecheck(): void {
    this.blockedGate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  }

  waitUntilBlocked(): Promise<void> {
    if (this.blockedGate === undefined) throw new Error("policy_not_blocked");
    return new Promise<void>((resolve) => { this.signalBlocked = resolve; });
  }

  releaseFinalRecheck(): void {
    this.releaseGate?.();
  }

  async recheckOutboundDispatch(request: OutboundCallRequest, attemptId: Ulid): Promise<DispatchPolicyCheck> {
    this.rechecks.push({ request, attemptId });
    this.signalBlocked?.();
    await this.blockedGate;
    const checkId = CHECK_IDS[(this.rechecks.length - 1) % CHECK_IDS.length] ?? CHECK_IDS[0];
    return {
      decision: "allow",
      reason: "allowed",
      checkedAt: NOW.toISOString(),
      checkId,
      attemptId,
      destinationE164: AUDITED_DESTINATION,
      commandId: request.commandId,
    };
  }
}

class TestControllableTwilioProvider implements TwilioProvider {
  readonly requests: Readonly<TwilioCreateCallInput>[] = [];
  private readonly outcomes: Error[] = [];
  private block = false;
  private releaseRequest: (() => void) | undefined;
  private signalRequest: (() => void) | undefined;

  rejectNext(failure: ProviderFailure): void {
    this.outcomes.push(failure);
  }

  acceptAndLoseNextResponse(): void {
    this.outcomes.push(new ProviderDispatchUnknownError());
  }

  blockNextResponse(): void {
    this.block = true;
  }

  waitForRequest(): Promise<void> {
    if (this.requests.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.signalRequest = resolve; });
  }

  releaseResponse(): void {
    this.releaseRequest?.();
  }

  async createCall(input: TwilioCreateCallInput): Promise<{ callSid: string }> {
    this.requests.push(Object.freeze({ ...input }));
    this.signalRequest?.();
    if (this.block) {
      this.block = false;
      await new Promise<void>((resolve) => { this.releaseRequest = resolve; });
    }
    const failure = this.outcomes.shift();
    if (failure !== undefined) throw failure;
    return { callSid: CALL_SID };
  }
}

class TestAttemptInsertBarrier {
  private readonly arrivals = new Set<number>();
  private readonly insertAttemptIds = new Map<number, unknown>();
  private readonly participantReleaseGates = new Map<number, () => void>();
  private readonly participantReleases = new Map<number, Promise<void>>();
  private arrivalGate: (() => void) | undefined;
  private readonly bothArrived = new Promise<void>((resolve) => { this.arrivalGate = resolve; });

  constructor(private readonly database: D1Database) {}

  bindingForParticipant(participant: number): D1Database {
    const barrier = this;
    const released = new Promise<void>((resolve) => { barrier.participantReleaseGates.set(participant, resolve); });
    barrier.participantReleases.set(participant, released);
    return new Proxy(this.database, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            if (!/^\s*INSERT\s+INTO\s+outbound_call_attempts\b[\s\S]*\bSELECT\b/iu.test(query)) return statement;
            let waited = false;
            const wrap = (real: D1PreparedStatement): D1PreparedStatement => new Proxy(real, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "bind") {
                  return (...values: unknown[]) => {
                    barrier.insertAttemptIds.set(participant, values[0]);
                    return wrap(statementTarget.bind(...values));
                  };
                }
                if (["run", "all", "first", "raw"].includes(String(statementProperty))) {
                  const operation = Reflect.get(statementTarget, statementProperty) as (...values: unknown[]) => unknown;
                  return async (...values: unknown[]) => {
                    if (!waited) {
                      waited = true;
                      barrier.arrivals.add(participant);
                      if (barrier.arrivals.size === 2) barrier.arrivalGate?.();
                      await released;
                    }
                    return Reflect.apply(operation, statementTarget, values);
                  };
                }
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
            return wrap(statement);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  waitUntilBothInsertSelectsAreBlocked(): Promise<void> {
    return this.bothArrived;
  }

  attemptIdForParticipant(participant: number): unknown {
    return this.insertAttemptIds.get(participant);
  }

  releaseParticipant(participant: number): void {
    if (!this.participantReleases.has(participant)) throw new Error("insert_barrier_participant_unknown");
    this.participantReleaseGates.get(participant)?.();
  }

  releaseBoth(): void {
    for (const participant of this.arrivals) this.releaseParticipant(participant);
  }
}

async function clearData(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearOutboundCallAttemptsForTest();
  await clearVoiceAccessDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM principals"),
  ]);
}

async function seedAuthorizedCommand(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'owner', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', ?, 'active', ?, ?)").bind(AUDITED_DESTINATION, timestamp, timestamp),
    env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:voice', ?)").bind(timestamp),
    env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)").bind(COMMAND_ID, "a".repeat(64), timestamp),
  ]);
}

function createRepository(database: D1Database = env.DB, nonceFactory?: () => string): CallRepository {
  const nonces = [NONCE_0, NONCE_1];
  return new CallRepository(database, new EventRepository(database), nonceFactory ?? (() => nonces.shift() ?? NONCE_1));
}

function createDispatcher(input: {
  policy?: RecordingPolicy;
  twilio?: TestControllableTwilioProvider;
  repository?: CallRepository;
  attemptIds?: Ulid[];
  capacity?: Pick<CapacityGuard, "assertAcceptingNewTurn">;
} = {}) {
  const attemptIds = input.attemptIds ?? [ATTEMPT_0, ATTEMPT_1, ATTEMPT_2];
  const policy = input.policy ?? new RecordingPolicy();
  const twilio = input.twilio ?? new TestControllableTwilioProvider();
  const repository = input.repository ?? createRepository();
  return {
    policy,
    twilio,
    repository,
    dispatcher: new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: input.capacity ?? { async assertAcceptingNewTurn() {} },
      policy,
      twilio,
      repository,
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => attemptIds.shift() ?? ATTEMPT_2,
      now: () => NOW,
    }),
  };
}

async function readAttempt(attemptId: Ulid): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT attempt_id AS attemptId, principal_id AS principalId,
    attempt_ordinal AS attemptOrdinal, destination_identity_id AS destinationIdentityId, relay_nonce AS relayNonce,
    provider_dispatch_state AS providerDispatchState, provider_call_sid AS providerCallSid
    FROM outbound_call_attempts WHERE attempt_id = ?`)
    .bind(attemptId).first<Record<string, unknown>>();
}

describe("OutboundCallDispatcher", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearData();
    await seedAuthorizedCommand();
  });

  afterEach(clearData);

  it.each(["stale", "short", "malformed", "critical"] as const)(
    "blocks dialling on %s capacity telemetry before claiming a provider attempt", async (fault) => {
      const estimates: CapacityEstimate[] = ["d1", "r2", "provider:twilio", "provider:deepseek"].map((resource) => ({
        resource: resource as CapacityEstimate["resource"], used: 1, budget: 100, observedAt: NOW.toISOString(),
      }));
      if (fault === "stale") estimates[0]!.observedAt = new Date(NOW.valueOf() - 60_000).toISOString();
      if (fault === "short") estimates.splice(1);
      if (fault === "malformed") estimates[0]!.used = Number.NaN;
      if (fault === "critical") estimates[3]!.used = 100;
      const capacity = new CapacityGuard({
        source: { async readEstimates() { return estimates; } },
        sink: { async emit() {}, async rearm() {} }, now: () => NOW, maximumTelemetryAgeMs: 60_000,
      });
      const subject = createDispatcher({ capacity });
      await expect(subject.dispatcher.dispatch(command())).resolves.toEqual({ status: "capacity_unavailable" });
      expect(subject.policy.rechecks).toHaveLength(0);
      expect(subject.twilio.requests).toHaveLength(0);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM outbound_call_attempts").first()).toEqual({ count: 0 });
    },
  );

  it("awaits capacity before the final calling policy check and before any dispatch ownership", async () => {
    let release = () => {};
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const subject = createDispatcher({ capacity: { async assertAcceptingNewTurn() {
      order.push("capacity"); entered(); await gate;
    } } });
    const check = subject.policy.recheckOutboundDispatch.bind(subject.policy);
    vi.spyOn(subject.policy, "recheckOutboundDispatch").mockImplementation(async (...args) => {
      order.push("policy"); return check(...args);
    });
    const pending = subject.dispatcher.dispatch(command());
    await waiting;
    try {
      expect(subject.policy.rechecks).toHaveLength(0);
      expect(subject.twilio.requests).toHaveLength(0);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM outbound_call_attempts").first()).toEqual({ count: 0 });
    } finally { release(); }
    expect((await pending).status).toBe("dispatched");
    expect(order).toEqual(["capacity", "policy"]);
    expect(subject.twilio.requests).toHaveLength(1);
  });

  it("returns an existing call receipt without requiring another capacity check or another dial", async () => {
    const assertAcceptingNewTurn = vi.fn(async () => {});
    const subject = createDispatcher({ capacity: { assertAcceptingNewTurn } });
    const first = await subject.dispatcher.dispatch(command());
    assertAcceptingNewTurn.mockRejectedValue(new Error("capacity_unavailable"));
    expect(await subject.dispatcher.dispatch(command())).toEqual(first);
    expect(first.status).toBe("dispatched");
    expect(assertAcceptingNewTurn).toHaveBeenCalledOnce();
    expect(subject.twilio.requests).toHaveLength(1);
  });

  it("refuses missing capacity wiring without spending or exposing the dependency failure", async () => {
    const twilio = new TestControllableTwilioProvider();
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls, policy: new RecordingPolicy(), twilio,
      repository: createRepository(), publicBaseUrl: new URL("https://jarvis.example/"),
      capacity: undefined as never, newAttemptId: () => ATTEMPT_0, now: () => NOW });
    expect(await dispatcher.dispatch(command())).toEqual({ status: "capacity_unavailable" });
    expect(twilio.requests).toHaveLength(0);
    expect(await readAttempt(ATTEMPT_0)).toBeNull();
  });

  it("captures the capacity assertion so replacing the caller's dependency cannot bypass spending admission", async () => {
    const capacity = { async assertAcceptingNewTurn(): Promise<void> { throw new Error("synthetic private diagnostic"); } };
    const subject = createDispatcher({ capacity });
    capacity.assertAcceptingNewTurn = async () => {};
    expect(await subject.dispatcher.dispatch(command())).toEqual({ status: "capacity_unavailable" });
    expect(subject.twilio.requests).toHaveLength(0);
    expect(await readAttempt(ATTEMPT_0)).toBeNull();
  });

  it("rejects extra caller-controlled fields before policy or persistence", async () => {
    const subject = createDispatcher();

    await expect(subject.dispatcher.dispatch({ ...command(), toE164: "+14165550999" } as never)).resolves.toEqual({
      status: "denied",
      reason: "invalid_request",
      checkedAt: NOW.toISOString(),
      checkId: null,
      attemptId: null,
    });
    expect(subject.policy.rechecks).toHaveLength(0);
    expect(subject.twilio.requests).toHaveLength(0);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM outbound_call_attempts").first())
      .resolves.toEqual({ count: 0 });
  });

  it("persists an unknown provider outcome and never invokes Twilio again", async () => {
    const subject = createDispatcher();
    subject.twilio.acceptAndLoseNextResponse();

    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "provider_dispatch_unknown", attemptId: ATTEMPT_0 });
    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "provider_dispatch_unknown", attemptId: ATTEMPT_0 });

    expect(subject.twilio.requests).toHaveLength(1);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "provider_dispatch_unknown" });
  });

  it("classifies unsupported nominal provider failures as unknown and suppresses retry", async () => {
    const subject = createDispatcher();
    subject.twilio.rejectNext(ProviderFailure.transient("timeout"));

    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "provider_dispatch_unknown", attemptId: ATTEMPT_0 });
    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "provider_dispatch_unknown", attemptId: ATTEMPT_0 });
    expect(subject.twilio.requests).toHaveLength(1);
  });

  it("freezes nominal provider failure facts and rejects accessor-fabricated failures", async () => {
    const genuine = ProviderFailure.transient("rate_limited");
    expect(Object.hasOwn(genuine, "code")).toBe(true);
    expect(Object.hasOwn(genuine, "category")).toBe(true);
    expect(Object.isFrozen(genuine)).toBe(true);
    expect(() => Object.defineProperty(genuine, "category", { value: "timeout" })).toThrow(TypeError);

    const fabricated = Object.create(ProviderFailure.prototype) as ProviderFailure;
    Object.defineProperties(fabricated, {
      code: { enumerable: true, configurable: false, writable: false, value: "provider_transient_failure" },
      category: { enumerable: true, configurable: false, writable: false, value: "rate_limited" },
    });
    Object.freeze(fabricated);
    expect(snapshotProviderFailure(fabricated)).toBeNull();
    const subject = createDispatcher();
    subject.twilio.rejectNext(fabricated);

    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({
      status: "provider_dispatch_unknown",
      attemptId: ATTEMPT_0,
    });
    expect(subject.twilio.requests).toHaveLength(1);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "provider_dispatch_unknown" });
  });

  it("recovers a ready row by claiming it before the only provider POST", async () => {
    const subject = createDispatcher();
    await subject.repository.getOrCreateExpectedCall({ attemptId: ATTEMPT_0, commandId: COMMAND_ID, principalId: command().principalId, destinationIdentityId: command().destinationIdentityId, idempotencyKey: command().idempotencyKey, authorizationExpiresAt: command().authorizationExpiresAt, now: NOW, attemptOrdinal: 0 });

    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "dispatched", attemptId: ATTEMPT_0 });
    expect(subject.policy.rechecks.map((entry) => entry.attemptId)).toEqual([ATTEMPT_0]);
    expect(subject.twilio.requests).toHaveLength(1);
  });

  it.each([
    ["at exact nonce expiry", 300_000],
    ["past nonce expiry", 300_001],
  ] as const)("denies ready-row recovery %s without a provider POST", async (_label, ageMs) => {
    const subject = createDispatcher();
    await subject.repository.getOrCreateExpectedCall({
      attemptId: ATTEMPT_0,
      commandId: COMMAND_ID,
      principalId: command().principalId,
      destinationIdentityId: command().destinationIdentityId,
      idempotencyKey: command().idempotencyKey,
      authorizationExpiresAt: command().authorizationExpiresAt,
      now: new Date(NOW.valueOf() - ageMs),
      attemptOrdinal: 0,
    });

    await expect(subject.dispatcher.dispatch(command())).resolves.toEqual({
      status: "denied",
      reason: "invalid_dispatch_attempt",
      checkedAt: NOW.toISOString(),
      checkId: null,
      attemptId: ATTEMPT_0,
    });
    expect(subject.policy.rechecks.map((entry) => entry.attemptId)).toEqual([ATTEMPT_0]);
    expect(subject.twilio.requests).toHaveLength(0);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "ready" });
  });

  it("retains the captured claim observation time when a repository mutates its Date input", async () => {
    const repository = createRepository();
    await repository.getOrCreateExpectedCall({
      attemptId: ATTEMPT_0,
      commandId: COMMAND_ID,
      principalId: command().principalId,
      destinationIdentityId: command().destinationIdentityId,
      idempotencyKey: command().idempotencyKey,
      authorizationExpiresAt: command().authorizationExpiresAt,
      now: new Date(NOW.valueOf() - 300_000),
      attemptOrdinal: 0,
    });
    const wrappedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "claimProviderDispatch") {
          return async (input: { attemptId: Ulid; now: Date }) => {
            const result = await target.claimProviderDispatch(input);
            input.now.setTime(NOW.valueOf() + 60_000);
            return result;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const twilio = new TestControllableTwilioProvider();
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy: new RecordingPolicy(),
      twilio,
      repository: wrappedRepository,
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => NOW,
    });

    await expect(dispatcher.dispatch(command())).resolves.toEqual({
      status: "denied",
      reason: "invalid_dispatch_attempt",
      checkedAt: NOW.toISOString(),
      checkId: null,
      attemptId: ATTEMPT_0,
    });
    expect(twilio.requests).toHaveLength(0);
  });

  it("denies when authorization expires after audit but before the durable ready claim", async () => {
    const repository = createRepository();
    let signalReadyPersisted: (() => void) | undefined;
    let releaseReady: (() => void) | undefined;
    const readyPersisted = new Promise<void>((resolve) => { signalReadyPersisted = resolve; });
    const readyRelease = new Promise<void>((resolve) => { releaseReady = resolve; });
    const blockedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "getOrCreateExpectedCall") {
          return async (...args: Parameters<CallRepository["getOrCreateExpectedCall"]>) => {
            const stored = await target.getOrCreateExpectedCall(...args);
            signalReadyPersisted?.();
            await readyRelease;
            return stored;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let now = NOW;
    const twilio = new TestControllableTwilioProvider();
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy: new RecordingPolicy(),
      twilio,
      repository: blockedRepository,
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => now,
    });

    const pending = dispatcher.dispatch(command());
    await readyPersisted;
    now = new Date(command().authorizationExpiresAt);
    releaseReady?.();

    await expect(pending).resolves.toEqual({
      status: "denied",
      reason: "authorization_expired",
      checkedAt: command().authorizationExpiresAt,
      checkId: null,
      attemptId: ATTEMPT_0,
    });
    expect(twilio.requests).toHaveLength(0);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "ready" });
  });

  it("suppresses recovery after a crash immediately following the durable claim", async () => {
    const subject = createDispatcher();
    await subject.repository.getOrCreateExpectedCall({ attemptId: ATTEMPT_0, commandId: COMMAND_ID, principalId: command().principalId, destinationIdentityId: command().destinationIdentityId, idempotencyKey: command().idempotencyKey, authorizationExpiresAt: command().authorizationExpiresAt, now: NOW, attemptOrdinal: 0 });
    await expect(subject.repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW })).resolves.toMatchObject({ kind: "claimed" });

    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "provider_dispatch_unknown", attemptId: ATTEMPT_0 });

    expect(subject.policy.rechecks).toHaveLength(0);
    expect(subject.twilio.requests).toHaveLength(0);
  });

  it("permits one provider invocation under concurrent dispatcher calls", async () => {
    const subject = createDispatcher();
    subject.twilio.blockNextResponse();
    const first = subject.dispatcher.dispatch(command());
    await subject.twilio.waitForRequest();
    const second = subject.dispatcher.dispatch(command());

    await expect(second).resolves.toMatchObject({ status: "provider_dispatch_unknown", attemptId: ATTEMPT_0 });
    subject.twilio.releaseResponse();
    await expect(first).resolves.toMatchObject({ status: "dispatched", attemptId: ATTEMPT_0 });
    expect(subject.twilio.requests).toHaveLength(1);
  });

  it("converges raced candidate IDs on the stored winner without rotating its nonce", async () => {
    const barrier = new TestAttemptInsertBarrier(env.DB);
    const twilio = new TestControllableTwilioProvider();
    const policy = new RecordingPolicy();
    twilio.blockNextResponse();
    const left = createDispatcher({ policy, twilio, repository: createRepository(barrier.bindingForParticipant(0), () => NONCE_0), attemptIds: [ATTEMPT_0] });
    const right = createDispatcher({ policy, twilio, repository: createRepository(barrier.bindingForParticipant(1), () => NONCE_1), attemptIds: [ATTEMPT_1] });

    const leftPending = left.dispatcher.dispatch(command());
    const rightPending = right.dispatcher.dispatch(command());
    await barrier.waitUntilBothInsertSelectsAreBlocked();
    expect(barrier.attemptIdForParticipant(0)).toBe(ATTEMPT_0);
    expect(barrier.attemptIdForParticipant(1)).toBe(ATTEMPT_1);
    expect(policy.rechecks).toHaveLength(2);
    expect(policy.rechecks.map((entry) => entry.attemptId).sort()).toEqual([ATTEMPT_0, ATTEMPT_1]);
    barrier.releaseBoth();
    await twilio.waitForRequest();
    twilio.releaseResponse();
    const results = await Promise.all([leftPending, rightPending]);

    const winner = twilio.requests[0]?.attemptId as Ulid;
    expect(results.map((result) => "attemptId" in result ? result.attemptId : null)).toEqual([winner, winner]);
    await expect(readAttempt(winner)).resolves.toMatchObject({ relayNonce: winner === ATTEMPT_0 ? NONCE_0 : NONCE_1 });
    expect(policy.rechecks.filter((entry) => entry.attemptId === winner)).toHaveLength(2);
    expect(twilio.requests).toHaveLength(1);
  });

  it("never promotes a delayed ordinal-0 candidate after the winner becomes retry-eligible", async () => {
    const barrier = new TestAttemptInsertBarrier(env.DB);
    const twilio = new TestControllableTwilioProvider();
    const policy = new RecordingPolicy();
    twilio.rejectNext(ProviderFailure.transient("rate_limited"));
    const left = createDispatcher({
      policy,
      twilio,
      repository: createRepository(barrier.bindingForParticipant(0), () => NONCE_0),
      attemptIds: [ATTEMPT_0],
    });
    const right = createDispatcher({
      policy,
      twilio,
      repository: createRepository(barrier.bindingForParticipant(1), () => NONCE_1),
      attemptIds: [ATTEMPT_1],
    });

    const leftPending = left.dispatcher.dispatch(command());
    const rightPending = right.dispatcher.dispatch(command());
    await barrier.waitUntilBothInsertSelectsAreBlocked();
    expect(barrier.attemptIdForParticipant(0)).toBe(ATTEMPT_0);
    expect(barrier.attemptIdForParticipant(1)).toBe(ATTEMPT_1);
    expect(policy.rechecks.map((entry) => entry.attemptId).sort()).toEqual([ATTEMPT_0, ATTEMPT_1]);

    barrier.releaseParticipant(0);
    await expect(leftPending).resolves.toMatchObject({
      status: "rejected",
      attemptId: ATTEMPT_0,
      retryEligible: true,
    });
    expect(twilio.requests.map((request) => request.attemptId)).toEqual([ATTEMPT_0]);

    barrier.releaseParticipant(1);
    await expect(rightPending).resolves.toMatchObject({
      status: "rejected",
      attemptId: ATTEMPT_0,
      retryEligible: true,
    });
    expect(twilio.requests.map((request) => request.attemptId)).toEqual([ATTEMPT_0]);
    await expect(readAttempt(ATTEMPT_1)).resolves.toBeNull();
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM outbound_call_attempts WHERE relay_nonce = ?")
      .bind(NONCE_1).first()).resolves.toEqual({ count: 0 });

    const later = createDispatcher({
      policy,
      twilio,
      repository: createRepository(env.DB, () => NONCE_2),
      attemptIds: [ATTEMPT_2],
    });
    await expect(later.dispatcher.dispatch(command())).resolves.toMatchObject({
      status: "dispatched",
      attemptId: ATTEMPT_2,
    });
    expect(policy.rechecks.at(-1)?.attemptId).toBe(ATTEMPT_2);
    expect(twilio.requests.map((request) => request.attemptId)).toEqual([ATTEMPT_0, ATTEMPT_2]);
    await expect(readAttempt(ATTEMPT_2)).resolves.toMatchObject({ attemptOrdinal: 1, relayNonce: NONCE_2 });
  });

  it("converges a delayed ordinal-1 candidate on the stored ordinal-1 winner", async () => {
    const initialRepository = createRepository(env.DB, () => NONCE_0);
    await initialRepository.getOrCreateExpectedCall({
      attemptId: ATTEMPT_0,
      commandId: COMMAND_ID,
      principalId: command().principalId,
      destinationIdentityId: command().destinationIdentityId,
      idempotencyKey: command().idempotencyKey,
      authorizationExpiresAt: command().authorizationExpiresAt,
      now: NOW,
      attemptOrdinal: 0,
    });
    const initialClaim = await initialRepository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (initialClaim.kind !== "claimed") throw new Error("test_initial_claim_failed");
    initialRepository.beginProviderDispatch(initialClaim.capability, ATTEMPT_0, NOW, "+14165550123");
    await initialRepository.recordProviderDispatchRejection({
      claim: initialClaim.capability,
      failure: ProviderFailure.transient("rate_limited"),
      now: NOW,
    });
    const barrier = new TestAttemptInsertBarrier(env.DB);
    const twilio = new TestControllableTwilioProvider();
    const policy = new RecordingPolicy();
    const leftRepository = createRepository(barrier.bindingForParticipant(0), () => NONCE_1);
    const rightBaseRepository = createRepository(barrier.bindingForParticipant(1), () => NONCE_2);
    const rightOrdinals: (0 | 1 | undefined)[] = [];
    const rightRepository = new Proxy(rightBaseRepository, {
      get(target, property) {
        if (property === "getOrCreateExpectedCall") {
          return async (input: Parameters<CallRepository["getOrCreateExpectedCall"]>[0]) => {
            rightOrdinals.push(input.attemptOrdinal);
            return target.getOrCreateExpectedCall(input);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const left = createDispatcher({ policy, twilio, repository: leftRepository, attemptIds: [ATTEMPT_1] });
    const right = createDispatcher({ policy, twilio, repository: rightRepository, attemptIds: [ATTEMPT_2] });

    const leftPending = left.dispatcher.dispatch(command());
    const rightPending = right.dispatcher.dispatch(command());
    await barrier.waitUntilBothInsertSelectsAreBlocked();
    expect(barrier.attemptIdForParticipant(0)).toBe(ATTEMPT_1);
    expect(barrier.attemptIdForParticipant(1)).toBe(ATTEMPT_2);
    barrier.releaseParticipant(0);
    await expect(leftPending).resolves.toMatchObject({ status: "dispatched", attemptId: ATTEMPT_1 });

    barrier.releaseParticipant(1);
    await expect(rightPending).resolves.toMatchObject({ status: "dispatched", attemptId: ATTEMPT_1 });
    expect(rightOrdinals).toEqual([1, 1]);
    expect(twilio.requests.map((request) => request.attemptId)).toEqual([ATTEMPT_1]);
    await expect(readAttempt(ATTEMPT_1)).resolves.toMatchObject({ attemptOrdinal: 1, relayNonce: NONCE_1 });
    await expect(readAttempt(ATTEMPT_2)).resolves.toBeNull();
  });

  it("dispatches one rate-limited retry under a new audited attempt and never a third", async () => {
    const subject = createDispatcher();
    subject.twilio.rejectNext(ProviderFailure.transient("rate_limited"));
    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "rejected", attemptId: ATTEMPT_0, retryEligible: true });
    subject.twilio.rejectNext(ProviderFailure.transient("rate_limited"));
    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "rejected", attemptId: ATTEMPT_1, retryEligible: false });
    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "rejected", attemptId: ATTEMPT_1, retryEligible: false });

    expect(subject.twilio.requests.map((request) => request.attemptId)).toEqual([ATTEMPT_0, ATTEMPT_1]);
    expect(subject.policy.rechecks.map((entry) => entry.attemptId)).toEqual([ATTEMPT_0, ATTEMPT_1]);
  });

  it("freezes command data before policy awaits and uses only audited dispatch values", async () => {
    const subject = createDispatcher();
    subject.policy.blockFinalRecheck();
    const mutable = { ...command() };
    const pending = subject.dispatcher.dispatch(mutable);
    await subject.policy.waitUntilBlocked();
    mutable.principalId = "attacker";
    mutable.destinationIdentityId = "attacker-destination";
    subject.policy.releaseFinalRecheck();

    await expect(pending).resolves.toMatchObject({ status: "dispatched" });
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ principalId: command().principalId, destinationIdentityId: command().destinationIdentityId });
    expect(subject.policy.rechecks[0]?.request).toEqual(command());
    expect(Object.isFrozen(subject.policy.rechecks[0]?.request)).toBe(true);
    expect(subject.twilio.requests[0]).toMatchObject({ attemptId: ATTEMPT_0, commandId: COMMAND_ID, toE164: AUDITED_DESTINATION });
  });

  it("snapshots the complete audited policy check before repository awaits", async () => {
    const repository = createRepository();
    let signalRepositoryBlocked: (() => void) | undefined;
    let releaseRepository: (() => void) | undefined;
    const repositoryBlocked = new Promise<void>((resolve) => { signalRepositoryBlocked = resolve; });
    const repositoryRelease = new Promise<void>((resolve) => { releaseRepository = resolve; });
    const blockedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "getOrCreateExpectedCall") {
          return async (...args: Parameters<CallRepository["getOrCreateExpectedCall"]>) => {
            signalRepositoryBlocked?.();
            await repositoryRelease;
            return target.getOrCreateExpectedCall(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const mutableCheck: DispatchPolicyCheck = {
      decision: "allow",
      reason: "allowed",
      checkedAt: NOW.toISOString(),
      checkId: CHECK_IDS[0],
      attemptId: ATTEMPT_0,
      commandId: COMMAND_ID,
      destinationE164: AUDITED_DESTINATION,
    };
    const policy: PolicyEngineContract = {
      evaluateOutboundCall: async () => ({ decision: "allow", reason: "allowed" }),
      recheckOutboundDispatch: async () => mutableCheck,
    };
    const twilio = new TestControllableTwilioProvider();
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy,
      twilio,
      repository: blockedRepository,
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => NOW,
    });

    const pending = dispatcher.dispatch(command());
    await repositoryBlocked;
    mutableCheck.destinationE164 = "+14165550999";
    mutableCheck.checkId = CHECK_IDS[1];
    releaseRepository?.();

    await expect(pending).resolves.toMatchObject({ status: "dispatched", attemptId: ATTEMPT_0 });
    expect(twilio.requests).toHaveLength(1);
    expect(twilio.requests[0]?.toE164).toBe(AUDITED_DESTINATION);
  });

  it.each([
    ["allow with a denial reason", {
      decision: "allow",
      reason: "kill_switch_enabled",
      checkedAt: NOW.toISOString(),
      checkId: CHECK_IDS[0],
      attemptId: ATTEMPT_0,
      commandId: COMMAND_ID,
      destinationE164: AUDITED_DESTINATION,
    }],
    ["deny with the allowed reason", {
      decision: "deny",
      reason: "allowed",
      checkedAt: NOW.toISOString(),
      checkId: CHECK_IDS[0],
      attemptId: ATTEMPT_0,
    }],
  ] as const)("rejects a semantically inconsistent policy result: %s", async (_label, check) => {
    const twilio = new TestControllableTwilioProvider();
    const policy: PolicyEngineContract = {
      evaluateOutboundCall: async () => ({ decision: "allow", reason: "allowed" }),
      recheckOutboundDispatch: async () => check,
    };
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy,
      twilio,
      repository: createRepository(),
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => NOW,
    });

    await expect(dispatcher.dispatch(command())).resolves.toEqual({
      status: "denied",
      reason: "invalid_dispatch_attempt",
      checkedAt: NOW.toISOString(),
      checkId: null,
      attemptId: ATTEMPT_0,
    });
    expect(twilio.requests).toHaveLength(0);
  });

  it("reads a provider result CallSid exactly once before validation and persistence", async () => {
    const requests: TwilioCreateCallInput[] = [];
    const callSids = [CALL_SID, CALL_SID_2, CALL_SID_3];
    let callSidReads = 0;
    const twilio: TwilioProvider = {
      async createCall(input) {
        requests.push(input);
        const result = {} as { callSid: string };
        Object.defineProperty(result, "callSid", {
          enumerable: true,
          get: () => callSids[Math.min(callSidReads++, callSids.length - 1)] ?? CALL_SID_3,
        });
        return result;
      },
    };
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy: new RecordingPolicy(),
      twilio,
      repository: createRepository(),
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => NOW,
    });

    await expect(dispatcher.dispatch(command())).resolves.toEqual({
      status: "dispatched",
      callSid: CALL_SID,
      attemptId: ATTEMPT_0,
    });
    expect(requests).toHaveLength(1);
    expect(callSidReads).toBe(1);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerCallSid: CALL_SID });
  });

  it("rejects a coercion-shaped provider CallSid without invoking user conversion", async () => {
    let coercions = 0;
    const twilio: TwilioProvider = {
      async createCall() {
        return {
          callSid: {
            toString() {
              coercions += 1;
              return CALL_SID;
            },
          } as never,
        };
      },
    };
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy: new RecordingPolicy(),
      twilio,
      repository: createRepository(),
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => NOW,
    });

    await expect(dispatcher.dispatch(command())).resolves.toEqual({
      status: "provider_dispatch_unknown",
      attemptId: ATTEMPT_0,
    });
    expect(coercions).toBe(0);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "provider_dispatch_unknown", providerCallSid: null });
  });

  it("binds provider results to the capability captured before the provider await", async () => {
    const repository = createRepository();
    await env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)")
      .bind(SECOND_COMMAND_ID, "b".repeat(64), NOW.toISOString()).run();
    await repository.getOrCreateExpectedCall({
      attemptId: ATTEMPT_2,
      commandId: SECOND_COMMAND_ID,
      principalId: command().principalId,
      destinationIdentityId: command().destinationIdentityId,
      idempotencyKey: "call:second",
      authorizationExpiresAt: command().authorizationExpiresAt,
      now: NOW,
      attemptOrdinal: 0,
    });
    const otherClaim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_2, now: NOW });
    if (otherClaim.kind !== "claimed") throw new Error("test_other_claim_failed");
    let swapCapability: (() => void) | undefined;
    let capabilityReads = 0;
    const wrappedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "claimProviderDispatch") {
          return async (input: { attemptId: Ulid; now: Date }) => {
            const claim = await target.claimProviderDispatch(input);
            if (input.attemptId !== ATTEMPT_0 || claim.kind !== "claimed") return claim;
            let capability = claim.capability;
            swapCapability = () => { capability = otherClaim.capability; };
            return {
              kind: "claimed" as const,
              get capability() {
                capabilityReads += 1;
                return capability;
              },
            };
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const twilio = new TestControllableTwilioProvider();
    twilio.blockNextResponse();
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy: new RecordingPolicy(),
      twilio,
      repository: wrappedRepository,
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => NOW,
    });

    const pending = dispatcher.dispatch(command());
    await twilio.waitForRequest();
    swapCapability?.();
    twilio.releaseResponse();

    await expect(pending).resolves.toMatchObject({ status: "dispatched", attemptId: ATTEMPT_0 });
    expect(capabilityReads).toBe(1);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "dispatched", providerCallSid: CALL_SID });
    await expect(readAttempt(ATTEMPT_2)).resolves.toMatchObject({ providerDispatchState: "claimed", providerCallSid: null });
  });

  it("rejects a genuine capability from a different attempt before any provider POST", async () => {
    const repository = createRepository();
    await env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)")
      .bind(SECOND_COMMAND_ID, "b".repeat(64), NOW.toISOString()).run();
    await repository.getOrCreateExpectedCall({
      attemptId: ATTEMPT_2,
      commandId: SECOND_COMMAND_ID,
      principalId: command().principalId,
      destinationIdentityId: command().destinationIdentityId,
      idempotencyKey: "call:second",
      authorizationExpiresAt: command().authorizationExpiresAt,
      now: NOW,
      attemptOrdinal: 0,
    });
    const otherClaim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_2, now: NOW });
    if (otherClaim.kind !== "claimed") throw new Error("test_other_claim_failed");
    const wrappedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "claimProviderDispatch") {
          return async (input: { attemptId: Ulid; now: Date }) => {
            const claim = await target.claimProviderDispatch(input);
            return input.attemptId === ATTEMPT_0 && claim.kind === "claimed"
              ? { kind: "claimed" as const, capability: otherClaim.capability }
              : claim;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const twilio = new TestControllableTwilioProvider();
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy: new RecordingPolicy(),
      twilio,
      repository: wrappedRepository,
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => NOW,
    });

    await expect(dispatcher.dispatch(command())).resolves.toEqual({
      status: "provider_dispatch_unknown",
      attemptId: ATTEMPT_0,
    });
    expect(twilio.requests).toHaveLength(0);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "claimed", providerCallSid: null });
    await expect(readAttempt(ATTEMPT_2)).resolves.toMatchObject({ providerDispatchState: "claimed", providerCallSid: null });
    expect(() => repository.beginProviderDispatch(otherClaim.capability, ATTEMPT_2, NOW, "+14165550123")).not.toThrow();
  });

  it("rejects a forged claimed wrapper before any provider POST", async () => {
    const repository = createRepository();
    const wrappedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "claimProviderDispatch") {
          return async (input: { attemptId: Ulid; now: Date }) => ({
            kind: "claimed" as const,
            capability: { attemptId: input.attemptId } as ProviderDispatchClaimCapability,
          });
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const twilio = new TestControllableTwilioProvider();
    const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
      policy: new RecordingPolicy(),
      twilio,
      repository: wrappedRepository,
      publicBaseUrl: new URL("https://jarvis.example/"),
      newAttemptId: () => ATTEMPT_0,
      now: () => NOW,
    });

    await expect(dispatcher.dispatch(command())).resolves.toEqual({
      status: "provider_dispatch_unknown",
      attemptId: ATTEMPT_0,
    });
    expect(twilio.requests).toHaveLength(0);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "ready", providerCallSid: null });
  });

  it("does not dial a phone number that changed between policy approval and the claim", async () => {
    const repository = createRepository();
    const original = repository.getOrCreateExpectedCall.bind(repository);
    vi.spyOn(repository, "getOrCreateExpectedCall").mockImplementation(async (input) => {
      const expected = await original(input);
      await env.DB.prepare("UPDATE channel_identities SET provider_subject = '+14165550199' WHERE identity_id = 'identity:voice'").run();
      return expected;
    });
    const twilio = new TestControllableTwilioProvider();
    const dispatcher = new OutboundCallDispatcher({ controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} }, policy: new RecordingPolicy(), twilio, repository,
      publicBaseUrl: new URL("https://jarvis.example/"), newAttemptId: () => ATTEMPT_0, now: () => NOW });
    await expect(dispatcher.dispatch(command())).resolves.toMatchObject({ status: "denied", reason: "invalid_dispatch_attempt" });
    expect(twilio.requests).toEqual([]);
    await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "rejected", providerCallSid: null });
  });

  it.each(["disabled", "unreadable", "malformed", "quiet", "authorization", "nonce", "day", "rollback"] as const)(
    "settles the claimed slot without a POST when final controls or the claim clock refuse: %s", async (fault) => {
      let now = fault === "day" ? new Date("2026-08-30T23:59:59.000Z") : NOW;
      const request = { ...command(), authorizationExpiresAt:
        new Date(now.valueOf() + (fault === "authorization" ? 1_000 : 300_000)).toISOString() };
      const repository = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE_0,
        fault === "nonce" ? 1_000 : 300_000);
      const twilio = new TestControllableTwilioProvider();
      const dispatcher = new OutboundCallDispatcher({
      capacity: { async assertAcceptingNewTurn() {} }, policy: new RecordingPolicy(), twilio, repository,
        publicBaseUrl: new URL("https://jarvis.example/"), newAttemptId: () => ATTEMPT_0, now: () => now,
        controls: { async readControls() {
          if (fault === "unreadable") throw new Error("synthetic control read failed");
          if (fault === "authorization") now = new Date(request.authorizationExpiresAt);
          if (fault === "nonce") now = new Date(NOW.valueOf() + 1_000);
          if (fault === "day") now = new Date("2026-08-31T00:00:00.000Z");
          if (fault === "rollback") now = new Date(NOW.valueOf() - 1);
          if (fault === "quiet") now = new Date(NOW.valueOf() + 1_000);
          return { enabled: fault === "malformed" ? "true" as never : fault !== "disabled",
            quietStartsAt: fault === "quiet" ? new Date(NOW.valueOf() + 1_000).toISOString() : null,
            quietEndsAt: fault === "quiet" ? new Date(NOW.valueOf() + 2_000).toISOString() : null };
        } },
      });
      const result = await dispatcher.dispatch(request);
      expect(result.status).not.toBe("dispatched");
      expect(twilio.requests).toEqual([]);
      await expect(readAttempt(ATTEMPT_0)).resolves.toMatchObject({ providerDispatchState: "rejected", providerCallSid: null });
      await expect(repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW })).resolves.toMatchObject({
        kind: "rejected",
        retryEligible: false,
      });
    },
  );

  it("constructs trusted callback routes from attempt identity while retaining command lineage", async () => {
    const subject = createDispatcher();
    await subject.dispatcher.dispatch(command());

    expect(subject.twilio.requests[0]).toMatchObject({ attemptId: ATTEMPT_0, commandId: COMMAND_ID, idempotencyKey: ATTEMPT_0 });
    expect(subject.twilio.requests[0]?.twimlUrl.toString()).toBe(`https://jarvis.example/voice/outbound/${ATTEMPT_0}`);
    expect(subject.twilio.requests[0]?.statusCallbackUrl.toString()).toBe(`https://jarvis.example/voice/status/${ATTEMPT_0}#rc=2&rp=ct,rt,5xx`);
  });
});
