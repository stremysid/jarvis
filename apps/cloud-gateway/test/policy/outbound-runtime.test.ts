import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnvelope, newUlid, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { D1OutboundControlSource, D1OutboundPolicyContext, outboundControlDecision, snapshotOutboundControls } from "../../src/policy/outbound-controls.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { ProviderFailure } from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyVoiceRuntimeMigration, clearOutboundCallAttemptsForTest, clearVoiceAccessDataForTest } from "../persistence/migration.js";
import { seedFakeGuest } from "../../../../tests/acceptance/fake/voice-access-system.js";

const CALL_SID = `CA${"9".repeat(32)}`;
let now: Date;
let calls: CallRepository;
const controls = new D1OutboundControlSource(env.DB);

async function cleanup() {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearOutboundCallAttemptsForTest();
  await clearVoiceAccessDataForTest();
  await env.DB.batch(["outbox", "idempotency_records", "events", "policy_decisions", "channel_identities", "principals"]
    .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

async function attempt(options: { at?: Date; expires?: string; nonceTtl?: number; destination?: string } = {}) {
  const at = options.at ?? now;
  const commandId = newUlid(); const attemptId = newUlid();
  await env.DB.prepare(`INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at)
    VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)`)
    .bind(commandId, "a".repeat(64), at.toISOString()).run();
  const repository = options.nonceTtl === undefined ? calls
    : new CallRepository(env.DB, new EventRepository(env.DB), undefined, options.nonceTtl);
  const stored = await repository.getOrCreateExpectedCall({ commandId, attemptId, attemptOrdinal: 0,
    principalId: "principal:owner", destinationIdentityId: options.destination ?? "identity:voice", idempotencyKey: `call:${commandId}`,
    authorizationExpiresAt: options.expires ?? new Date(at.valueOf() + 300_000).toISOString(), now: at });
  return { ...stored, repository, claim: () => repository.claimProviderDispatch({ attemptId, now: at }) };
}

async function callback(attemptId: Ulid, status: string, envelopeFirst = false) {
  const audit = new Redactor().redactText("synthetic callback");
  const callStatus = new Redactor().redactText(status);
  if (!audit.ok || !callStatus.ok) throw new Error("fixture redaction failed");
  const envelope = await createEnvelope({ schemaVersion: "1.0", eventId: newUlid(), eventType: "provider.call_status",
    source: "twilio", subjectId: "principal:owner", occurredAt: now.toISOString(), receivedAt: now.toISOString(),
    correlationId: attemptId, contentType: "application/json", payload: { audit, callStatus }, producerVersion: "test" });
  const requestHash = await sha256Hex(status);
  if (envelopeFirst) {
    await new EventRepository(env.DB).append({ scope: "test:callback", key: envelope.eventId, requestHash, envelope });
    await env.DB.prepare(`INSERT INTO provider_events (dedupe_key, endpoint_kind, event_id, attempt_id, call_sid,
      callback_source, sequence_number, session_id, received_at) VALUES (?, 'status', ?, ?, ?, 'call-progress-events', 1, NULL, ?)`)
      .bind(requestHash, envelope.eventId, attemptId, CALL_SID, now.toISOString()).run();
  } else {
    await calls.appendProviderEvent({ endpointKind: "status", attemptId, callSid: CALL_SID, callbackSource: "call-progress-events",
      sequenceNumber: status === "completed" ? 1 : 0, requestHash, envelope });
  }
  return envelope.eventId;
}

describe("production outbound admission in D1", () => {
  beforeEach(async () => {
    await applyVoiceRuntimeMigration(); await cleanup();
    // JS fake timers do not control SQLite's clock. Admission uses the database
    // clock, so fixtures are relative to that clock instead of a frozen old date.
    const stamp = await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS stamp").first<string>("stamp");
    now = new Date(stamp!); calls = new CallRepository(env.DB, new EventRepository(env.DB));
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO outbound_runtime_controls (singleton_id, enabled) VALUES (1, 0)"),
      env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
        VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)`).bind(stamp, stamp),
      env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
        VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?)`).bind(stamp, stamp),
      env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:voice', ?)").bind(stamp),
    ]);
  });
  afterEach(cleanup);

  it("starts disabled and refuses missing control state without claiming a call", async () => {
    await expect(controls.readControls()).resolves.toEqual({ enabled: false, quietStartsAt: null, quietEndsAt: null });
    const ready = await attempt();
    await expect(ready.claim()).resolves.toEqual({ kind: "policy_denied", reason: "kill_switch_enabled" });
    await env.DB.prepare("DELETE FROM outbound_runtime_controls").run();
    await expect(controls.readControls()).rejects.toThrow("outbound_controls_unavailable");
    await expect(ready.claim()).resolves.toEqual({ kind: "policy_denied", reason: "kill_switch_enabled" });
    await expect(env.DB.prepare("SELECT provider_dispatch_state FROM outbound_call_attempts").first())
      .resolves.toEqual({ provider_dispatch_state: "ready" });
  });

  it.each([
    ["partial start", "quiet_starts_at = ?", "2026-09-13T12:00:00.000Z"],
    ["partial end", "quiet_ends_at = ?", "2026-09-13T13:00:00.000Z"],
    ["non-boolean enabled", "enabled = ?", 2],
    ["wrong singleton", "singleton_id = ?", 2],
    ["noncanonical start", "quiet_starts_at = ?, quiet_ends_at = '2026-09-14T13:00:00.000Z'", "2026-09-13T12:00:00Z"],
    ["reversed bounds", "quiet_starts_at = ?, quiet_ends_at = '2026-09-13T13:00:00.000Z'", "2026-09-14T12:00:00.000Z"],
  ] as const)("rejects invalid stored controls: %s", async (_label, assignment, value) => {
    await expect(env.DB.prepare(`UPDATE outbound_runtime_controls SET ${assignment}`).bind(value).run()).rejects.toThrow();
  });

  it("uses current stored quiet bounds when a previously allowed call claims", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    await expect(controls.readControls()).resolves.toMatchObject({ enabled: true });
    const ready = await attempt();
    await env.DB.prepare("UPDATE outbound_runtime_controls SET quiet_starts_at = ?, quiet_ends_at = ?")
      .bind(new Date(now.valueOf() - 1_000).toISOString(), new Date(now.valueOf() + 60_000).toISOString()).run();
    await expect(ready.claim()).resolves.toEqual({ kind: "policy_denied", reason: "quiet_hours" });
    await env.DB.prepare("UPDATE outbound_runtime_controls SET quiet_starts_at = ?, quiet_ends_at = ?")
      .bind(new Date(now.valueOf() - 2_000).toISOString(), new Date(now.valueOf() - 1_000).toISOString()).run();
    await expect(ready.claim()).resolves.toMatchObject({ kind: "claimed" });
  });

  it.each([
    ["owner disabled", "UPDATE principals SET status = 'disabled' WHERE principal_id = 'principal:owner'"],
    ["phone disabled", "UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:voice'"],
    ["phone no longer verified", "UPDATE channel_identities SET status = 'pending', verified_at = NULL WHERE identity_id = 'identity:voice'"],
  ] as const)("rechecks access at the atomic claim after the earlier policy read: %s", async (_label, change) => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const ready = await attempt(); await env.DB.prepare(change).run();
    await expect(ready.claim()).resolves.toEqual({ kind: "policy_denied", reason: "destination_not_verified" });
  });

  it("permits a live guest grant but refuses a second claim after it is revoked", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const guest = await seedFakeGuest("a");
    const first = await attempt({ destination: guest.identityId });
    await expect(first.claim()).resolves.toMatchObject({ kind: "claimed" });
    const second = await attempt({ destination: guest.identityId });
    await env.DB.prepare("UPDATE voice_access_grants SET grant_version = 2, status = 'revoked', revoked_at = ?, updated_at = ? WHERE grant_id = ?")
      .bind(now.toISOString(), now.toISOString(), guest.grantId).run();
    await expect(second.claim()).resolves.toEqual({ kind: "policy_denied", reason: "destination_not_verified" });
  }, 15_000);

  it("permits a claim before the stored quiet interval starts", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1, quiet_starts_at = ?, quiet_ends_at = ?")
      .bind(new Date(now.valueOf() + 60_000).toISOString(), new Date(now.valueOf() + 120_000).toISOString()).run();
    await expect((await attempt()).claim()).resolves.toMatchObject({ kind: "claimed" });
  });

  it.each(["claimed", "terminal"] as const)("refuses a direct initial %s row without taking the guarded transition", async (fault) => {
    const first = await attempt(); const commandId = newUlid();
    await env.DB.prepare(`INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at)
      VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)`).bind(commandId, "b".repeat(64), now.toISOString()).run();
    await expect(env.DB.prepare(`INSERT INTO outbound_call_attempts (attempt_id, command_id, attempt_ordinal, principal_id,
      destination_identity_id, command_idempotency_key, relay_nonce, nonce_expires_at, authorization_expires_at,
      provider_dispatch_state, provider_dispatch_claimed_at, provider_terminal_at, retry_eligible, created_at)
      SELECT ?, ?, 0, principal_id, destination_identity_id, ?, ?, nonce_expires_at, authorization_expires_at,
        ?, ?, ?, 0, created_at FROM outbound_call_attempts WHERE attempt_id = ?`)
      .bind(newUlid(), commandId, `new:${commandId}`, `${"X".repeat(42)}A`, fault === "claimed" ? "claimed" : "ready",
        fault === "claimed" ? now.toISOString() : null, fault === "terminal" ? now.toISOString() : null, first.attemptId).run())
      .rejects.toThrow("outbound_attempt_initial_state_invalid");
  });

  it.each(["authorization", "nonce"] as const)("checks %s expiry against execution time instead of the earlier request sample", async (fault) => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const ready = await attempt({ at: new Date(now.valueOf() - 2_000),
      ...(fault === "authorization" ? { expires: new Date(now.valueOf() - 1_000).toISOString() } : { nonceTtl: 1_000 }) });
    await expect(ready.claim()).resolves.toEqual({ kind: "policy_denied", reason: fault === "authorization" ? "authorization_expired" : "invalid_dispatch_attempt" });
  });

  it("refuses a forged claim day while keeping both expiry windows live", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const ready = await attempt();
    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET provider_dispatch_state = 'claimed', provider_dispatch_claimed_at = ? WHERE attempt_id = ?")
      .bind(new Date(now.valueOf() - 86_400_000).toISOString(), ready.attemptId).run()).rejects.toThrow("outbound_admission_clock_invalid");
    await expect(calls.claimProviderDispatch({ attemptId: ready.attemptId, now: new Date(now.valueOf() - 86_400_000) }))
      .resolves.toEqual({ kind: "policy_denied", reason: "invalid_dispatch_attempt" });
  });

  it("refuses a noncanonical claim timestamp even when its UTC day matches", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const ready = await attempt();
    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET provider_dispatch_state = 'claimed', provider_dispatch_claimed_at = ? WHERE attempt_id = ?")
      .bind(now.toISOString().replace(/\.\d{3}Z$/u, "Z"), ready.attemptId).run()).rejects.toThrow("outbound_admission_clock_invalid");
  });

  it.each(["no such table: outbound_admission_disabled", "outbound_admission_disabled",
    "D1_ERROR: outbound_admission_disabled: SQLITE_BUSY"])("keeps raw storage errors out of the policy verdict mapping: %s", async (message) => {
    const failure = new Error(message);
    const database = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return () => { throw failure; };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const repository = new CallRepository(database, new EventRepository(env.DB));
    await expect(repository.claimProviderDispatch({ attemptId: newUlid(), now })).rejects.toBe(failure);
  });

  it("admits only two of three racing claims even when each request observed spare capacity", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const ready = await Promise.all([attempt(), attempt(), attempt()]);
    const context = new D1OutboundPolicyContext(env.DB, async () => null);
    await expect(context.activeOutboundCalls("principal:owner")).resolves.toBe(0);
    await expect(context.outboundCallsForUtcPolicyDay("principal:owner", now.toISOString().slice(0, 10))).resolves.toBe(0);
    const results = await Promise.all(ready.map((item) => item.claim()));
    expect(results.filter((item) => item.kind === "claimed")).toHaveLength(2);
    expect(results.filter((item) => item.kind !== "claimed")).toEqual([{ kind: "policy_denied", reason: "concurrency_limit" }]);
    await expect(env.DB.prepare("SELECT count(*) AS count FROM outbound_call_attempts WHERE provider_dispatch_state = 'claimed'").first())
      .resolves.toEqual({ count: 2 });
    await expect(context.activeOutboundCalls("principal:owner")).resolves.toBe(2);
    await expect(context.activeOutboundCalls("principal:someone-else")).resolves.toBe(0);
  });

  it("counts all six claimed attempts for the day even when the provider rejected each", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    for (let index = 0; index < 6; index += 1) {
      const ready = await attempt(); const claim = await ready.claim();
      if (claim.kind !== "claimed") throw new Error("fixture claim missing");
      calls.beginProviderDispatch(claim.capability, ready.attemptId, now, "+14165550123");
      await calls.recordProviderDispatchRejection({ claim: claim.capability,
        failure: ProviderFailure.permanent("invalid_request"), now });
    }
    const seventh = await attempt();
    await expect(seventh.claim()).resolves.toEqual({ kind: "policy_denied", reason: "daily_limit" });
    const context = new D1OutboundPolicyContext(env.DB, async () => null);
    await expect(context.activeOutboundCalls("principal:owner")).resolves.toBe(0);
    await expect(context.outboundCallsForUtcPolicyDay("principal:owner", now.toISOString().slice(0, 10))).resolves.toBe(6);
    await expect(context.outboundCallsForUtcPolicyDay("principal:someone-else", now.toISOString().slice(0, 10))).resolves.toBe(0);
    await expect(context.outboundCallsForUtcPolicyDay("principal:owner", "2000-01-01")).resolves.toBe(0);
  });

  it("keeps indeterminate claims recoverable while the owner disables new dispatch", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const ready = await attempt(); await ready.claim();
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 0").run();
    await expect(ready.claim()).resolves.toEqual({ kind: "provider_dispatch_unknown" });
    await callback(ready.attemptId, "completed");
    await expect(env.DB.prepare("SELECT provider_terminal_at FROM outbound_call_attempts WHERE attempt_id = ?").bind(ready.attemptId).first())
      .resolves.toEqual({ provider_terminal_at: now.toISOString() });
  });

  it("retains affirmative terminal evidence when callback envelopes are archived", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const first = await attempt(); await first.claim(); await callback(first.attemptId, "completed");
    // The event table's production retention path removes envelopes, not receipts.
    // Clearing only the envelope reproduces that persisted receipt boundary.
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM idempotency_records").run();
    await env.DB.prepare("DELETE FROM events").run();
    const second = await attempt(); const third = await attempt();
    await expect(second.claim()).resolves.toMatchObject({ kind: "claimed" });
    await expect(third.claim()).resolves.toMatchObject({ kind: "claimed" });
    await expect(new D1OutboundPolicyContext(env.DB, async () => null).activeOutboundCalls("principal:owner")).resolves.toBe(2);
    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET provider_terminal_at = NULL WHERE attempt_id = ?").bind(first.attemptId).run())
      .rejects.toThrow("outbound_terminal_evidence_required");
  });

  it("retains terminal evidence when the envelope arrives before its receipt", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const first = await attempt(); await first.claim(); await callback(first.attemptId, "completed", true);
    await expect(env.DB.prepare("SELECT provider_terminal_at FROM outbound_call_attempts WHERE attempt_id = ?").bind(first.attemptId).first())
      .resolves.toEqual({ provider_terminal_at: now.toISOString() });
  });

  it("does not release capacity for a missing envelope or a fabricated terminal marker", async () => {
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const first = await attempt(); await first.claim(); await callback(first.attemptId, "ringing");
    await env.DB.prepare("DELETE FROM outbox").run(); await env.DB.prepare("DELETE FROM idempotency_records").run();
    await env.DB.prepare("DELETE FROM events").run();
    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET provider_terminal_at = ? WHERE attempt_id = ?")
      .bind(now.toISOString(), first.attemptId).run()).rejects.toThrow("outbound_terminal_evidence_required");
    const second = await attempt(); await second.claim(); const third = await attempt();
    await expect(third.claim()).resolves.toEqual({ kind: "policy_denied", reason: "concurrency_limit" });
  });
});

