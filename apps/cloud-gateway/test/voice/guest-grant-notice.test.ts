import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { D1GuestGrantNoticeSink } from "../../src/voice/guest-grant-notice.js";
import {
  clearVoiceAccessFixture,
  MUTATION_ID,
  NOW,
  OWNER_PRINCIPAL_ID,
  seedOwnerAuthority,
  validCreateInput,
} from "../persistence/voice-access-fixture.js";

describe("D1GuestGrantNoticeSink", () => {
  let repository: VoiceAccessRepository;

  beforeEach(async () => {
    await clearVoiceAccessFixture(env.DB);
    repository = new VoiceAccessRepository(env.DB);
    const authority = await seedOwnerAuthority(env.DB, repository);
    await env.DB.prepare(
      "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:telegram-owner', ?, 'telegram', '12345', 'active', ?, ?)",
    ).bind(OWNER_PRINCIPAL_ID, NOW.toISOString(), NOW.toISOString()).run();
    await repository.createGuestGrant(validCreateInput(authority));
  });
  afterEach(() => clearVoiceAccessFixture(env.DB));

  it("rejects INSERT OR IGNORE and INSERT OR REPLACE collisions on pending notice rows", async () => {
    for (const conflict of ["IGNORE", "REPLACE"] as const) {
      await expect(env.DB.prepare(`INSERT OR ${conflict} INTO guest_grant_notices
        SELECT * FROM guest_grant_notices WHERE mutation_id = ?`).bind(MUTATION_ID).run())
        .rejects.toThrow("guest_grant_notice_invalid");
    }
  });

  it("delivers one persisted notice without repeating it after the delivered marker is recorded", async () => {
    const sendMessage = vi.fn(async () => ({ providerMessageId: "901" }));
    const sink = new D1GuestGrantNoticeSink(env.DB, { sendMessage });

    await sink.notify({ mutationId: MUTATION_ID, now: NOW });
    await sink.notify({ mutationId: MUTATION_ID, now: new Date(NOW.valueOf() + 1_000) });

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      chatId: "12345",
      text: "Guest access created for +1******0111 at 2026-08-30T12:00:00.000Z.",
      idempotencyKey: "guest-grant:01k3w1t4000000000000000510",
    });
    expect(JSON.stringify(sendMessage.mock.calls)).not.toMatch(/14165550111|1357|4827|capabilit/iu);
    await expect(env.DB.prepare(
      "SELECT status, provider_message_id FROM guest_grant_notices WHERE mutation_id = ?",
    ).bind(MUTATION_ID).first()).resolves.toMatchObject({ status: "delivered", provider_message_id: "901" });
  });

  it("does not confirm delivery without a valid Telegram message receipt", async () => {
    const sink = new D1GuestGrantNoticeSink(env.DB, {
      sendMessage: async () => ({ providerMessageId: "invalid" }),
    });

    await expect(sink.notify({ mutationId: MUTATION_ID, now: NOW }))
      .rejects.toThrow("guest_grant_notice_delivery_unconfirmed");
    await expect(env.DB.prepare(
      "SELECT status, claim_id FROM guest_grant_notices WHERE mutation_id = ?",
    ).bind(MUTATION_ID).first()).resolves.toMatchObject({ status: "pending", claim_id: null });
  });

  it("retries an unconfirmed pending notice through the durable drain", async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("telegram_unavailable"))
      .mockResolvedValueOnce({ providerMessageId: "902" });
    const sink = new D1GuestGrantNoticeSink(env.DB, { sendMessage });

    await expect(sink.notify({ mutationId: MUTATION_ID, now: NOW }))
      .rejects.toThrow("telegram_unavailable");
    await expect(sink.drain(new Date(NOW.valueOf() + 1_000))).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[0].idempotencyKey).toBe(sendMessage.mock.calls[1]?.[0].idempotencyKey);
  });

  it("reclaims an expired delivery claim left by an interrupted isolate", async () => {
    const expiresAt = new Date(NOW.valueOf() + 1_000);
    await env.DB.prepare(`UPDATE guest_grant_notices
      SET claim_id = 'interrupted-isolate', claim_expires_at = ?
      WHERE mutation_id = ?`).bind(expiresAt.toISOString(), MUTATION_ID).run();
    const sendMessage = vi.fn(async () => ({ providerMessageId: "903" }));
    const sink = new D1GuestGrantNoticeSink(env.DB, { sendMessage });

    await sink.notify({ mutationId: MUTATION_ID, now: new Date(expiresAt.valueOf() + 1) });

    expect(sendMessage).toHaveBeenCalledOnce();
    await expect(env.DB.prepare(
      "SELECT status, claim_id, provider_message_id FROM guest_grant_notices WHERE mutation_id = ?",
    ).bind(MUTATION_ID).first()).resolves.toMatchObject({
      status: "delivered", claim_id: null, provider_message_id: "903",
    });
  });
});
