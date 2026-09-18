import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyOwnerSensitiveActionPinMigration } from "./migration.js";

const NOW = "2026-09-17T18:00:00.000Z";
const SOON = "2026-09-17T18:00:30.000Z";
const PAST_DEADLINE = "2026-09-17T18:02:30.000Z";
/** The end of the two-minute window a question is open for. */
const LATE = "2026-09-17T18:02:00.000Z";
const OWNER = "principal:pin-owner";
const IDENTITY = "identity:pin-owner:voice";
const FINGERPRINT = "1".repeat(64);

/** ULID shaped, because every id column in this migration enforces that shape. */
function ulid(suffix: string): string {
  return `01m3${"a".repeat(19)}${suffix}`;
}

let receipts = 0;

function nextReceiptId(): string {
  receipts += 1;
  return ulid(`d${String(receipts).padStart(2, "0")}`);
}

async function seedPeople(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'Sid', ?, ?)`).bind(OWNER, NOW, NOW),
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES ('service:pin-foreign', 'service', 'active', 'Foreign', ?, ?)`).bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO device_keys (
        device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
        algorithm, status, device_label, bootstrap_metadata_hash, created_at
      ) VALUES ('device:pin-home', ?, 'key:pin-home', ?, ?, 1, 'ed25519', 'active', 'home', ?, ?)`)
      .bind(OWNER, `${"A".repeat(43)}=`, FINGERPRINT, "2".repeat(64), NOW),
    env.DB.prepare(`INSERT INTO device_keys (
        device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
        algorithm, status, device_label, bootstrap_metadata_hash, created_at
      ) VALUES ('device:pin-foreign', 'service:pin-foreign', 'key:pin-foreign', ?, ?, 1, 'ed25519', 'active', 'foreign', ?, ?)`)
      .bind(`${"B".repeat(43)}=`, "3".repeat(64), "4".repeat(64), NOW),
    env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id
      ) VALUES (?, ?, 'voice', '+14165550123', 'active', ?, ?, 'device:pin-home')`).bind(IDENTITY, OWNER, NOW, NOW),
    env.DB.prepare(`INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at)
      VALUES (1, ?, ?, ?)`).bind(OWNER, IDENTITY, NOW),
  ]);
}

/**
 * A call session walked to the phase an owner authority insert is allowed to
 * land in, using the same created, connecting, pre_auth steps the runtime
 * uses. A session inserted straight into pre_auth is refused by the initial
 * state trigger, which is the point of that trigger.
 */
async function seedOwnerSession(sessionId: string, marker: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
    direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
    nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?, 'owner', NULL, NULL, NULL)`)
    .bind(
      sessionId, `CA${marker.repeat(32)}`, OWNER, IDENTITY, IDENTITY,
      `${marker.repeat(42)}A`, "2026-09-17T18:05:00.000Z", "2026-09-17T18:05:00.000Z", NOW, NOW,
    ).run();
  await env.DB.prepare(`UPDATE call_sessions
    SET provider_session_id = ?, provider_connected_at = ?, updated_at = ? WHERE session_id = ?`)
    .bind(`VX${marker.repeat(32)}`, SOON, SOON, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(SOON, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(SOON, sessionId).run();
}

function stagePin(version: number, overrides: Partial<{ deviceId: string; keyId: string; fingerprint: string; status: string }> = {}): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO owner_call_pin_verifiers (
    owner_principal_id, owner_identity_id, pin_version, algorithm, domain_version, pepper_version,
    iterations, salt, digest, status, created_by_device_id, created_by_key_id,
    created_by_key_fingerprint, created_by_key_generation, created_at, status_changed_at
  ) VALUES (?, ?, ?, 'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 'v1', 600000, ?, ?, ?,
    ?, ?, ?, 1, ?, ?)`).bind(
    OWNER, IDENTITY, version,
    new Uint8Array(16).fill(version).buffer, new Uint8Array(32).fill(version).buffer,
    overrides.status ?? "staged",
    overrides.deviceId ?? "device:pin-home", overrides.keyId ?? "key:pin-home",
    overrides.fingerprint ?? FINGERPRINT, NOW, NOW,
  );
}

