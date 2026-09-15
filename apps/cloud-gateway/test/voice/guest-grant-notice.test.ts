import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { D1GuestGrantNoticeSink } from "../../src/voice/guest-grant-notice.js";
import {
  clearVoiceAccessFixture,
  NOW,
  OWNER_PRINCIPAL_ID,
} from "../persistence/voice-access-fixture.js";

describe("D1GuestGrantNoticeSink", () => {
  beforeEach(async () => {
    await clearVoiceAccessFixture(env.DB);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'human', 'active', 'Owner', ?, ?)",
      ).bind(OWNER_PRINCIPAL_ID, NOW.toISOString(), NOW.toISOString()),
      env.DB.prepare(
        "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:telegram-owner', ?, 'telegram', '12345', 'active', ?, ?)",
      ).bind(OWNER_PRINCIPAL_ID, NOW.toISOString(), NOW.toISOString()),
    ]);
  });
  afterEach(() => clearVoiceAccessFixture(env.DB));

  it("sends only the operation, masked target and time to the owner's verified Telegram identity", async () => {
    const sendMessage = vi.fn(async () => ({ providerMessageId: "901" }));
    const sink = new D1GuestGrantNoticeSink(env.DB, { sendMessage });

    await sink.notify({
      ownerPrincipalId: OWNER_PRINCIPAL_ID,
      mutationId: "01k3w1t4000000000000000510" as Ulid,
      operation: "pin_rotated",
      maskedTarget: "+1******0111",
      occurredAt: NOW,
    });

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      chatId: "12345",
      text: "Guest PIN rotated for +1******0111 at 2026-08-30T12:00:00.000Z.",
      idempotencyKey: "guest-grant:01k3w1t4000000000000000510",
    });
    expect(JSON.stringify(sendMessage.mock.calls)).not.toMatch(/14165550111|1357|4827|capabilit/iu);
  });
});
