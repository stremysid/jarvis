import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type OutboundCallCommand, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { PolicyEngine, type MutablePolicyContext } from "../../src/policy/policy-engine.js";
import { applyFoundationMigration } from "../persistence/migration.js";

const instant = new Date("2026-08-30T12:00:00.000Z");
const expires = "2026-08-30T12:05:00.000Z";

class TestContext implements MutablePolicyContext {
  public killSwitch = false;
  public quiet = false;
  public concurrentCalls = 0;
  public dailyCalls = 0;
  public retries = 0;
  public nowValue = instant;
  public quietHours = () => this.quiet;
  public attemptId = "01k3s6k8000000000000000009";
  public attemptLookupFails = false;
  public originGate: Promise<void> | undefined;
  public readonly origins = new Map<string, { principalId: string; issuedBy: "telegram_call_command" | "local_cli"; commandHash: Sha256Hex }>();

  now(): Date { return this.nowValue; }
  isQuietHours(now: Date): boolean { return this.quietHours(now); }
  activeOutboundCalls(): number { return this.concurrentCalls; }
  outboundCallsForUtcPolicyDay(): number { return this.dailyCalls; }
  retryCount(): number { return this.retries; }
  async authenticatedOrigin(commandId: string): Promise<{ principalId: string; issuedBy: "telegram_call_command" | "local_cli"; commandHash: Sha256Hex } | null> { await this.originGate; return this.origins.get(commandId) ?? null; }
  dispatchAttemptId(commandId: string): string { if (this.attemptLookupFails) throw new Error("attempt lookup failed"); return commandId === request().commandId ? this.attemptId : commandId; }
  async trust(input: OutboundCallCommand, origin = { principalId: input.principalId, issuedBy: "telegram_call_command" as const }): Promise<void> {
    this.origins.set(input.commandId, { ...origin, commandHash: await sha256Hex(canonicalJson(input)) });
  }
}

async function insertPrincipalAndIdentity(principalId = "principal:owner", identityId = "identity:voice", identityPrincipalId = principalId, status = "active", verifiedAt: string | null = instant.toISOString()): Promise<void> {
  await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES (?, 'human', 'active', 'test', '1.0', 'PIN_VERIFIER_JSON', ?, ?)")
    .bind(principalId, instant.toISOString(), instant.toISOString()).run();
  await env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES (?, ?, 'voice', 'opaque-destination', ?, ?, ?)")
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

  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM channel_identities"), env.DB.prepare("DELETE FROM policy_decisions"), env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare("DELETE FROM outbox"), env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
    ]);
    await insertPrincipalAndIdentity();
    context = new TestContext();
    policy = new PolicyEngine({ database: env.DB, events: new EventRepository(env.DB), context });
  });

  async function evaluate(input: OutboundCallCommand): Promise<unknown> {
    try { await context.trust(input); } catch { /* malformed input has no trusted canonical record */ }
    return policy.evaluateOutboundCall(input);
  }

  async function recheck(input: OutboundCallCommand): Promise<unknown> {
    await context.trust(input);
    return policy.recheckOutboundDispatch(input);
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
    ["retry cap", (value: TestContext) => { value.retries = 2; }, "retry_limit"],
  ] as const)("denies %s", async (_label, configure, reason) => {
    configure(context);
    await expect(evaluate(request())).resolves.toMatchObject({ decision: "deny", reason });
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
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "kill_switch_enabled", checkedAt: instant.toISOString() });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ count: number }>())?.count).toBe(1);
    const stored = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ envelope_json: string }>();
    expect(stored?.envelope_json).not.toContain("opaque-destination");
  });

  it("denies dispatch without a matching allowed authorization", async () => {
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "authorization_missing" });
    await evaluate(request({ commandId: "01k3s6k8000000000000000005" as never, issuedBy: "model" as never }));
    await expect(recheck(request({ commandId: "01k3s6k8000000000000000005" as never, issuedBy: "model" as never }))).resolves.toMatchObject({ decision: "deny", reason: "authorization_denied" });
    await evaluate(request({ commandId: "01k3s6k8000000000000000006" as never }));
    await expect(recheck(request({ commandId: "01k3s6k8000000000000000006" as never, urgency: "urgent" }))).resolves.toMatchObject({ decision: "deny", reason: "policy_command_conflict" });
  });

  it("fails closed when dispatch audit persistence fails", async () => {
    const failing = new PolicyEngine({ database: env.DB, context, events: { append: async () => { throw new Error("D1 unavailable"); }, readRange: async () => [] } });
    await context.trust(request());
    await failing.evaluateOutboundCall(request());
    await expect(failing.recheckOutboundDispatch(request())).resolves.toMatchObject({ decision: "deny", reason: "audit_persistence_failed" });
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
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "destination_not_verified" });
  });

  it("rechecks destination unverification and deletion after authorization", async () => {
    await evaluate(request());
    await env.DB.prepare("UPDATE channel_identities SET verified_at = NULL, status = 'pending' WHERE identity_id = 'identity:voice'").run();
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "destination_not_verified" });
    await env.DB.prepare("DELETE FROM channel_identities WHERE identity_id = 'identity:voice'").run();
    context.attemptId = "01k3s6k800000000000000000d";
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "destination_not_verified" });
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
    await expect(policy.recheckOutboundDispatch(request())).resolves.toMatchObject({ decision: "deny", reason: "invalid_origin" });
  });

  it("revalidates the trusted canonical command hash at dispatch time", async () => {
    await evaluate(request());
    const origin = context.origins.get(request().commandId);
    if (origin === undefined) throw new Error("missing test origin");
    origin.commandHash = "0".repeat(64) as Sha256Hex;
    await expect(policy.recheckOutboundDispatch(request())).resolves.toMatchObject({ decision: "deny", reason: "invalid_origin" });
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

  it("uses the stable attempt identity to replay an uncertain audit append once", async () => {
    await evaluate(request());
    await expect(recheck(request())).resolves.toMatchObject({ decision: "allow", reason: "allowed" });
    context.nowValue = new Date("2026-08-30T12:00:01.000Z");
    await expect(recheck(request())).resolves.toMatchObject({ decision: "allow", reason: "allowed" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ count: number }>())?.count).toBe(1);
  });

  it("uses a new stable attempt identity for a second dispatch check", async () => {
    await evaluate(request());
    await recheck(request());
    context.attemptId = "01k3s6k800000000000000000c";
    await recheck(request());
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ count: number }>())?.count).toBe(2);
  });

  it("fails closed if a reused attempt would change its audited result", async () => {
    await evaluate(request());
    await recheck(request());
    context.killSwitch = true;
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "audit_persistence_failed" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ count: number }>())?.count).toBe(1);
  });

  it("fails closed for a malformed stable dispatch-attempt identity", async () => {
    await evaluate(request());
    context.attemptId = "not-a-ulid";
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "invalid_dispatch_attempt" });
  });

  it("fails closed when stable dispatch-attempt lookup fails", async () => {
    await evaluate(request());
    context.attemptLookupFails = true;
    await expect(recheck(request())).resolves.toMatchObject({ decision: "deny", reason: "invalid_dispatch_attempt" });
  });
});