function rotationCommit(id: string, expected: number | null, next: number, at = NOW): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO owner_call_pin_rotation_commits (
    commit_id, owner_principal_id, owner_identity_id, expected_pin_version, new_pin_version, committed_at
  ) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, OWNER, IDENTITY, expected, next, at);
}

function head(version: number, at = NOW): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO owner_call_pin_heads (
    singleton_id, owner_principal_id, owner_identity_id, pin_version, updated_at
  ) VALUES (1, ?, ?, ?, ?)`).bind(OWNER, IDENTITY, version, at);
}

/**
 * Version one published through the same guards production rotates through.
 * The head is a singleton, so this is idempotent: the file has one owner and
 * every test that needs a live PIN shares it.
 */
async function seedActivePin(): Promise<void> {
  const existing = await env.DB.prepare("SELECT pin_version FROM owner_call_pin_heads WHERE singleton_id = 1")
    .first<{ pin_version: number }>();
  if (existing !== null) return;
  await env.DB.batch([stagePin(1), rotationCommit(ulid("c01"), null, 1), head(1)]);
}

async function seedEvaluation(evaluationId: string, capability: string, tier: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO autonomy_evaluations (
    evaluation_id, capability, tier, mode, outcome, principal_id, summary, decision_id, evaluated_at
  ) VALUES (?, ?, ?, 'live', 'requires_confirmation', ?, 'book the thing', NULL, ?)`)
    .bind(evaluationId, capability, tier, OWNER, NOW).run();
}

/** An open question about `capability`, with the evaluation the receipt will name. */
async function seedOpenRequest(input: Readonly<{
  sessionId: string;
  requestId: string;
  evaluationId: string;
  capability: string;
  tier: number;
}>): Promise<void> {
  await seedEvaluation(input.evaluationId, input.capability, input.tier);
  await env.DB.prepare(`INSERT INTO owner_action_requests (
    request_id, session_id, lifecycle_generation, owner_principal_id, owner_identity_id,
    capability, evaluation_id, explanation, opened_at, deadline_at
  ) VALUES (?, ?, 1, ?, ?, ?, ?, 'Book the table, which costs money.', ?, ?)`)
    .bind(input.requestId, input.sessionId, OWNER, IDENTITY, input.capability, input.evaluationId, NOW, LATE)
    .run();
}

