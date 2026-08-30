import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1OutboundRecipientIdentityLookup } from "../../src/voice/outbound-recipient-lookup.js";
import type { OutboundRecipientIdentityLookup } from "../../src/voice/outbound.js";
import { applyFoundationMigration } from "../persistence/migration.js";

const NOW = "2026-08-30T12:00:00.000Z";
const DESTINATION = "+14165550123";

async function clearFixture(): Promise<void> {
  await env.DB.prepare("DELETE FROM channel_identities").run();
  await env.DB.prepare("DELETE FROM principals").run();
}

async function seedActiveRecipient(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Owner', '1.0', 'PIN_VERIFIER_JSON', ?, ?)").bind(NOW, NOW),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', ?, 'active', ?, ?)").bind(DESTINATION, NOW, NOW),
  ]);
}

describe("D1OutboundRecipientIdentityLookup", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearFixture();
  });

  afterEach(clearFixture);

  it("resolves only an active verified voice identity owned by an active human principal", async () => {
    await seedActiveRecipient();
    const lookup: OutboundRecipientIdentityLookup = new D1OutboundRecipientIdentityLookup(env.DB);

    await expect(lookup.resolveActiveVerifiedVoiceIdentityId(DESTINATION)).resolves.toBe("identity:voice");

    await env.DB.prepare("UPDATE principals SET status = 'disabled' WHERE principal_id = 'principal:owner'").run();
    await expect(lookup.resolveActiveVerifiedVoiceIdentityId(DESTINATION)).resolves.toBeNull();

    await env.DB.prepare("UPDATE principals SET status = 'active' WHERE principal_id = 'principal:owner'").run();
    await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:voice'").run();
    await expect(lookup.resolveActiveVerifiedVoiceIdentityId(DESTINATION)).resolves.toBeNull();
  });
});
