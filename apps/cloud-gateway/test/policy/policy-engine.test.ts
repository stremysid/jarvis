import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type OutboundCallCommand, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { PolicyAudit } from "../../src/policy/policy-audit.js";
import { PolicyEngine, snapshotOutboundCallRequest, type MutablePolicyContext } from "../../src/policy/policy-engine.js";
import { applyFoundationMigration } from "../persistence/migration.js";

const instant = new Date("2026-08-30T12:00:00.000Z");
const expires = "2026-08-30T12:05:00.000Z";
const ATTEMPT_0 = "01k3s6k8000000000000000009" as Ulid;
const ATTEMPT_1 = "01k3s6k800000000000000000a" as Ulid;
const CHECK_0 = "01k3s6k800000000000000000b" as Ulid;
const CHECK_1 = "01k3s6k800000000000000000c" as Ulid;
const CHECK_2 = "01k3s6k800000000000000000d" as Ulid;
const CHECK_3 = "01k3s6k800000000000000000e" as Ulid;

class TestContext implements MutablePolicyContext {
  public killSwitch = false;
  public quiet = false;
  public concurrentCalls = 0;
  public dailyCalls = 0;
  public retries = 0;
  public nowValue = instant;
  public quietHours = () => this.quiet;
  public originGate: Promise<void> | undefined;
  public readonly origins = new Map<string, { principalId: string; issuedBy: "telegram_call_command" | "local_cli"; commandHash: Sha256Hex }>();

  now(): Date { return this.nowValue; }
  isQuietHours(now: Date): boolean { return this.quietHours(now); }
  activeOutboundCalls(): number | Promise<number> { return this.concurrentCalls; }
  outboundCallsForUtcPolicyDay(): number | Promise<number> { return this.dailyCalls; }
  retryCount(): number { return this.retries; }
  async authenticatedOrigin(commandId: string): Promise<{ principalId: string; issuedBy: "telegram_call_command" | "local_cli"; commandHash: Sha256Hex } | null> { await this.originGate; return this.origins.get(commandId) ?? null; }
  async trust(input: OutboundCallCommand, origin = { principalId: input.principalId, issuedBy: "telegram_call_command" as const }): Promise<void> {
    this.origins.set(input.commandId, { ...origin, commandHash: await sha256Hex(canonicalJson(input)) });
  }
}

async function insertPrincipalAndIdentity(principalId = "principal:owner", identityId = "identity:voice", identityPrincipalId = principalId, status = "active", verifiedAt: string | null = instant.toISOString()): Promise<void> {
  await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES (?, 'human', 'active', 'test', '1.0', 'PIN_VERIFIER_JSON', ?, ?)")
    .bind(principalId, instant.toISOString(), instant.toISOString()).run();
  await env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES (?, ?, 'voice', '+14165550123', ?, ?, ?)")
    .bind(identityId, identityPrincipalId, status, verifiedAt, instant.toISOString()).run();
}

function request(overrides: Partial<OutboundCallCommand> = {}): OutboundCallCommand {
  return {
    commandId: "01k3s6k8000000000000000000" as OutboundCallCommand["commandId"], principalId: "principal:owner", purposeCode: "user_requested",
    destinationIdentityId: "identity:voice", urgency: "normal", authorizationExpiresAt: expires, idempotencyKey: "call:test", issuedBy: "telegram_call_command", ...overrides,
  };
}

