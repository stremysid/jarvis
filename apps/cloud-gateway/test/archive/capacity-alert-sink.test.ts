import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1CapacityAlertSink } from "../../src/archive/capacity-alert-sink.js";
import type { CapacityAlert } from "../../src/archive/capacity-guard.js";
import type { TelegramProvider, TelegramSendMessageInput } from "../../src/providers/provider-types.js";
import { createDecisionPrincipal, type DecisionPrincipalFixture } from "../decisions/decision-fixture.js";
import { applyVoiceRuntimeMigration } from "../persistence/migration.js";

const instant = new Date("2026-09-13T16:00:00.000Z");
const modelAlert: CapacityAlert = {
  resource: "provider:model",
  threshold: "remaining_1_usd",
  code: "deepseek_balance_1_usd",
  idempotencyKey: "capacity:provider:model:remaining-1-usd",
};
let owner: DecisionPrincipalFixture;
let now = instant;
function sink(telegram: TelegramProvider, principalId = owner.principalId, database = env.DB) {
  return new D1CapacityAlertSink({ database, ownerPrincipalId: principalId, telegram, now: () => now });
}
async function state() {
  return env.DB.prepare("SELECT state, sent_at FROM capacity_alert_crossings WHERE owner_principal_id = ?")
    .bind(owner.principalId).first<{ state: string; sent_at: string | null }>();
}
beforeEach(async () => {
  now = new Date(instant);
  owner = await createDecisionPrincipal();
  await applyVoiceRuntimeMigration();
});
afterEach(() => vi.useRealTimers());

