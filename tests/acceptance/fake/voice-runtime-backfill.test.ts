import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createEnvelope, newUlid, sha256Hex } from "../../../packages/contracts/src/index.js";
import { EventRepository } from "../../../apps/cloud-gateway/src/persistence/event-repository.js";
import { Redactor } from "../../../apps/cloud-gateway/src/security/redaction.js";
import { createFakeCallingSystem } from "./voice-call-system.js";
import { applyVoiceRuntimeMigration } from "../../../apps/cloud-gateway/test/persistence/migration.js";

it("backfills a retained terminal callback when 0015 is applied to an existing calling store", async () => {
  const system = await createFakeCallingSystem();
  try {
    await expect(system.dispatch()).resolves.toMatchObject({ status: "dispatched" });
    await expect(system.sendStatus(system.acceptedCallSid(), "completed", 0)).resolves.toMatchObject({ status: 204 });

    // A damaged legacy store can contain a retained callback that did not pass
    // the current compatibility trigger. The 0015 backfill must still bind
    // terminal evidence to the attempt's accepted CallSid.
    const earlier = "2026-08-30T11:59:59.000Z";
    const audit = new Redactor().redactText("legacy mismatched callback");
    const callStatus = new Redactor().redactText("completed");
    if (!audit.ok || !callStatus.ok) throw new Error("fixture_redaction_failed");
    const eventId = newUlid();
    const envelope = await createEnvelope({ schemaVersion: "1.0", eventId, eventType: "provider.call_status",
      source: "twilio", subjectId: "principal:owner", occurredAt: earlier, receivedAt: earlier,
      correlationId: system.attemptId, contentType: "application/json", payload: { audit, callStatus }, producerVersion: "test" });
    const requestHash = await sha256Hex("legacy mismatched callback");
    await new EventRepository(env.DB).append({ scope: "test:legacy-callback", key: eventId, requestHash, envelope });
    const compatibilityTrigger = await env.DB.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'provider_events_status_require_compatible_attempt'`).first<string>("sql");
    if (compatibilityTrigger === null) throw new Error("fixture_trigger_missing");
    await env.DB.prepare("DROP TRIGGER provider_events_status_require_compatible_attempt").run();
    try {
      await env.DB.prepare(`INSERT INTO provider_events (dedupe_key, endpoint_kind, event_id, attempt_id, call_sid,
        callback_source, sequence_number, session_id, received_at)
        VALUES (?, 'status', ?, ?, ?, 'call-progress-events', 99, NULL, ?)`)
        .bind(requestHash, eventId, system.attemptId, `CA${"f".repeat(32)}`, earlier).run();
    } finally {
      await env.DB.prepare(compatibilityTrigger).run();
    }

    await applyVoiceRuntimeMigration();
    await expect(env.DB.prepare("SELECT provider_terminal_at FROM outbound_call_attempts WHERE attempt_id = ?")
      .bind(system.attemptId).first()).resolves.toEqual({ provider_terminal_at: "2026-08-30T12:00:00.000Z" });
    await expect(env.DB.prepare("SELECT enabled FROM outbound_runtime_controls").first()).resolves.toEqual({ enabled: 0 });
  } finally { await system.cleanup(); }
});
