import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";
import { applyVoiceRuntimeMigration } from "../../../apps/cloud-gateway/test/persistence/migration.js";

it("backfills a retained terminal callback when 0015 is applied to an existing calling store", async () => {
  const system = await createFakeCallingSystem();
  try {
    await expect(system.dispatch()).resolves.toMatchObject({ status: "dispatched" });
    await expect(system.sendStatus(system.acceptedCallSid(), "completed", 0)).resolves.toMatchObject({ status: 204 });
    await applyVoiceRuntimeMigration();
    await expect(env.DB.prepare("SELECT provider_terminal_at FROM outbound_call_attempts WHERE attempt_id = ?")
      .bind(system.attemptId).first()).resolves.toEqual({ provider_terminal_at: "2026-08-30T12:00:00.000Z" });
    await expect(env.DB.prepare("SELECT enabled FROM outbound_runtime_controls").first()).resolves.toEqual({ enabled: 0 });
  } finally { await system.cleanup(); }
});