describe("outbound control snapshots", () => {
  it.each([
    ["2026-01-01T11:59:59.999Z", "allow"], ["2026-01-01T12:00:00.000Z", "deny"],
    ["2026-01-01T12:59:59.999Z", "deny"], ["2026-01-01T13:00:00.000Z", "allow"],
  ] as const)("evaluates the exact quiet boundary at %s", (at, decision) => {
    expect(outboundControlDecision({ enabled: true,
      quietStartsAt: "2026-01-01T12:00:00.000Z", quietEndsAt: "2026-01-01T13:00:00.000Z" }, at).decision).toBe(decision);
  });
  it.each([null, {}, { enabled: "true", quietStartsAt: null, quietEndsAt: null },
    { enabled: true, quietStartsAt: "2026-01-01", quietEndsAt: null },
    { enabled: true, quietStartsAt: "2026-01-02T00:00:00.000Z", quietEndsAt: "2026-01-01T00:00:00.000Z" },
    { enabled: true, quietStartsAt: null, quietEndsAt: null, extra: true },
    { get enabled() { throw new Error("accessor must not execute"); }, quietStartsAt: null, quietEndsAt: null },
  ])("refuses malformed or accessor-shaped controls", (value) => {
    expect(() => snapshotOutboundControls(value)).toThrow("outbound_controls_unavailable");
  });
});
