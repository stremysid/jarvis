import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newUlid, type OutboundCallCommand } from "../../../../packages/contracts/src/index.js";
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
  private auditSequence = 0;

  now(): Date { return this.nowValue; }
  isQuietHours(now: Date): boolean { return this.quietHours(now); }
  activeOutboundCalls(): number { return this.concurrentCalls; }
  outboundCallsForUtcPolicyDay(): number { return this.dailyCalls; }
  retryCount(): number { return this.retries; }
  nextAuditId(): string { this.auditSequence += 1; return newUlid(new Date(instant.valueOf() + this.auditSequence)); }
}

async function insertPrincipalAndIdentity(principalId = "principal:owner", identityId = "identity:voice", identityPrincipalId = principalId, status = "active", verifiedAt: string | null = instant.toISOString()): Promise<void> {
  await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'human', 'active', 'test', ?, ?)")
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

  afterEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM channel_identities"), env.DB.prepare("DELETE FROM policy_decisions"), env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare("DELETE FROM outbox"), env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
    ]);
  });

  it("denies model and unknown origins and persists immutable decisions", async () => {
    await expect(policy.evaluateOutboundCall(request({ issuedBy: "model" as never }))).resolves.toMatchObject({ decision: "deny", reason: "invalid_origin" });
    await expect(policy.evaluateOutboundCall(request({ commandId: "01k3s6k8000000000000000007" as never, issuedBy: "unknown" as never }))).resolves.toMatchObject({ decision: "deny", reason: "invalid_origin" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM policy_decisions").first<{ count: number }>())?.count).toBe(2);
  });

  it("fails closed for invalid purposes and destination ownership or verification failures", async () => {
    await expect(policy.evaluateOutboundCall(request({ purposeCode: "model" as never }))).resolves.toMatchObject({ reason: "invalid_purpose" });
    await expect(policy.evaluateOutboundCall(request({ commandId: "01k3s6k8000000000000000008" as never, purposeCode: undefined as never }))).resolves.toMatchObject({ reason: "invalid_purpose" });
    await env.DB.prepare("UPDATE channel_identities SET verified_at = NULL WHERE identity_id = 'identity:voice'").run();
    await expect(policy.evaluateOutboundCall(request({ commandId: "01k3s6k8000000000000000001" as never }))).resolves.toMatchObject({ reason: "destination_not_verified" });
    await env.DB.prepare("UPDATE channel_identities SET verified_at = ?, status = 'disabled' WHERE identity_id = 'identity:voice'").bind(instant.toISOString()).run();
    await expect(policy.evaluateOutboundCall(request({ commandId: "01k3s6k8000000000000000002" as never }))).resolves.toMatchObject({ reason: "destination_not_verified" });
    await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:foreign', 'human', 'active', 'foreign', ?, ?)").bind(instant.toISOString(), instant.toISOString()).run();
    await env.DB.prepare("UPDATE channel_identities SET principal_id = 'principal:foreign', status = 'active' WHERE identity_id = 'identity:voice'").run();
    await expect(policy.evaluateOutboundCall(request({ commandId: "01k3s6k8000000000000000003" as never }))).resolves.toMatchObject({ reason: "destination_not_verified" });
  });

  it("treats expiry equality and malformed expiry as expired", async () => {
    await expect(policy.evaluateOutboundCall(request({ authorizationExpiresAt: instant.toISOString() }))).resolves.toMatchObject({ reason: "authorization_expired" });
    await expect(policy.evaluateOutboundCall(request({ commandId: "01k3s6k8000000000000000004" as never, authorizationExpiresAt: "not-a-time" }))).resolves.toMatchObject({ reason: "authorization_expired" });
  });

  it.each([
    ["kill switch", (value: TestContext) => { value.killSwitch = true; }, "kill_switch_enabled"],
    ["quiet hours", (value: TestContext) => { value.quiet = true; }, "quiet_hours"],
    ["concurrency", (value: TestContext) => { value.concurrentCalls = 2; }, "concurrency_limit"],
    ["daily cap", (value: TestContext) => { value.dailyCalls = 6; }, "daily_limit"],
    ["retry cap", (value: TestContext) => { value.retries = 2; }, "retry_limit"],
  ] as const)("denies %s", async (_label, configure, reason) => {
    configure(context);
    await expect(policy.evaluateOutboundCall(request())).resolves.toMatchObject({ decision: "deny", reason });
  });

  it("uses the supplied clock at the quiet-hours boundary", async () => {
    context.nowValue = new Date("2026-08-30T22:00:00.000Z");
    context.quietHours = (now) => now.toISOString() >= "2026-08-30T22:00:00.000Z";
    await expect(policy.evaluateOutboundCall(request({ authorizationExpiresAt: "2026-08-30T22:05:00.000Z" }))).resolves.toMatchObject({ reason: "quiet_hours" });
  });

  it("allows an eligible command and replays its first immutable decision", async () => {
    const first = await policy.evaluateOutboundCall(request());
    context.killSwitch = true;
    const replay = await policy.evaluateOutboundCall(request());
    expect(first).toEqual({ decision: "allow", reason: "allowed" });
    expect(replay).toEqual(first);
    expect(await env.DB.prepare("SELECT outcome, reason_code FROM policy_decisions WHERE decision_id = ?").bind(request().commandId).first()).toEqual({ outcome: "allow", reason_code: "allowed" });
  });

  it("fails closed when a command id is reused with a changed canonical command", async () => {
    await policy.evaluateOutboundCall(request());
    await expect(policy.evaluateOutboundCall(request({ urgency: "urgent" }))).resolves.toEqual({ decision: "deny", reason: "policy_command_conflict" });
  });

  it("concurrently evaluates duplicate commands without overwriting the first decision", async () => {
    const results = await Promise.all(Array.from({ length: 2 }, () => policy.evaluateOutboundCall(request())));
    expect(results).toEqual([{ decision: "allow", reason: "allowed" }, { decision: "allow", reason: "allowed" }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM policy_decisions WHERE decision_id = ?").bind(request().commandId).first<{ count: number }>())?.count).toBe(1);
  });

  it("rechecks mutable guards at dispatch time and appends a redaction-safe audit event", async () => {
    await policy.evaluateOutboundCall(request());
    context.killSwitch = true;
    await expect(policy.recheckOutboundDispatch(request())).resolves.toMatchObject({ decision: "deny", reason: "kill_switch_enabled", checkedAt: instant.toISOString() });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ count: number }>())?.count).toBe(1);
    const stored = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_type = 'policy.dispatch_checked'").first<{ envelope_json: string }>();
    expect(stored?.envelope_json).not.toContain("opaque-destination");
  });

  it("denies dispatch without a matching allowed authorization", async () => {
    await expect(policy.recheckOutboundDispatch(request())).resolves.toMatchObject({ decision: "deny", reason: "authorization_missing" });
    await policy.evaluateOutboundCall(request({ commandId: "01k3s6k8000000000000000005" as never, issuedBy: "model" as never }));
    await expect(policy.recheckOutboundDispatch(request({ commandId: "01k3s6k8000000000000000005" as never, issuedBy: "model" as never }))).resolves.toMatchObject({ decision: "deny", reason: "authorization_denied" });
    await policy.evaluateOutboundCall(request({ commandId: "01k3s6k8000000000000000006" as never }));
    await expect(policy.recheckOutboundDispatch(request({ commandId: "01k3s6k8000000000000000006" as never, urgency: "urgent" }))).resolves.toMatchObject({ decision: "deny", reason: "policy_command_conflict" });
  });

  it("fails closed when dispatch audit persistence fails", async () => {
    const failing = new PolicyEngine({ database: env.DB, context, events: { append: async () => { throw new Error("D1 unavailable"); }, readRange: async () => [] } });
    await failing.evaluateOutboundCall(request());
    await expect(failing.recheckOutboundDispatch(request())).resolves.toMatchObject({ decision: "deny", reason: "audit_persistence_failed" });
  });
});