describe("D1CapacityAlertSink", () => {
  it("delivers the one-time $1 migration reminder and deduplicates across reconstruction", async () => {
    const sendMessage = vi.fn(async (_input: TelegramSendMessageInput) => ({ providerMessageId: "123" }));
    await expect(sink({ sendMessage }).emit(modelAlert)).resolves.toBeUndefined();
    await expect(sink({ sendMessage }).emit(modelAlert)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![0]).toEqual(expect.objectContaining({
      chatId: expect.any(String),
      text: expect.stringMatching(/DeepSeek.+\$1 or less.+Plan the switch/su),
      idempotencyKey: modelAlert.idempotencyKey,
    }));
    expect(await state()).toEqual({ state: "sent", sent_at: instant.toISOString() });
  });

  it("does not rearm the one-time balance reminder", async () => {
    const sendMessage = vi.fn(async () => ({ providerMessageId: "123" }));
    const subject = sink({ sendMessage });
    await subject.emit(modelAlert);
    await expect(subject.rearm(modelAlert.idempotencyKey)).rejects.toThrow("capacity_alert_unavailable");
    await subject.emit(modelAlert);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not let percentage-shaped model alerts replace the owner-selected balance notice", async () => {
    const sendMessage = vi.fn(async () => ({ providerMessageId: "123" }));
    await expect(sink({ sendMessage }).emit({
      resource: "provider:model", threshold: 85, code: "capacity_85", idempotencyKey: "capacity:provider:model:85",
    })).rejects.toThrow("capacity_alert_unavailable");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not suppress a new owner's crossing with the retired owner's receipt", async () => {
    const sendMessage = vi.fn(async () => ({ providerMessageId: "123" }));
    await sink({ sendMessage }).emit(modelAlert);
    const next = await createDecisionPrincipal();
    await sink({ sendMessage }, next.principalId).emit(modelAlert);
    await sink({ sendMessage }, next.principalId).emit(modelAlert);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge or send twice while another isolate holds the sending lease", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sendMessage = vi.fn(async () => { entered(); await blocked; return { providerMessageId: "123" }; });
    const first = sink({ sendMessage }).emit(modelAlert);
    await started;
    expect(await state()).toEqual({ state: "sending", sent_at: null });
    await expect(sink({ sendMessage }).emit(modelAlert)).rejects.toThrow("capacity_alert_unavailable");
    expect(sendMessage).toHaveBeenCalledOnce();
    release(); await first;
    expect((await state())?.state).toBe("sent");
  });

  it("retains uncertain sends and retries only after their durable lease expires", async () => {
    const sendMessage = vi.fn(async () => { throw new Error("synthetic private provider detail"); });
    await expect(sink({ sendMessage }).emit(modelAlert)).rejects.toThrow(/^capacity_alert_unavailable$/);
    expect(await state()).toEqual({ state: "sending", sent_at: null });
    const acknowledged = vi.fn(async () => ({ providerMessageId: "124" }));
    now = new Date(instant.getTime() + 29_999);
    await expect(sink({ sendMessage: acknowledged }).emit(modelAlert)).rejects.toThrow("capacity_alert_unavailable");
    expect(acknowledged).not.toHaveBeenCalled();
    now = new Date(instant.getTime() + 30_000);
    await expect(sink({ sendMessage: acknowledged }).emit(modelAlert)).resolves.toBeUndefined();
    expect(acknowledged).toHaveBeenCalledOnce();
    expect((await state())?.state).toBe("sent");
  });

  it.each(["missing", "ambiguous"])("refuses a %s owner destination without sending", async (mode) => {
    if (mode === "missing") {
      await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = ?").bind(owner.identityId).run();
    } else {
      await env.DB.prepare(`INSERT INTO channel_identities
        (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
        VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`).bind(`${owner.identityId}:other`, owner.principalId,
        `${owner.identityId}:other`, instant.toISOString(), instant.toISOString()).run();
    }
    const sendMessage = vi.fn(async () => ({ providerMessageId: "123" }));
    await expect(sink({ sendMessage }).emit(modelAlert)).rejects.toThrow("capacity_alert_unavailable");
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await state())?.state).toBe("sending");
  });

  it("refuses a late acknowledgement after another sender has replaced its lease", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = sink({ sendMessage: async () => { entered(); await blocked; return { providerMessageId: "123" }; } }).emit(modelAlert);
    const denied = expect(first).rejects.toThrow("capacity_alert_unavailable");
    await started;
    now = new Date(instant.getTime() + 30_000);
    const second = sink({ sendMessage: async () => { throw new Error("uncertain"); } });
    await expect(second.emit(modelAlert)).rejects.toThrow("capacity_alert_unavailable");
    release(); await denied;
    expect(await state()).toEqual({ state: "sending", sent_at: null });
  });

  it.each(["expired", "replaced"])("does not send after a slow destination read leaves its lease %s", async (mode) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const database = { prepare: (sql: string) => {
      const statement = env.DB.prepare(sql);
      if (!sql.includes("SELECT ci.provider_subject")) return statement;
      return { bind: (...values: unknown[]) => ({ all: async () => { entered(); await blocked; return statement.bind(...values).all(); } }) };
    } } as unknown as D1Database;
    const sendMessage = vi.fn(async () => ({ providerMessageId: "123" }));
    const denied = expect(sink({ sendMessage }, owner.principalId, database).emit(modelAlert)).rejects.toThrow("capacity_alert_unavailable");
    await started;
    now = new Date(instant.getTime() + 30_000);
    if (mode === "replaced") await sink({ sendMessage }).emit(modelAlert);
    release(); await denied;
    expect(sendMessage).toHaveBeenCalledTimes(mode === "replaced" ? 1 : 0);
    expect((await state())?.state).toBe(mode === "replaced" ? "sent" : "sending");
  });

  it("refuses an acknowledgement that arrives exactly at its lease expiry", async () => {
    await expect(sink({ sendMessage: async () => {
      now = new Date(instant.getTime() + 30_000);
      return { providerMessageId: "123" };
    } }).emit(modelAlert)).rejects.toThrow("capacity_alert_unavailable");
    expect((await state())?.state).toBe("sending");
  });

  it("refuses malformed acknowledgements without recording delivery", async () => {
    await expect(sink({ sendMessage: async () => ({ providerMessageId: "" }) }).emit(modelAlert)).rejects.toThrow("capacity_alert_unavailable");
    expect(await state()).toEqual({ state: "sending", sent_at: null });
  });

  it("bounds a sender that never returns and leaves its lease recoverable", async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let ended = false;
    const denied = expect(sink({ sendMessage: async () => { entered(); return new Promise(() => undefined); } }).emit(modelAlert))
      .rejects.toThrow("capacity_alert_unavailable").then(() => { ended = true; });
    await started;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toBe(true); await denied;
    expect((await state())?.state).toBe("sending");
  });

  it("refuses a sent state without its acknowledgement time at the database boundary", async () => {
    await expect(sink({ sendMessage: async () => { throw new Error("uncertain"); } }).emit(modelAlert)).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE capacity_alert_crossings SET state = 'sent' WHERE owner_principal_id = ?")
      .bind(owner.principalId).run()).rejects.toThrow();
    expect(await state()).toEqual({ state: "sending", sent_at: null });
  });

  it("keeps alert keys bound to the resource and threshold", async () => {
    const sendMessage = vi.fn(async () => ({ providerMessageId: "123" }));
    const mismatched = { ...modelAlert, idempotencyKey: "capacity:provider:model:85" } as unknown as CapacityAlert;
    await expect(sink({ sendMessage }).emit(mismatched))
      .rejects.toThrow("capacity_alert_unavailable");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await state()).toBeNull();
  });

  it("reports storage usage as a capacity alert rather than a model migration", async () => {
    const sendMessage = vi.fn(async (_input: TelegramSendMessageInput) => ({ providerMessageId: "123" }));
    await sink({ sendMessage }).emit({ resource: "d1", threshold: 85, code: "capacity_85", idempotencyKey: "capacity:d1:85" });
    expect(sendMessage.mock.calls[0]![0].text).toContain("Review capacity");
    expect(sendMessage.mock.calls[0]![0].text).not.toContain("switch");
  });
});
