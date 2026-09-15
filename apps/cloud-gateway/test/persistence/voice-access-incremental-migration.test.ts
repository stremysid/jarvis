import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type RelayBinding, type Ulid } from "../../../../packages/contracts/src/index.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { OwnerPassphraseVerifier } from "../../src/security/owner-passphrase-verifier.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import { OwnerCallStepUpService } from "../../src/voice/owner-call-step-up.js";
import { VoiceAccessAuthorityService } from "../../src/voice/voice-access-authority.js";
import {
  applyOwnerCallStepUpMigration,
  applyVoiceRuntimeMigration,
  voiceAccessBaseMigrations,
  voiceAccessBoundariesMigration,
} from "./migration.js";

const CREATED_AT = "2026-08-30T00:00:00.000Z";
const BOUND_AT = "2026-08-30T00:04:00.000Z";
const AUTHENTICATED_AT = "2026-08-30T00:06:00.000Z";
const BACKFILLED_DEADLINE = "2026-08-30T00:30:00.000Z";
const LEGACY_DEADLINE = "2026-08-30T00:36:00.000Z";
const OWNER_PRINCIPAL_ID = "principal:incremental-owner";
const OWNER_IDENTITY_ID = "identity:incremental-owner";
const LEGACY_SESSION_ID = "01k3w1t4000000000000000600" as Ulid;
const FRESH_SESSION_ID = "01k3w1t4000000000000000601" as Ulid;

function ownerBinding(marker: "a" | "b"): RelayBinding {
  return Object.freeze({
    callSid: `CA${marker.repeat(32)}`,
    principalId: OWNER_PRINCIPAL_ID,
    identityId: OWNER_IDENTITY_ID,
    destinationIdentityId: OWNER_IDENTITY_ID,
    relayNonce: `${marker.repeat(42)}A`,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: "owner",
    guestGrantId: null,
    guestGrantVersion: null,
    accessDocumentHash: null,
  });
}

async function seedBoundOwnerSession(sessionId: Ulid, binding: RelayBinding): Promise<void> {
  await env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
    direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
    nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?,
    'owner', NULL, NULL, NULL)`)
    .bind(
      sessionId,
      binding.callSid,
      binding.principalId,
      binding.identityId,
      binding.destinationIdentityId,
      binding.relayNonce,
      "2026-08-30T00:05:00.000Z",
      "2026-08-30T00:05:00.000Z",
      CREATED_AT,
      CREATED_AT,
    ).run();
  await env.DB.prepare("UPDATE call_sessions SET provider_session_id = ?, updated_at = ? WHERE session_id = ?")
    .bind(`VX${binding.callSid.slice(2)}`, BOUND_AT, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(BOUND_AT, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(AUTHENTICATED_AT, sessionId).run();
}

describe("voice-access incremental migration", () => {
  it("backfills pre-0007 provider bindings conservatively without extending authority", async () => {
    await applyD1Migrations(env.DB, [...voiceAccessBaseMigrations]);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?, 'human', 'active', 'incremental owner', ?, ?)`)
        .bind(OWNER_PRINCIPAL_ID, CREATED_AT, CREATED_AT),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
      ) VALUES (?, ?, 'voice', '+14165550101', 'active', ?, ?)`)
        .bind(OWNER_IDENTITY_ID, OWNER_PRINCIPAL_ID, CREATED_AT, CREATED_AT),
      env.DB.prepare(`INSERT INTO voice_owner_identity (
        singleton_id, principal_id, identity_id, created_at
      ) VALUES (1, ?, ?, ?)`)
        .bind(OWNER_PRINCIPAL_ID, OWNER_IDENTITY_ID, CREATED_AT),
    ]);
    const legacyBinding = ownerBinding("a");
    const freshBinding = ownerBinding("b");
    await seedBoundOwnerSession(LEGACY_SESSION_ID, legacyBinding);
    await seedBoundOwnerSession(FRESH_SESSION_ID, freshBinding);
    await env.DB.prepare(`INSERT INTO call_session_authorities (
      session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
      access_document_hash, authenticated_at, expires_at
    ) VALUES (?, 'owner', ?, ?, NULL, NULL, NULL, ?, ?)`)
      .bind(
        LEGACY_SESSION_ID,
        OWNER_PRINCIPAL_ID,
        OWNER_IDENTITY_ID,
        AUTHENTICATED_AT,
        LEGACY_DEADLINE,
      ).run();
    await env.DB.prepare("UPDATE call_sessions SET phase = 'authenticated', updated_at = ? WHERE session_id = ?")
      .bind(AUTHENTICATED_AT, LEGACY_SESSION_ID).run();

    await applyD1Migrations(env.DB, [
      ...voiceAccessBaseMigrations,
      voiceAccessBoundariesMigration,
    ]);

    const calls = new CallRepository(env.DB, new EventRepository(env.DB));
    const legacySession = await calls.getCallSession(LEGACY_SESSION_ID);
    const freshSession = await calls.getCallSession(FRESH_SESSION_ID);
    expect(legacySession).toMatchObject({
      providerSessionId: `VX${legacyBinding.callSid.slice(2)}`,
      providerConnectedAt: CREATED_AT,
    });
    expect(freshSession).toMatchObject({
      providerSessionId: `VX${freshBinding.callSid.slice(2)}`,
      providerConnectedAt: CREATED_AT,
    });

    await expect(env.DB.prepare(`UPDATE call_sessions
      SET provider_connected_at = ?, updated_at = ? WHERE session_id = ?`)
      .bind(BOUND_AT, AUTHENTICATED_AT, LEGACY_SESSION_ID).run())
      .rejects.toThrow("call_session_provider_connected_at_immutable");

    // The deploy sequence can cross this old state, but the current authority
    // runtime is only admitted after its additive schemas have been applied.
    await applyVoiceRuntimeMigration();
    await applyOwnerCallStepUpMigration();

    const registry = new CapabilityRegistry({ installed: ["conversation.basic"] });
    const restarted = new VoiceAccessAuthorityService(new VoiceAccessRepository(env.DB), registry);
    await expect(restarted.rehydrate({
      sessionId: LEGACY_SESSION_ID,
      binding: legacyBinding,
      now: new Date("2026-08-30T00:07:00.000Z"),
    })).rejects.toThrow("call_authority_invalid");

    await new OwnerCallStepUpService(
      env.DB, new OwnerPassphraseVerifier(new Uint8Array(32).fill(17), "v1"),
    ).bind({
      sessionId: FRESH_SESSION_ID, callSid: freshBinding.callSid,
      ownerPrincipalId: OWNER_PRINCIPAL_ID, ownerIdentityId: OWNER_IDENTITY_ID,
      direction: "inbound", lifecycleGeneration: 1, requirement: "waived_passed_a",
      attestationClass: "passed_a", policy: "waive_on_passed_a", createdAt: CREATED_AT,
    });

    const fresh = await restarted.mintOwner({
      sessionId: FRESH_SESSION_ID,
      binding: freshBinding,
      now: new Date(AUTHENTICATED_AT),
    });
    expect(fresh.expiresAt).toBe(BACKFILLED_DEADLINE);
    await expect(new VoiceAccessAuthorityService(new VoiceAccessRepository(env.DB), registry).rehydrate({
      sessionId: FRESH_SESSION_ID,
      binding: freshBinding,
      now: new Date(BACKFILLED_DEADLINE),
    })).rejects.toThrow("call_authority_expired");
  });
});
