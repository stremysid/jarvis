import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { appendEvents, markDelivered, resetArchiveFixture, setCreatedAt } from "./archive-fixture.js";

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
    }, ctx);
  await waitOnExecutionContext(ctx);
}

describe("hourly archival through the Worker entrypoint", () => {
  let reports: unknown[][];
  beforeEach(async () => {
    await resetArchiveFixture();
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
    reports = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { reports.push(args); });
  });
  afterEach(() => vi.restoreAllMocks());

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
          "archival failed (archive_operation_failed); Memory distillation not configured; Classroom not configured; Brightspace not configured",
        ),
      })],
    })]);
  });
});
