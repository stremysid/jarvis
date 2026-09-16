import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, createEnvelope, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import worker from "../../src/index.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { appendEvents, markDelivered, resetArchiveFixture, setCreatedAt } from "./archive-fixture.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

async function hourly(iso = "2026-12-01T00:00:00.000Z") {
  const ctx = createExecutionContext();
  // Deliberately no network-source configuration: archival must still run.
  await worker.scheduled(createScheduledController({ cron: "0 * * * *", scheduledTime: Date.parse(iso) }),
    {
      ...env,
      GITHUB_TOKEN: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_REFRESH_TOKEN: undefined,
      OWNER_PRINCIPAL_ID: undefined,
      DEEPSEEK_API_KEY: undefined,
    }, ctx);
  await waitOnExecutionContext(ctx);
}

describe("hourly archival through the Worker entrypoint", () => {
  let reports: unknown[][];
  beforeEach(async () => {
    await applyMemoryDistillationMigration();
    await resetArchiveFixture();
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
    reports = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { reports.push(args); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("archives one bounded batch without GitHub and claims each hour only once", async () => {
    const events = await appendEvents(25);
    for (let sequence = 1; sequence <= 25; sequence += 1) {
      await setCreatedAt(sequence, "2026-09-01T00:00:00.000Z");
      await markDelivered(sequence);
    }
    await hourly();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(1);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(1);
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const reader = new TieredEventReader({ live: events, archive, state: new ArchiveRepository(env.DB) });
    expect(await reader.readRange(0, 25)).toHaveLength(25);
    await hourly();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(1);
    await hourly("2026-12-01T01:00:00.000Z");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(0);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduled_runs WHERE job = 'poll' AND finished_at IS NOT NULL AND failure IS NULL").first("n")).toBe(2);
  });

  it("leaves recent and undelivered events in D1", async () => {
    await appendEvents(2);
    await setCreatedAt(1, "2026-09-01T00:00:00.000Z");
    await setCreatedAt(2, "2026-11-30T00:00:00.000Z");
    await markDelivered(2);
    await hourly();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(2);
    // Old pending events can be copied, but only delivered events are purged.
    expect((await env.ARCHIVE.list()).objects).toHaveLength(1);
    expect(await env.DB.prepare("SELECT sealed_through FROM archive_state").first("sealed_through")).toBe(1);
  });

  it("isolates an upload failure without sealing, purging, or skipping later hourly work", async () => {
    await appendEvents(1);
    await setCreatedAt(1, "2026-09-01T00:00:00.000Z");
    await markDelivered(1);
    vi.spyOn(env.ARCHIVE, "put").mockRejectedValue(new Error("archive upload unavailable"));
    await hourly();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT sealed_through FROM archive_state").first("sealed_through")).toBe(0);
    expect(await env.DB.prepare("SELECT failure FROM scheduled_runs WHERE job = 'poll'").first("failure")).toBeNull();
    expect(reports).toContainEqual(["scheduled", expect.objectContaining({
      jobs: [expect.objectContaining({
        job: "poll",
        result: "ran",
        detail: expect.stringContaining(
          "archival failed (archive_operation_failed); Classroom not configured; Brightspace not configured; Memory distillation not configured; Memory history indexing not configured",
        ),
      })],
    })]);
  });

  it("uses a live memory clock even when the scheduled hour is already six minutes old", async () => {
    const principalId = `principal:production-memory:${newUlid()}`;
    const text = "My favourite subject is math.";
    const now = new Date();
    const timestamp = now.toISOString();
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 'production memory composition', ?, ?)`)
      .bind(principalId, timestamp, timestamp).run();
    const eventId = newUlid(now);
    const redacted = new Redactor().redactText(text);
    if (!redacted.ok) throw new Error("production_memory_composition_redaction_failed");
    const envelope = await createEnvelope({
      schemaVersion: "1.0",
      eventId,
      eventType: "conversation.user_committed",
      source: "conversation",
      subjectId: principalId,
      occurredAt: timestamp,
      receivedAt: timestamp,
      correlationId: newUlid(now),
      contentType: "application/json",
      payload: {
        schemaCode: 1,
        channelCode: 2,
        sensitivityCode: 1,
        historyEligible: true,
        text: redacted,
        directOwnerText: true,
      },
      producerVersion: "conversation-v1",
    });
    const appended = await new EventRepository(env.DB).append({
      envelope,
      scope: "production-memory-composition",
      key: eventId,
      requestHash: await sha256Hex(canonicalJson([eventId, text])),
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          proposals: [{
            text,
            sourceEventIds: [eventId],
            sourceExcerpts: [{ sourceEventId: eventId, excerpt: text }],
            confidence: 0.95,
            sensitivity: "normal",
          }],
        }) },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 100,
      },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({
      cron: "0 * * * *",
      scheduledTime: now.getTime() - 6 * 60_000,
    }), {
      ...env,
      OWNER_PRINCIPAL_ID: principalId,
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_MODEL: undefined,
      MEMORY_EXTRACTION_MODEL: "deepseek-flash",
      MEMORY_EXTRACTION_MONTHLY_CAP_USD: "5",
      TELEGRAM_BOT_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_REFRESH_TOKEN: undefined,
      BRIGHTSPACE_ICAL_URL: undefined,
    }, ctx);
    await waitOnExecutionContext(ctx);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_items item
      JOIN memory_item_state state ON state.principal_id = item.principal_id AND state.item_id = item.item_id
      WHERE item.principal_id = ? AND state.lifecycle_state = 'active'`).bind(principalId).first("count")).toBe(1);
    expect(await env.DB.prepare(`SELECT current_event_sequence FROM memory_cursors
      WHERE principal_id = ? AND cursor_name = 'distillation'`).bind(principalId)
      .first("current_event_sequence")).toBe(appended.eventSequence);
    expect(await env.DB.prepare(`SELECT current_event_sequence FROM memory_cursors
      WHERE principal_id = ? AND cursor_name = 'fts_history'`).bind(principalId)
      .first("current_event_sequence")).toBe(appended.eventSequence);
    expect(await env.DB.prepare(`SELECT settled_cost_micros FROM memory_runs
      WHERE principal_id = ? AND job = 'distillation'`).bind(principalId)
      .first<number>("settled_cost_micros")).toBeGreaterThan(0);
    expect(Date.parse(await env.DB.prepare(`SELECT started_at FROM memory_runs
      WHERE principal_id = ? AND job = 'distillation'`).bind(principalId)
      .first<string>("started_at") ?? "")).toBeGreaterThan(now.getTime() - 60_000);
    expect(reports).toContainEqual(["scheduled", expect.objectContaining({
      jobs: [expect.objectContaining({
        job: "poll",
        result: "ran",
        detail: expect.stringMatching(/Memory succeeded.*Memory history complete/u),
      })],
    })]);
  });

  it("treats empty extraction model settings as unset without throwing out of scheduled", async () => {
    const ctx = createExecutionContext();
    await expect(worker.scheduled(createScheduledController({
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
    }), {
      ...env,
      OWNER_PRINCIPAL_ID: `principal:empty-model:${newUlid()}`,
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_MODEL: "",
      MEMORY_EXTRACTION_MODEL: "",
      TELEGRAM_BOT_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
    }, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);

    expect(reports.some((entry) => entry[0] === "scheduled")).toBe(true);
  });

  it("wires the production owner notice sink used by cap and provider-credit warnings", async () => {
    const principalId = `principal:production-memory-credit:${newUlid()}`;
    const now = new Date();
    const timestamp = now.toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?, 'human', 'active', 'production memory credit', ?, ?)`)
        .bind(principalId, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at,
        created_at, enrolled_by_device_id
      ) VALUES (?, ?, 'telegram', '123456789', 'active', ?, ?, NULL)`)
        .bind(`identity:production-memory-credit:${newUlid()}`, principalId, timestamp, timestamp),
    ]);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) return new Response(null, { status: 402 });
      if (url.includes("api.telegram.org")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("production_memory_notice_unexpected_request");
    });
    vi.stubGlobal("fetch", fetcher);
    const events = new EventRepository(env.DB);
    const text = "I prefer tea.";
    const redacted = new Redactor().redactText(text);
    if (!redacted.ok) throw new Error("production_memory_notice_redaction_failed");
    const eventId = newUlid(now);
    const envelope = await createEnvelope({
      schemaVersion: "1.0",
      eventId,
      eventType: "conversation.user_committed",
      source: "conversation",
      subjectId: principalId,
      occurredAt: timestamp,
      receivedAt: timestamp,
      correlationId: newUlid(now),
      contentType: "application/json",
      payload: {
        schemaCode: 1, channelCode: 2, sensitivityCode: 1,
        historyEligible: true, text: redacted, directOwnerText: true,
      },
      producerVersion: "conversation-v1",
    });
    await events.append({
      envelope,
      scope: "production-memory-credit",
      key: eventId,
      requestHash: await sha256Hex(canonicalJson([eventId, text])),
    });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({
      cron: "0 * * * *",
      scheduledTime: now.getTime(),
    }), {
      ...env,
      OWNER_PRINCIPAL_ID: principalId,
      DEEPSEEK_API_KEY: "test-deepseek-key",
      MEMORY_EXTRACTION_MODEL: "deepseek-flash",
      MEMORY_EXTRACTION_MONTHLY_CAP_USD: "5",
      TELEGRAM_BOT_TOKEN: `123456:${"x".repeat(32)}`,
      GITHUB_TOKEN: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_REFRESH_TOKEN: undefined,
      BRIGHTSPACE_ICAL_URL: undefined,
    }, ctx);
    await waitOnExecutionContext(ctx);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const telegramCall = fetcher.mock.calls.find(([input]) => String(input).includes("api.telegram.org"));
    expect(telegramCall?.[1]?.body).toContain("provider credit");
    expect(await env.DB.prepare(`SELECT state FROM capacity_alert_crossings
      WHERE owner_principal_id = ? AND alert_key LIKE 'memory-extraction:provider-credit:%'`)
      .bind(principalId).first("state")).toBe("sent");
  });
});