describe("PolicyEngine", () => {
  let context: TestContext;
  let policy: PolicyEngine;
  let checkIds: Ulid[];

  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM channel_identities"), env.DB.prepare("DELETE FROM policy_decisions"), env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare("DELETE FROM outbox"), env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
    ]);
    await insertPrincipalAndIdentity();
    context = new TestContext();
    checkIds = [CHECK_0, CHECK_1, CHECK_2, CHECK_3];
    policy = new PolicyEngine({ database: env.DB, events: new EventRepository(env.DB), context, newUlid: () => checkIds.shift() ?? CHECK_3 });
  });

  async function evaluate(input: OutboundCallCommand): Promise<unknown> {
    try { await context.trust(input); } catch { /* malformed input has no trusted canonical record */ }
    return policy.evaluateOutboundCall(input);
  }

  async function recheck(input: OutboundCallCommand, attemptId = ATTEMPT_0): Promise<unknown> {
    await context.trust(input);
    return policy.recheckOutboundDispatch(input, attemptId);
  }

  afterEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM channel_identities"), env.DB.prepare("DELETE FROM policy_decisions"), env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare("DELETE FROM outbox"), env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
    ]);
  });

  it("denies model and unknown origins and persists immutable decisions", async () => {
    await expect(evaluate(request({ issuedBy: "model" as never }))).resolves.toMatchObject({ decision: "deny", reason: "invalid_origin" });
    await expect(evaluate(request({ commandId: "01k3s6k8000000000000000007" as never, issuedBy: "unknown" as never }))).resolves.toMatchObject({ decision: "deny", reason: "invalid_origin" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM policy_decisions").first<{ count: number }>())?.count).toBe(2);
  });

  it("fails closed for invalid purposes and destination ownership or verification failures", async () => {
    await expect(evaluate(request({ purposeCode: "model" as never }))).resolves.toMatchObject({ reason: "invalid_purpose" });
    await expect(evaluate(request({ commandId: "01k3s6k8000000000000000008" as never, purposeCode: undefined as never }))).resolves.toMatchObject({ reason: "invalid_request" });
    await env.DB.prepare("UPDATE channel_identities SET verified_at = NULL, status = 'pending' WHERE identity_id = 'identity:voice'").run();
    await expect(evaluate(request({ commandId: "01k3s6k8000000000000000001" as never }))).resolves.toMatchObject({ reason: "destination_not_verified" });
    await env.DB.prepare("UPDATE channel_identities SET verified_at = ?, status = 'disabled' WHERE identity_id = 'identity:voice'").bind(instant.toISOString()).run();
    await expect(evaluate(request({ commandId: "01k3s6k8000000000000000002" as never }))).resolves.toMatchObject({ reason: "destination_not_verified" });
    await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:foreign', 'service', 'active', 'foreign', ?, ?)").bind(instant.toISOString(), instant.toISOString()).run();
    await env.DB.prepare("UPDATE channel_identities SET principal_id = 'principal:foreign', status = 'active' WHERE identity_id = 'identity:voice'").run();
    await expect(evaluate(request({ commandId: "01k3s6k8000000000000000003" as never }))).resolves.toMatchObject({ reason: "destination_not_verified" });
  });

  it("treats expiry equality and malformed expiry as expired", async () => {
    await expect(evaluate(request({ authorizationExpiresAt: instant.toISOString() }))).resolves.toMatchObject({ reason: "authorization_expired" });
    await expect(evaluate(request({ commandId: "01k3s6k8000000000000000004" as never, authorizationExpiresAt: "not-a-time" }))).resolves.toMatchObject({ reason: "invalid_request" });
  });

  it.each([
    ["kill switch", (value: TestContext) => { value.killSwitch = true; }, "kill_switch_enabled"],
    ["quiet hours", (value: TestContext) => { value.quiet = true; }, "quiet_hours"],
    ["concurrency", (value: TestContext) => { value.concurrentCalls = 2; }, "concurrency_limit"],
    ["daily cap", (value: TestContext) => { value.dailyCalls = 6; }, "daily_limit"],
  ] as const)("denies %s", async (_label, configure, reason) => {
    configure(context);
    await expect(evaluate(request())).resolves.toMatchObject({ decision: "deny", reason });
  });

  it("uses durable attempt rows instead of a caller-supplied retry counter", async () => {
    context.retries = 2;

    await expect(evaluate(request())).resolves.toEqual({ decision: "allow", reason: "allowed" });
  });

  it("uses the supplied clock at the quiet-hours boundary", async () => {
    context.nowValue = new Date("2026-08-30T22:00:00.000Z");
    context.quietHours = (now) => now.toISOString() >= "2026-08-30T22:00:00.000Z";
    await expect(evaluate(request({ authorizationExpiresAt: "2026-08-30T22:05:00.000Z" }))).resolves.toMatchObject({ reason: "quiet_hours" });
  });

  it("allows an eligible command and replays its first immutable decision", async () => {
    const first = await evaluate(request());
    context.killSwitch = true;
    const replay = await evaluate(request());
    expect(first).toEqual({ decision: "allow", reason: "allowed" });
    expect(replay).toEqual(first);
    expect(await env.DB.prepare("SELECT outcome, reason_code FROM policy_decisions WHERE decision_id = ?").bind(request().commandId).first()).toEqual({ outcome: "allow", reason_code: "allowed" });
  });

  it("fails closed when a command id is reused with a changed canonical command", async () => {
    await evaluate(request());
    await expect(evaluate(request({ urgency: "urgent" }))).resolves.toEqual({ decision: "deny", reason: "policy_command_conflict" });
  });

  it("concurrently evaluates duplicate commands without overwriting the first decision", async () => {
    await context.trust(request());
    const results = await Promise.all(Array.from({ length: 2 }, () => policy.evaluateOutboundCall(request())));
    expect(results).toEqual([{ decision: "allow", reason: "allowed" }, { decision: "allow", reason: "allowed" }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM policy_decisions WHERE decision_id = ?").bind(request().commandId).first<{ count: number }>())?.count).toBe(1);
  });

  it("rechecks mutable guards at dispatch time and appends a redaction-safe audit event", async () => {
    await evaluate(request());
    context.killSwitch = true;
    await expect(recheck(request())).resolves.toMatchObject({
      decision: "deny",
      reason: "kill_switch_enabled",
      checkedAt: instant.toISOString(),
      checkId: CHECK_0,
      attemptId: ATTEMPT_0,
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ count: number }>())?.count).toBe(1);
    const stored = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ envelope_json: string }>();
    expect(stored?.envelope_json).not.toContain("+14165550123");
  });

  it("resamples time after asynchronous guards and denies authorization that expires while blocked", async () => {
    const expiring = request({ authorizationExpiresAt: "2026-08-30T12:00:01.000Z" });
    await evaluate(expiring);
    let signalCountBlocked: (() => void) | undefined;
    let releaseCount: (() => void) | undefined;
    const countBlocked = new Promise<void>((resolve) => { signalCountBlocked = resolve; });
    const countRelease = new Promise<void>((resolve) => { releaseCount = resolve; });
    context.activeOutboundCalls = async () => {
      signalCountBlocked?.();
      await countRelease;
      return 0;
    };

    const pending = policy.recheckOutboundDispatch(expiring, ATTEMPT_0);
    await countBlocked;
    context.nowValue = new Date(expiring.authorizationExpiresAt);
    releaseCount?.();

    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason: "authorization_expired",
      checkedAt: expiring.authorizationExpiresAt,
      checkId: CHECK_0,
      attemptId: ATTEMPT_0,
    });
  });

  it("rejects a Number-like active-call fact before any later mutable callback can affect it", async () => {
    await evaluate(request());
    let numericValue = 0;
    let coercions = 0;
    let dailyReads = 0;
    context.activeOutboundCalls = () => ({
      valueOf() {
        coercions += 1;
        return numericValue;
      },
    }) as never;
    context.outboundCallsForUtcPolicyDay = () => {
      dailyReads += 1;
      numericValue = 2;
      return 0;
    };

    await expect(policy.recheckOutboundDispatch(request(), ATTEMPT_0)).resolves.toMatchObject({
      decision: "deny",
      reason: "invalid_dispatch_attempt",
      checkId: CHECK_0,
      attemptId: ATTEMPT_0,
    });
    expect({ dailyReads, coercions }).toEqual({ dailyReads: 0, coercions: 0 });
  });

  it.each([
    ["NaN", Number.NaN],
    ["undefined", undefined],
    ["negative", -1],
  ] as const)("rejects a malformed %s daily-call fact", async (_label, dailyCalls) => {
    await evaluate(request());
    context.outboundCallsForUtcPolicyDay = () => dailyCalls as never;

    await expect(policy.recheckOutboundDispatch(request(), ATTEMPT_0)).resolves.toMatchObject({
      decision: "deny",
      reason: "invalid_dispatch_attempt",
      checkId: CHECK_0,
      attemptId: ATTEMPT_0,
    });
  });

  it.each([
    ["kill switch", (value: TestContext) => { value.killSwitch = "false" as never; }],
    ["quiet-hours result", (value: TestContext) => { value.quietHours = () => "false" as never; }],
  ] as const)("rejects a malformed %s policy fact", async (_label, mutate) => {
    await evaluate(request());
    mutate(context);

    await expect(policy.recheckOutboundDispatch(request(), ATTEMPT_0)).resolves.toMatchObject({
      decision: "deny",
      reason: "invalid_dispatch_attempt",
      checkId: CHECK_0,
      attemptId: ATTEMPT_0,
    });
  });

  it("requeries daily usage when the policy day rolls over before the final audit sample", async () => {
    const nearMidnight = new Date("2026-08-30T23:59:59.999Z");
    const afterMidnight = new Date("2026-08-31T00:00:00.000Z");
    const rolloverRequest = request({ authorizationExpiresAt: "2026-08-31T00:05:00.000Z" });
    context.nowValue = nearMidnight;
    await evaluate(rolloverRequest);
    const queriedDays: string[] = [];
    context.outboundCallsForUtcPolicyDay = async (_principalId: string, utcPolicyDay: string) => {
      queriedDays.push(utcPolicyDay);
      if (queriedDays.length === 1) context.nowValue = afterMidnight;
      return utcPolicyDay === "2026-08-31" ? 6 : 0;
    };

    await expect(policy.recheckOutboundDispatch(rolloverRequest, ATTEMPT_0)).resolves.toMatchObject({
      decision: "deny",
      reason: "daily_limit",
      checkedAt: afterMidnight.toISOString(),
      checkId: CHECK_0,
      attemptId: ATTEMPT_0,
    });
    expect(queriedDays).toEqual(["2026-08-30", "2026-08-31"]);
  });

  it("keeps the sampled policy day and audit instant stable when quiet-hours mutates its Date", async () => {
    const nearMidnight = new Date("2026-08-30T23:59:59.999Z");
    const expectedCheckedAt = nearMidnight.toISOString();
    const rolloverRequest = request({ authorizationExpiresAt: "2026-08-31T00:05:00.000Z" });
    context.nowValue = nearMidnight;
    await evaluate(rolloverRequest);
    context.nowValue = nearMidnight;
    const queriedDays: string[] = [];
    context.outboundCallsForUtcPolicyDay = (_principalId: string, utcPolicyDay: string) => {
      queriedDays.push(utcPolicyDay);
      return 0;
    };
    context.quietHours = (candidate) => {
      candidate.setTime(new Date("2026-08-31T00:00:00.000Z").valueOf());
      return false;
    };

    await expect(policy.recheckOutboundDispatch(rolloverRequest, ATTEMPT_0)).resolves.toMatchObject({
      decision: "allow",
      reason: "allowed",
      checkedAt: expectedCheckedAt,
      checkId: CHECK_0,
      attemptId: ATTEMPT_0,
    });
    expect(queriedDays).toEqual(["2026-08-30"]);
  });

  it("returns the active verified E.164 only with an audited allow", async () => {
    await evaluate(request());

    await expect(recheck(request())).resolves.toEqual({
      decision: "allow",
      reason: "allowed",
      checkedAt: instant.toISOString(),
      checkId: CHECK_0,
      attemptId: ATTEMPT_0,
      destinationE164: "+14165550123",
      commandId: request().commandId,
    });
    const stored = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ envelope_json: string }>();
    expect(stored?.envelope_json).not.toContain("+14165550123");
  });

  it("denies dispatch without a matching allowed authorization", async () => {
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "authorization_missing" });
    await evaluate(request({ commandId: "01k3s6k8000000000000000005" as never, issuedBy: "model" as never }));
    await expect(recheck(request({ commandId: "01k3s6k8000000000000000005" as never, issuedBy: "model" as never }))).resolves.toMatchObject({ decision: "deny", reason: "authorization_denied" });
    await evaluate(request({ commandId: "01k3s6k8000000000000000006" as never }));
    await expect(recheck(request({ commandId: "01k3s6k8000000000000000006" as never, urgency: "urgent" }))).resolves.toMatchObject({ decision: "deny", reason: "policy_command_conflict" });
  });

  it("fails closed when dispatch audit persistence fails", async () => {
    const failing = new PolicyEngine({
      database: env.DB,
      context,
      events: {
        append: async () => { throw new Error("D1 unavailable"); },
        latestSequence: async () => 0,
        readRange: async () => [],
      },
    });
    await context.trust(request());
    await failing.evaluateOutboundCall(request());
    await expect(failing.recheckOutboundDispatch(request(), ATTEMPT_0)).resolves.toMatchObject({ decision: "deny", reason: "audit_persistence_failed" });
  });

  it("rejects malformed request shapes before hashing or persistence without command-id aliasing", async () => {
    const extra = { ...request(), extra: "untrusted" };
    const undefinedValue = { ...request(), idempotencyKey: undefined };
    const accessor = { ...request() };
    Object.defineProperty(accessor, "purposeCode", { enumerable: true, get: () => "user_requested" });
    const symbol = { ...request() };
    Object.defineProperty(symbol, Symbol("untrusted"), { enumerable: true, value: "untrusted" });
    const inherited = Object.assign(Object.create({ issuedBy: "telegram_call_command" }), request());

    for (const malformed of [extra, undefinedValue, accessor, symbol, inherited]) {
      await expect(policy.evaluateOutboundCall(malformed as never)).resolves.toEqual({ decision: "deny", reason: "invalid_request" });
    }
    await expect(policy.evaluateOutboundCall({ ...request(), commandId: request().commandId, destinationIdentityId: "identity:changed", extra: "different" } as never)).resolves.toEqual({ decision: "deny", reason: "invalid_request" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM policy_decisions").first<{ count: number }>())?.count).toBe(0);
  });

  it("requires an authoritative trusted origin record rather than request-controlled origin fields", async () => {
    await expect(policy.evaluateOutboundCall(request({ issuedBy: "local_cli" }))).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
    const principalMismatch = request({ commandId: "01k3s6k800000000000000000a" as never });
    await context.trust(principalMismatch, { principalId: "principal:other", issuedBy: "telegram_call_command" });
    await expect(policy.evaluateOutboundCall(principalMismatch)).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
    const channelMismatch = request({ commandId: "01k3s6k800000000000000000b" as never });
    await context.trust(channelMismatch, { principalId: channelMismatch.principalId, issuedBy: "local_cli" });
    await expect(policy.evaluateOutboundCall(channelMismatch)).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
  });

  it("binds trusted ingress to the exact canonical command before the first decision", async () => {
    await env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:alternate', 'principal:owner', 'voice', 'opaque-alternate', 'active', ?, ?)")
      .bind(instant.toISOString(), instant.toISOString()).run();
    const substitutions = [
      [request({ commandId: "01k3s6k800000000000000000e" as never }), request({ commandId: "01k3s6k800000000000000000e" as never, destinationIdentityId: "identity:alternate" })],
      [request({ commandId: "01k3s6k800000000000000000f" as never }), request({ commandId: "01k3s6k800000000000000000f" as never, purposeCode: "smoke" })],
      [request({ commandId: "01k3s6k800000000000000000g" as never }), request({ commandId: "01k3s6k800000000000000000g" as never, authorizationExpiresAt: "2026-08-30T12:06:00.000Z" })],
    ] as const;

    for (const [trusted, submitted] of substitutions) {
      await context.trust(trusted);
      await expect(policy.evaluateOutboundCall(submitted)).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM policy_decisions WHERE outcome = 'allow'").first<{ count: number }>())?.count).toBe(0);
  });

  it("fails closed for a missing or malformed trusted command hash", async () => {
    await context.trust(request());
    const origin = context.origins.get(request().commandId);
    if (origin === undefined) throw new Error("missing test origin");
    origin.commandHash = "not-a-sha256-hash" as Sha256Hex;
    await expect(policy.evaluateOutboundCall(request())).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
    const missingHash = request({ commandId: "01k3s6k800000000000000000h" as never });
    await context.trust(missingHash);
    const originWithoutHash = context.origins.get(missingHash.commandId);
    if (originWithoutHash === undefined) throw new Error("missing test origin");
    delete (originWithoutHash as { commandHash?: Sha256Hex }).commandHash;
    await expect(policy.evaluateOutboundCall(missingHash)).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
  });

  it("rechecks destination identity ownership and verification after authorization", async () => {
    await evaluate(request());
    await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:voice'").run();
    const check = await recheck(request()) as Record<string, unknown>;
    expect(check).toMatchObject({ decision: "deny", reason: "destination_not_verified" });
    expect(check).not.toHaveProperty("destinationE164");
  });

  it("never dispatches an unvalidated provider destination", async () => {
    await evaluate(request());
    await env.DB.prepare("UPDATE channel_identities SET provider_subject = 'not-an-e164' WHERE identity_id = 'identity:voice'").run();

    const check = await recheck(request()) as Record<string, unknown>;

    expect(check).toMatchObject({ decision: "deny", reason: "destination_not_verified" });
    expect(check).not.toHaveProperty("destinationE164");
  });

  it("rechecks destination unverification and deletion after authorization", async () => {
    await evaluate(request());
    await env.DB.prepare("UPDATE channel_identities SET verified_at = NULL, status = 'pending' WHERE identity_id = 'identity:voice'").run();
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "destination_not_verified" });
    await env.DB.prepare("DELETE FROM channel_identities WHERE identity_id = 'identity:voice'").run();
    await expect(recheck(request(), ATTEMPT_1)).resolves.toMatchObject({ decision: "deny", reason: "destination_not_verified" });
  });

  it("rechecks destination reassignment after authorization", async () => {
    await evaluate(request());
    await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:other', 'service', 'active', 'other', ?, ?)").bind(instant.toISOString(), instant.toISOString()).run();
    await env.DB.prepare("UPDATE channel_identities SET principal_id = 'principal:other' WHERE identity_id = 'identity:voice'").run();
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "destination_not_verified" });
  });

  it("revalidates the trusted origin record at dispatch time", async () => {
    await evaluate(request());
    await context.trust(request(), { principalId: request().principalId, issuedBy: "local_cli" });
    await expect(policy.recheckOutboundDispatch(request(), ATTEMPT_0)).resolves.toMatchObject({ decision: "deny", reason: "invalid_origin" });
  });

  it("revalidates the trusted canonical command hash at dispatch time", async () => {
    await evaluate(request());
    const origin = context.origins.get(request().commandId);
    if (origin === undefined) throw new Error("missing test origin");
    origin.commandHash = "0".repeat(64) as Sha256Hex;
    await expect(policy.recheckOutboundDispatch(request(), ATTEMPT_0)).resolves.toMatchObject({ decision: "deny", reason: "invalid_origin" });
  });

  it("does not replay a prior allow when the authoritative origin binding is later absent", async () => {
    await evaluate(request());
    context.origins.delete(request().commandId);
    await expect(policy.evaluateOutboundCall(request())).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
  });

  it("returns command conflict before trusted-origin lookup for a changed canonical command", async () => {
    await evaluate(request());
    context.origins.delete(request().commandId);
    await expect(policy.evaluateOutboundCall(request({ urgency: "urgent" }))).resolves.toEqual({ decision: "deny", reason: "policy_command_conflict" });
  });

  it("does not let an unauthenticated evaluator inherit a concurrent trusted allow", async () => {
    let releaseGate: (() => void) | undefined;
    const untrustedContext = new TestContext();
    untrustedContext.originGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const untrusted = new PolicyEngine({ database: env.DB, events: new EventRepository(env.DB), context: untrustedContext });
    const pending = untrusted.evaluateOutboundCall(request());
    await Promise.resolve();
    await evaluate(request());
    releaseGate?.();
    await expect(pending).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
  });

  it("uses a distinct check identity for every audit of one stable attempt", async () => {
    await evaluate(request());
    await expect(recheck(request())).resolves.toMatchObject({ decision: "allow", reason: "allowed" });
    context.nowValue = new Date("2026-08-30T12:00:01.000Z");
    await expect(recheck(request())).resolves.toMatchObject({ decision: "allow", reason: "allowed" });
    const rows = await env.DB.prepare("SELECT event_id, envelope_json FROM events WHERE event_type = 'policy.dispatch_checked' ORDER BY sequence").all<{ event_id: string; envelope_json: string }>();
    expect(rows.results.map((row) => row.event_id)).toEqual([CHECK_0, CHECK_1]);
    for (const row of rows.results) {
      expect(row.envelope_json).toContain(ATTEMPT_0);
      expect(row.envelope_json).toContain(request().commandId);
      expect(row.envelope_json).toContain(row.event_id);
    }
  });

  it("uses a new stable attempt identity for a second dispatch check", async () => {
    await evaluate(request());
    await recheck(request());
    await recheck(request(), ATTEMPT_1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ count: number }>())?.count).toBe(2);
  });

  it("records a later changed result as distinct evidence for the same attempt", async () => {
    await evaluate(request());
    await recheck(request());
    context.killSwitch = true;
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "kill_switch_enabled", attemptId: ATTEMPT_0, checkId: CHECK_1 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ count: number }>())?.count).toBe(2);
  });

  it("fails closed for a malformed dispatcher-selected attempt identity", async () => {
    await evaluate(request());
    await context.trust(request());
    await expect(policy.recheckOutboundDispatch(request(), "not-a-ulid" as Ulid)).resolves.toMatchObject({ decision: "deny", reason: "invalid_dispatch_attempt" });
  });

  it("fails closed when the audit check identity factory returns a malformed ULID", async () => {
    await evaluate(request());
    await context.trust(request());
    const malformed = new PolicyEngine({ database: env.DB, events: new EventRepository(env.DB), context, newUlid: () => "not-a-ulid" as Ulid });
    await expect(malformed.recheckOutboundDispatch(request(), ATTEMPT_0)).resolves.toMatchObject({ decision: "deny", reason: "invalid_dispatch_attempt" });
  });

  it("exports the same accessor-safe frozen request snapshot used by policy and dispatch", () => {
    const snapshot = snapshotOutboundCallRequest(request());
    const accessor = { ...request() };
    Object.defineProperty(accessor, "principalId", { enumerable: true, get: () => "attacker" });

    expect(snapshot).toEqual(request());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshotOutboundCallRequest(accessor)).toBeNull();
  });

  it("preserves exact reconstructible audit linkage when identifiers contain six-digit runs", async () => {
    const commandId = "01k3s6ka123456b00000000000" as Ulid;
    const attemptId = "01k3s6kb123456c00000000000" as Ulid;
    const checkId = "01k3s6kc123456d00000000000" as Ulid;
    const inputHash = `a123456b${"c".repeat(56)}` as Sha256Hex;
    await new PolicyAudit(new EventRepository(env.DB)).appendDispatchCheck({
      checkId,
      attemptId,
      commandId,
      principalId: "principal:owner",
      inputHash,
      check: { decision: "allow", reason: "allowed", checkedAt: instant.toISOString() },
    });

    const stored = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_id = ?")
      .bind(checkId).first<{ envelope_json: string }>();
    const envelope = JSON.parse(stored?.envelope_json ?? "null") as {
      eventId: string;
      correlationId: string;
      causationId: string;
      payload: { linkage: Record<string, number[]> };
    };
    const decode = (bytes: number[]) => new TextDecoder().decode(Uint8Array.from(bytes));

    expect(envelope).toMatchObject({ eventId: checkId, correlationId: attemptId, causationId: commandId });
    expect(decode(envelope.payload.linkage.checkIdUtf8 ?? [])).toBe(checkId);
    expect(decode(envelope.payload.linkage.attemptIdUtf8 ?? [])).toBe(attemptId);
    expect(decode(envelope.payload.linkage.commandIdUtf8 ?? [])).toBe(commandId);
    expect(decode(envelope.payload.linkage.inputHashUtf8 ?? [])).toBe(inputHash);
    expect(stored?.envelope_json).not.toContain("REDACTED_AUTH_DIGITS");
  });

  it("snapshots exported audit input and check fields exactly once before hashing awaits", async () => {
    const checkIds = [CHECK_0, CHECK_1, CHECK_2, CHECK_3] as const;
    let checkIdReads = 0;
    let checkReads = 0;
    const check = {
      decision: "allow" as const,
      reason: "allowed" as const,
      checkedAt: instant.toISOString(),
    };
    const mutableInput = {
      get checkId(): Ulid {
        const value = checkIds[Math.min(checkIdReads, checkIds.length - 1)] ?? CHECK_3;
        checkIdReads += 1;
        return value;
      },
      attemptId: ATTEMPT_0,
      principalId: "principal:owner",
      commandId: request().commandId,
      inputHash: "a".repeat(64) as Sha256Hex,
      get check() {
        checkReads += 1;
        return check;
      },
    };

    await new PolicyAudit(new EventRepository(env.DB)).appendDispatchCheck(mutableInput);

    const stored = await env.DB.prepare(`SELECT e.event_id, e.envelope_json, i.key AS idempotency_key
      FROM events e JOIN idempotency_records i ON i.event_sequence = e.sequence
      WHERE e.event_type = 'policy.dispatch_checked'`).first<{
      event_id: string;
      envelope_json: string;
      idempotency_key: string;
    }>();
    const envelope = JSON.parse(stored?.envelope_json ?? "null") as {
      eventId: string;
      correlationId: string;
      causationId: string;
      payload: { linkage: Record<string, number[]> };
    };
    const decode = (bytes: number[]) => new TextDecoder().decode(Uint8Array.from(bytes));

    expect(checkIdReads).toBe(1);
    expect(checkReads).toBe(1);
    expect(stored).toMatchObject({ event_id: CHECK_0, idempotency_key: CHECK_0 });
    expect(envelope).toMatchObject({ eventId: CHECK_0, correlationId: ATTEMPT_0, causationId: request().commandId });
    expect(decode(envelope.payload.linkage.checkIdUtf8 ?? [])).toBe(CHECK_0);
  });
});
