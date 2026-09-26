import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1OwnerCallAdmissionAlertSink } from "../../src/voice/owner-call-alerts.js";
import {
  applyOwnerCallStepUpMigration,
  clearOwnerCallStepUpDataForTest,
} from "../persistence/migration.js";

/**
 * The alert that survives the removal of the owner-passphrase step-up.
 *
 * It reports the one condition that still has nothing to do with a credential:
 * every call-session slot was occupied, so an owner call never reached Jarvis.
 * The row coalesces because a busy afternoon is one problem, not forty
 * messages, and a delivery that throws must not waste the fifteen-minute
 * window -- the next refusal has to be able to retry.
 */

const OWNER = "principal:owner-call-alerts";
const CHAT_ID = "44112233";
const NOW = new Date("2026-09-14T12:00:00.000Z");

describe("owner call admission alert coalescing", () => {
  beforeEach(async () => {
    await applyOwnerCallStepUpMigration();
    await clearOwnerCallStepUpDataForTest();
    await env.DB.prepare("DELETE FROM channel_identities WHERE identity_id = 'identity:owner-call-alerts'").run();
    await env.DB.prepare("DELETE FROM principals WHERE principal_id = ?").bind(OWNER).run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?, 'human', 'active', 'Owner', ?, ?)`).bind(OWNER, NOW.toISOString(), NOW.toISOString()),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
      ) VALUES ('identity:owner-call-alerts', ?, 'telegram', ?, 'active', ?, ?)`)
        .bind(OWNER, CHAT_ID, NOW.toISOString(), NOW.toISOString()),
    ]);
  });

  it("delivers immediately, counts suppressed observations, and sends at most once per 15 minutes", async () => {
    const sent: Array<Readonly<{ chatId: string; text: string; idempotencyKey: string }>> = [];
    const sink = new D1OwnerCallAdmissionAlertSink(env.DB, {
      async sendMessage(input) {
        sent.push(input);
        return { providerMessageId: String(sent.length) };
      },
    });
    const alert = (now: Date) => sink.alert({ ownerPrincipalId: OWNER, direction: "inbound", now });

    await alert(NOW);
    await alert(new Date(NOW.valueOf() + 60_000));
    expect(sent).toHaveLength(1);
    await alert(new Date(NOW.valueOf() + 15 * 60_000 + 1));

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ chatId: CHAT_ID });
    expect(sent[0]?.text).toBe(
      "Jarvis refused an inbound owner call because all call-session slots were occupied. Total observations: 1.",
    );
    expect(sent[1]?.text).toBe(
      "Jarvis refused an inbound owner call because all call-session slots were occupied. Total observations: 3.",
    );
    expect(sent.map(({ text }) => text)).not.toContainEqual(expect.stringMatching(/passphrase candidate|phone|\+1/iu));
    await expect(env.DB.prepare(`SELECT observation_count, claim_id, claim_expires_at
      FROM owner_call_step_up_alerts WHERE owner_principal_id = ? AND alert_class = 'admission_refused'
        AND direction = 'inbound'`).bind(OWNER).first()).resolves.toEqual({
      observation_count: 3,
      claim_id: null,
      claim_expires_at: null,
    });
  });

  it("keeps outbound alerts free of caller-attestation claims", async () => {
    const sent: string[] = [];
    const sink = new D1OwnerCallAdmissionAlertSink(env.DB, {
      async sendMessage(input) {
        sent.push(input.text);
        return { providerMessageId: "1" };
      },
    });
    await sink.alert({ ownerPrincipalId: OWNER, direction: "outbound", now: NOW });

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/attestation/iu);
    expect(sent[0]).toContain("outbound owner call");
  });

  it("releases a failed delivery claim so the next refusal retries immediately", async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("telegram_unavailable"))
      .mockResolvedValueOnce({ providerMessageId: "2" });
    const sink = new D1OwnerCallAdmissionAlertSink(env.DB, { sendMessage });
    const alert = () => sink.alert({ ownerPrincipalId: OWNER, direction: "inbound", now: NOW });

    await expect(alert()).rejects.toThrow("telegram_unavailable");
    await expect(env.DB.prepare(`SELECT last_sent_at, claim_id, claim_expires_at
      FROM owner_call_step_up_alerts WHERE owner_principal_id = ? AND alert_class = 'admission_refused'
        AND direction = 'inbound'`).bind(OWNER).first()).resolves.toEqual({
      last_sent_at: null, claim_id: null, claim_expires_at: null,
    });

    await expect(alert()).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    await expect(env.DB.prepare(`SELECT last_sent_at, claim_id, claim_expires_at
      FROM owner_call_step_up_alerts WHERE owner_principal_id = ? AND alert_class = 'admission_refused'
        AND direction = 'inbound'`).bind(OWNER).first()).resolves.toEqual({
      last_sent_at: NOW.toISOString(), claim_id: null, claim_expires_at: null,
    });
  });
});