function attempt(requestId: string, ordinal: number, outcome: string | null, method = "spoken_pin", at = SOON): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO owner_action_attempts (
    request_id, attempt_ordinal, method, outcome, attempted_at, resolved_at
  ) VALUES (?, ?, ?, ?, ?, ?)`).bind(requestId, ordinal, method, outcome, at, outcome === null ? null : at);
}

function receipt(overrides: Partial<{
  authorisationId: string;
  requestId: string;
  sessionId: string;
  capability: string;
  evaluationId: string;
  credential: string;
  credentialVersion: number;
  attemptOrdinal: number;
  authorisedAt: string;
  expiresAt: string;
}> = {}): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO owner_action_authorisations (
    authorisation_id, request_id, session_id, lifecycle_generation, owner_principal_id, owner_identity_id,
    capability, evaluation_id, credential, credential_version, attempt_ordinal, authorised_at, expires_at, consumed_at
  ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).bind(
    overrides.authorisationId ?? nextReceiptId(),
    overrides.requestId ?? ulid("e01"),
    overrides.sessionId ?? ulid("f01"),
    OWNER, IDENTITY,
    overrides.capability ?? "spend.money",
    overrides.evaluationId ?? ulid("a01"),
    overrides.credential ?? "call_pin",
    overrides.credentialVersion ?? 1,
    overrides.attemptOrdinal ?? 1,
    overrides.authorisedAt ?? SOON,
    overrides.expiresAt ?? "2026-09-17T18:02:00.000Z",
  );
}

/**
 * Runs `work` with one trigger removed and puts it back. A guard nobody can
 * take away is indistinguishable from a guard that never fires, so the tests
 * below assert both halves where the second half is observable.
 */
async function withoutTrigger(name: string, work: () => Promise<unknown>): Promise<unknown> {
  if (!/^[a-z0-9_]+$/u.test(name)) throw new Error("unsafe_test_trigger");
  const row = await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
    .bind(name).first<{ sql: string }>();
  if (row === null) throw new Error(`missing trigger ${name}`);
  await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  try {
    return await work();
  } finally {
    await env.DB.prepare(row.sql).run();
  }
}

describe("owner sensitive-action PIN migration", () => {
  beforeAll(async () => {
    await applyOwnerSensitiveActionPinMigration();
    await seedPeople();
  });

  it("adds booking, access, credentials, safety and sensitive memory to the one sensitive list", async () => {
    const rows = await env.DB.prepare(
      "SELECT capability, tier FROM capability_tiers WHERE tier = 3 ORDER BY capability",
    ).all<{ capability: string; tier: number }>();
    expect(rows.results).toEqual([
      { capability: "access.manage", tier: 3 },
      { capability: "book.service", tier: 3 },
      { capability: "contact.third_party", tier: 3 },
      { capability: "credentials.manage", tier: 3 },
      { capability: "delete.data", tier: 3 },
      { capability: "disclose.sensitive_memory", tier: 3 },
      { capability: "safety.configure", tier: 3 },
      { capability: "spend.money", tier: 3 },
      { capability: "vehicle.unlock", tier: 3 },
      { capability: "write.production", tier: 3 },
    ]);
  });

  it("keeps every action column list free of anything that could hold a candidate", async () => {
    // Whole-column equality rather than a name check: the guarantee is that
    // there is nowhere to put digits, so a later column that could hold them
    // has to fail here rather than be noticed in a log review.
    const expected: Record<string, readonly string[]> = {
      owner_action_requests: [
        "request_id", "session_id", "lifecycle_generation", "owner_principal_id", "owner_identity_id",
        "capability", "evaluation_id", "explanation", "opened_at", "deadline_at",
        "outcome", "resolved_at",
      ],
      owner_action_attempts: [
        "request_id", "attempt_ordinal", "method", "outcome", "attempted_at", "resolved_at",
      ],
      owner_action_reprompts: ["request_id", "reprompt_ordinal", "reprompt_kind", "prompted_at"],
      owner_action_authorisations: [
        "authorisation_id", "request_id", "session_id", "lifecycle_generation", "owner_principal_id",
        "owner_identity_id", "capability", "evaluation_id", "credential", "credential_version",
        "attempt_ordinal", "authorised_at", "expires_at", "consumed_at",
      ],
    };
    for (const [table, columns] of Object.entries(expected)) {
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(info.results.map((column) => column.name), table).toEqual(columns);
    }
  });

  it("pins every guard this migration adds as one named trigger", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
    ).all<{ name: string }>();
    const mine = rows.results.map((row) => row.name)
      .filter((name) => name.startsWith("owner_call_pin_") || name.startsWith("owner_action_"));
    expect(mine).toEqual([
      "owner_action_attempts_delete_forbidden",
      "owner_action_attempts_insert_guard",
      "owner_action_attempts_publish_exhaustion",
      "owner_action_attempts_settlement_exhaustion",
      "owner_action_attempts_transition_guard",
      "owner_action_authorisations_consume_guard",
      "owner_action_authorisations_delete_forbidden",
      "owner_action_authorisations_insert_guard",
      "owner_action_authorisations_publish",
      "owner_action_reprompts_delete_forbidden",
      "owner_action_reprompts_immutable",
      "owner_action_reprompts_insert_guard",
      "owner_action_requests_delete_forbidden",
      "owner_action_requests_insert_guard",
      "owner_action_requests_transition_guard",
      "owner_call_pin_heads_delete_forbidden",
      "owner_call_pin_heads_insert_guard",
      "owner_call_pin_heads_update_guard",
      "owner_call_pin_rotation_commit_publish",
      "owner_call_pin_rotation_commits_delete_forbidden",
      "owner_call_pin_rotation_commits_immutable",
      "owner_call_pin_rotation_commits_insert_guard",
      "owner_call_pin_verifiers_delete_forbidden",
      "owner_call_pin_verifiers_insert_guard",
      "owner_call_pin_verifiers_transition_guard",
    ]);
  });

  it("refuses a staged PIN verifier that names a device the owner does not hold", async () => {
    await expect(stagePin(1, { deviceId: "device:pin-foreign", keyId: "key:pin-foreign", fingerprint: "3".repeat(64) })
      .run()).rejects.toThrow("owner_call_pin_verifier_insert_invalid");
    await expect(stagePin(2, { status: "active" }).run()).rejects.toThrow("owner_call_pin_verifier_insert_invalid");
  });

  it("refuses a rotation that names a PIN version which is not the active one", async () => {
    await seedActivePin();
    await expect(rotationCommit(ulid("c03"), 3, 4, SOON).run())
      .rejects.toThrow("owner_call_pin_rotation_state_changed");
  });

  it("refuses to let the PIN be deleted or re-pointed at another version without a rotation", async () => {
    await seedActivePin();
    await expect(env.DB.prepare("DELETE FROM owner_call_pin_heads").run())
      .rejects.toThrow("owner_call_pin_head_delete_forbidden");
    await expect(env.DB.prepare("DELETE FROM owner_call_pin_verifiers").run())
      .rejects.toThrow("owner_call_pin_verifier_delete_forbidden");
    await expect(env.DB.prepare("UPDATE owner_call_pin_heads SET pin_version = 1 WHERE singleton_id = 1").run())
      .rejects.toThrow("owner_call_pin_head_update_invalid");
  });

  it("refuses a receipt for a capability that is not on the sensitive list", async () => {
    const sessionId = ulid("f01");
    const requestId = ulid("e01");
    const evaluationId = ulid("a01");
    await seedOwnerSession(sessionId, "1");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "read.archive", tier: 1 });
    await attempt(requestId, 1, "matched").run();
    await expect(receipt({ requestId, sessionId, evaluationId, capability: "read.archive" }).run())
      .rejects.toThrow("owner_action_authorisation_invalid");
    await withoutTrigger("owner_action_authorisations_insert_guard", () =>
      receipt({ requestId, sessionId, evaluationId, capability: "read.archive" }).run());
    expect(await env.DB.prepare("SELECT capability FROM owner_action_authorisations WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ capability: "read.archive" });
  });

  it("refuses a receipt whose bound attempt did not match", async () => {
    const sessionId = ulid("f02");
    const requestId = ulid("e02");
    const evaluationId = ulid("a02");
    await seedOwnerSession(sessionId, "2");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "spend.money", tier: 3 });
    await attempt(requestId, 1, "mismatched").run();
    await expect(receipt({ requestId, sessionId, evaluationId }).run())
      .rejects.toThrow("owner_action_authorisation_invalid");
    await attempt(requestId, 2, "matched").run();
    await expect(receipt({ requestId, sessionId, evaluationId, attemptOrdinal: 2 }).run()).resolves.toBeDefined();
  });

  it("refuses a receipt that answers a question outside its own two-minute window", async () => {
    const sessionId = ulid("f03");
    const requestId = ulid("e03");
    const evaluationId = ulid("a03");
    await seedOwnerSession(sessionId, "3");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "spend.money", tier: 3 });
    await attempt(requestId, 1, "matched", "spoken_pin", PAST_DEADLINE).run();
    await expect(receipt({
      requestId, sessionId, evaluationId,
      authorisedAt: PAST_DEADLINE, expiresAt: "2026-09-17T18:04:00.000Z",
    }).run()).rejects.toThrow("owner_action_authorisation_invalid");
    await withoutTrigger("owner_action_authorisations_insert_guard", () => receipt({
      requestId, sessionId, evaluationId,
      authorisedAt: PAST_DEADLINE, expiresAt: "2026-09-17T18:04:00.000Z",
    }).run());
    expect(await env.DB.prepare("SELECT request_id FROM owner_action_authorisations WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ request_id: requestId });
  });

  it("refuses a receipt that names a credential which is not active", async () => {
    const sessionId = ulid("f04");
    const requestId = ulid("e04");
    const evaluationId = ulid("a04");
    await seedOwnerSession(sessionId, "4");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "spend.money", tier: 3 });
    await attempt(requestId, 1, "matched").run();
    await expect(receipt({ requestId, sessionId, evaluationId, credentialVersion: 9 }).run())
      .rejects.toThrow("owner_action_authorisation_invalid");
    await expect(receipt({ requestId, sessionId, evaluationId, credential: "owner_passphrase" }).run())
      .rejects.toThrow("owner_action_authorisation_invalid");
  });

  it("records the action the receipt authorised and settles the question it answered", async () => {
    const sessionId = ulid("f05");
    const requestId = ulid("e05");
    const evaluationId = ulid("a05");
    await seedOwnerSession(sessionId, "5");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "book.service", tier: 3 });
    await attempt(requestId, 1, "matched").run();
    await receipt({ requestId, sessionId, evaluationId, capability: "book.service" }).run();
    expect(await env.DB.prepare(`SELECT capability, credential, credential_version, authorised_at, expires_at, consumed_at
      FROM owner_action_authorisations WHERE request_id = ?`).bind(requestId).first()).toEqual({
      capability: "book.service", credential: "call_pin", credential_version: 1,
      authorised_at: SOON, expires_at: "2026-09-17T18:02:00.000Z", consumed_at: null,
    });
    expect(await env.DB.prepare("SELECT outcome, resolved_at FROM owner_action_requests WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ outcome: "authorised", resolved_at: SOON });
  });

  it("spends a receipt once and refuses to let it be re-pointed afterwards", async () => {
    const sessionId = ulid("f06");
    const requestId = ulid("e06");
    const evaluationId = ulid("a06");
    const authorisationId = nextReceiptId();
    await seedOwnerSession(sessionId, "6");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "delete.data", tier: 3 });
    await attempt(requestId, 1, "matched").run();
    await receipt({ authorisationId, requestId, sessionId, evaluationId, capability: "delete.data" }).run();
    await env.DB.prepare("UPDATE owner_action_authorisations SET consumed_at = ? WHERE authorisation_id = ?")
      .bind("2026-09-17T18:01:00.000Z", authorisationId).run();
    await expect(env.DB.prepare("UPDATE owner_action_authorisations SET consumed_at = ? WHERE authorisation_id = ?")
      .bind("2026-09-17T18:02:00.000Z", authorisationId).run())
      .rejects.toThrow("owner_action_authorisation_consume_invalid");
    await expect(env.DB.prepare("UPDATE owner_action_authorisations SET capability = 'spend.money' WHERE authorisation_id = ?")
      .bind(authorisationId).run())
      .rejects.toThrow("owner_action_authorisation_consume_invalid");
    await withoutTrigger("owner_action_authorisations_consume_guard", () =>
      env.DB.prepare("UPDATE owner_action_authorisations SET capability = 'spend.money' WHERE authorisation_id = ?")
        .bind(authorisationId).run());
    expect(await env.DB.prepare("SELECT capability FROM owner_action_authorisations WHERE authorisation_id = ?")
      .bind(authorisationId).first()).toEqual({ capability: "spend.money" });
    await expect(env.DB.prepare("DELETE FROM owner_action_authorisations").run())
      .rejects.toThrow("owner_action_authorisation_delete_forbidden");
  });

  it("refuses an attempt that skips the next ordinal", async () => {
    const sessionId = ulid("f07");
    const requestId = ulid("e07");
    const evaluationId = ulid("a07");
    await seedOwnerSession(sessionId, "7");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "spend.money", tier: 3 });
    await expect(attempt(requestId, 3, "mismatched", "spoken_pin", NOW).run())
      .rejects.toThrow("owner_action_attempt_invalid");
    await withoutTrigger("owner_action_attempts_insert_guard", () =>
      attempt(requestId, 3, "mismatched", "spoken_pin", NOW).run());
    expect(await env.DB.prepare("SELECT attempt_ordinal FROM owner_action_attempts WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ attempt_ordinal: 3 });
  });

  it("refuses the action once five attempts have been spent", async () => {
    const sessionId = ulid("f0a");
    const requestId = ulid("e0a");
    const evaluationId = ulid("a0a");
    await seedOwnerSession(sessionId, "a");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "spend.money", tier: 3 });
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      await attempt(requestId, ordinal, "mismatched", "spoken_pin", NOW).run();
    }
    expect(await env.DB.prepare("SELECT outcome FROM owner_action_requests WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ outcome: null });
    await attempt(requestId, 5, "mismatched", "spoken_pin", NOW).run();
    expect(await env.DB.prepare("SELECT outcome, resolved_at FROM owner_action_requests WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ outcome: "refused", resolved_at: NOW });
    // The ceiling is the ordinal CHECK and the sequence is the trigger, so a
    // sixth attempt is refused for the ordinal before the guard sees it.
    await expect(attempt(requestId, 6, "mismatched", "spoken_pin", NOW).run()).rejects.toThrow();
    await expect(attempt(requestId, 5, "matched", "spoken_pin", NOW).run())
      .rejects.toThrow("owner_action_attempt_invalid");
  });

  it("refuses the action when a reserved fifth attempt is settled as a mismatch", async () => {
    const sessionId = ulid("f0b");
    const requestId = ulid("e0b");
    await seedOwnerSession(sessionId, "d");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId: ulid("a0b"), capability: "spend.money", tier: 3 });
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
      await attempt(requestId, ordinal, null, "spoken_pin", NOW).run();
    }
    // A reserved attempt counts before it settles, so the question is already
    // at its ceiling while nothing has been compared yet.
    expect(await env.DB.prepare("SELECT outcome FROM owner_action_requests WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ outcome: null });
    await env.DB.prepare(`UPDATE owner_action_attempts SET outcome = 'mismatched', resolved_at = ?
      WHERE request_id = ? AND attempt_ordinal = 5`).bind(NOW, requestId).run();
    expect(await env.DB.prepare("SELECT outcome, resolved_at FROM owner_action_requests WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ outcome: "refused", resolved_at: NOW });
  });

  it("leaves the question open when the settlement ceiling is taken away", async () => {
    const sessionId = ulid("f0c");
    const requestId = ulid("e0c");
    await seedOwnerSession(sessionId, "e");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId: ulid("a0c"), capability: "spend.money", tier: 3 });
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
      await attempt(requestId, ordinal, null, "spoken_pin", NOW).run();
    }
    await withoutTrigger("owner_action_attempts_settlement_exhaustion", () =>
      env.DB.prepare(`UPDATE owner_action_attempts SET outcome = 'mismatched', resolved_at = ?
        WHERE request_id = ? AND attempt_ordinal = 5`).bind(NOW, requestId).run());
    expect(await env.DB.prepare("SELECT outcome FROM owner_action_requests WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ outcome: null });
  });

  it("refuses to say the same re-prompt twice", async () => {
    const sessionId = ulid("f08");
    const requestId = ulid("e08");
    const evaluationId = ulid("a08");
    await seedOwnerSession(sessionId, "8");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId, evaluationId, capability: "spend.money", tier: 3 });
    const reprompt = (ordinal: number, kind: string): D1PreparedStatement => env.DB.prepare(
      `INSERT INTO owner_action_reprompts (request_id, reprompt_ordinal, reprompt_kind, prompted_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(requestId, ordinal, kind, NOW);
    await reprompt(1, "unclear").run();
    await expect(reprompt(2, "unclear").run()).rejects.toThrow("owner_action_reprompt_repeated");
    await withoutTrigger("owner_action_reprompts_insert_guard", () => reprompt(2, "unclear").run());
    expect(await env.DB.prepare("SELECT count(*) AS count FROM owner_action_reprompts WHERE request_id = ?")
      .bind(requestId).first()).toEqual({ count: 2 });
    await expect(reprompt(3, "unclear").run()).rejects.toThrow("owner_action_reprompt_repeated");
    await reprompt(3, "wrong").run();
    await reprompt(4, "keypad").run();
    await expect(env.DB.prepare("UPDATE owner_action_reprompts SET prompted_at = ?").bind(LATE).run())
      .rejects.toThrow("owner_action_reprompt_immutable");
  });

  it("refuses a second open question for the same call", async () => {
    const sessionId = ulid("f09");
    await seedOwnerSession(sessionId, "9");
    await seedActivePin();
    await seedOpenRequest({ sessionId, requestId: ulid("e09"), evaluationId: ulid("a09"), capability: "spend.money", tier: 3 });
    await expect(seedOpenRequest({
      sessionId, requestId: ulid("e10"), evaluationId: ulid("a10"), capability: "delete.data", tier: 3,
    })).rejects.toThrow();
  });

  it("admits the owner with no step-up now that the gate has moved", async () => {
    const sessionId = ulid("f11");
    await seedOwnerSession(sessionId, "b");
    await env.DB.prepare(`INSERT INTO call_session_authorities (
      session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
      access_document_hash, authenticated_at, expires_at
    ) VALUES (?, 'owner', ?, ?, NULL, NULL, NULL, ?, ?)`)
      .bind(sessionId, OWNER, IDENTITY, SOON, "2026-09-17T18:30:30.000Z").run();
    expect(await env.DB.prepare("SELECT authority_kind FROM call_session_authorities WHERE session_id = ?")
      .bind(sessionId).first()).toEqual({ authority_kind: "owner" });
  });

  it("still refuses an owner authority for a session that is not the verified owner voice identity", async () => {
    const sessionId = ulid("f12");
    await seedOwnerSession(sessionId, "c");
    const rogue = (): Promise<unknown> => env.DB.prepare(`INSERT INTO call_session_authorities (
      session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
      access_document_hash, authenticated_at, expires_at
    ) VALUES (?, 'owner', 'service:pin-foreign', ?, NULL, NULL, NULL, ?, ?)`)
      .bind(sessionId, IDENTITY, SOON, "2026-09-17T18:30:30.000Z").run();
    await expect(rogue()).rejects.toThrow("call_session_authority_requires_current_lineage");
    await withoutTrigger("call_session_authorities_require_current_lineage", rogue);
    expect(await env.DB.prepare("SELECT authority_kind FROM call_session_authorities WHERE session_id = ?")
      .bind(sessionId).first()).toEqual({ authority_kind: "owner" });
  });

  // Last, and deliberately so. The head is a singleton, so this test advances
  // the one live PIN version the rest of the file reads; every other test
  // above would fail its own guard if this ran first.
  it("publishes a rotation and moves the one live PIN version it names", async () => {
    await seedActivePin();
    await env.DB.batch([stagePin(2), rotationCommit(ulid("c02"), 1, 2, SOON)]);
    await env.DB.prepare("UPDATE owner_call_pin_heads SET pin_version = 2, updated_at = ?").bind(SOON).run();
    const verifiers = await env.DB.prepare(
      "SELECT pin_version, status FROM owner_call_pin_verifiers ORDER BY pin_version",
    ).all<{ pin_version: number; status: string }>();
    expect(verifiers.results).toEqual([
      { pin_version: 1, status: "revoked" },
      { pin_version: 2, status: "active" },
    ]);
    expect(await env.DB.prepare("SELECT pin_version FROM owner_call_pin_heads").first()).toEqual({ pin_version: 2 });
  });
});
