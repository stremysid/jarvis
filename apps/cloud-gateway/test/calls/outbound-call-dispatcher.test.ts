import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutboundCallCommand, Ulid } from "../../../../packages/contracts/src/index.js";
import { OutboundCallDispatcher } from "../../src/calls/outbound-call-dispatcher.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import type { DispatchPolicyCheck, OutboundCallRequest, PolicyDecision, PolicyEngineContract } from "../../src/policy/policy-types.js";
import {
  ProviderDispatchUnknownError,
  ProviderFailure,
  type TwilioCreateCallInput,
  type TwilioProvider,
} from "../../src/providers/provider-types.js";
import { applyFoundationMigration } from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const COMMAND_ID = "01k3s6k8000000000000000000" as Ulid;
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
const AUDITED_DESTINATION = "+14165550123";
const NONCE_0 = `${"A".repeat(42)}A`;
const NONCE_1 = `${"B".repeat(42)}E`;

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
  private releaseGate: (() => void) | undefined;
  private arrivalGate: (() => void) | undefined;
  private readonly released = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  private readonly bothArrived = new Promise<void>((resolve) => { this.arrivalGate = resolve; });

  constructor(private readonly database: D1Database) {}

  bindingForParticipant(participant: number): D1Database {
    const barrier = this;
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
                      await barrier.released;
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

  releaseBoth(): void {
    this.releaseGate?.();
  }
}

async function clearData(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM provider_events"),
    env.DB.prepare("DELETE FROM outbound_call_attempts"),
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
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'owner', '1.0', 'PIN_VERIFIER_JSON', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', ?, 'active', ?, ?)").bind(AUDITED_DESTINATION, timestamp, timestamp),
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
    destination_identity_id AS destinationIdentityId, relay_nonce AS relayNonce,
    provider_dispatch_state AS providerDispatchState FROM outbound_call_attempts WHERE attempt_id = ?`)
    .bind(attemptId).first<Record<string, unknown>>();
}

describe("OutboundCallDispatcher", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearData();
    await seedAuthorizedCommand();
  });

  afterEach(clearData);

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

  it("recovers a ready row by claiming it before the only provider POST", async () => {
    const subject = createDispatcher();
    await subject.repository.getOrCreateExpectedCall({ attemptId: ATTEMPT_0, commandId: COMMAND_ID, principalId: command().principalId, destinationIdentityId: command().destinationIdentityId, idempotencyKey: command().idempotencyKey, now: NOW });

    await expect(subject.dispatcher.dispatch(command())).resolves.toMatchObject({ status: "dispatched", attemptId: ATTEMPT_0 });
    expect(subject.policy.rechecks.map((entry) => entry.attemptId)).toEqual([ATTEMPT_0]);
    expect(subject.twilio.requests).toHaveLength(1);
  });

  it("suppresses recovery after a crash immediately following the durable claim", async () => {
    const subject = createDispatcher();
    await subject.repository.getOrCreateExpectedCall({ attemptId: ATTEMPT_0, commandId: COMMAND_ID, principalId: command().principalId, destinationIdentityId: command().destinationIdentityId, idempotencyKey: command().idempotencyKey, now: NOW });
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
    expect(results.map((result) => result.attemptId)).toEqual([winner, winner]);
    await expect(readAttempt(winner)).resolves.toMatchObject({ relayNonce: winner === ATTEMPT_0 ? NONCE_0 : NONCE_1 });
    expect(policy.rechecks.filter((entry) => entry.attemptId === winner)).toHaveLength(2);
    expect(twilio.requests).toHaveLength(1);
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

  it("constructs trusted callback routes from attempt identity while retaining command lineage", async () => {
    const subject = createDispatcher();
    await subject.dispatcher.dispatch(command());

    expect(subject.twilio.requests[0]).toMatchObject({ attemptId: ATTEMPT_0, commandId: COMMAND_ID, idempotencyKey: ATTEMPT_0 });
    expect(subject.twilio.requests[0]?.twimlUrl.toString()).toBe(`https://jarvis.example/voice/outbound/${ATTEMPT_0}`);
    expect(subject.twilio.requests[0]?.statusCallbackUrl.toString()).toBe(`https://jarvis.example/voice/status/${ATTEMPT_0}`);
  });
});
