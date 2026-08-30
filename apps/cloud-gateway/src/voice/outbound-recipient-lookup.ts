import type { OutboundRecipientIdentityLookup } from "./outbound.js";

const E164 = /^\+[1-9][0-9]{7,14}$/u;

/** Resolves provider-observed voice destinations without granting call authority. */
export class D1OutboundRecipientIdentityLookup implements OutboundRecipientIdentityLookup {
  constructor(private readonly database: D1Database) {}

  async resolveActiveVerifiedVoiceIdentityId(providerE164: string): Promise<string | null> {
    if (typeof providerE164 !== "string" || !E164.test(providerE164)) return null;
    const row = await this.database.prepare(`SELECT i.identity_id
      FROM channel_identities i
      JOIN principals p ON p.principal_id = i.principal_id
      WHERE i.channel = 'voice'
        AND i.provider_subject = ?1
        AND i.status = 'active'
        AND i.verified_at IS NOT NULL
        AND p.principal_type = 'human'
        AND p.status = 'active'
      LIMIT 1`)
      .bind(providerE164)
      .first<{ identity_id: string }>();
    return typeof row?.identity_id === "string" ? row.identity_id : null;
  }
}
