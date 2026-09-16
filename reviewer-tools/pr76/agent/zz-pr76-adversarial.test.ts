import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, createEnvelope, newUlid, sha256Hex, type Ulid } from "../../../packages/contracts/src/index.js";
import worker from "../src/index.js";
import { ArchivalService } from "../src/archive/archival-service.js";
import { ArchiveRepository } from "../src/archive/archive-repository.js";
import { TieredEventReader } from "../src/archive/tiered-event-reader.js";
import { AutomaticMemoryDistillationWorkflow } from "../src/memory/automatic-distillation.js";
import { MemoryExtractionBudget } from "../src/memory/memory-extraction-budget.js";
import { MemoryRepository } from "../src/memory/memory-repository.js";
import { EventRepository } from "../src/persistence/event-repository.js";
import { DeepSeekJsonProvider } from "../src/providers/deepseek-provider.js";
import { Redactor } from "../src/security/redaction.js";
import { applyMemoryDistillationMigration } from "./persistence/migration.js";

async function principal(label: string): Promise<string> {
  const principalId = `principal:pr76:${label}:${newUlid()}`;
  const timestamp = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'pr76 adversarial', ?, ?)`).bind(principalId, timestamp, timestamp).run();
  return principalId;
}

async function ownerText(principalId: string, text: string): Promise<{ eventId: Ulid; sequence: number }> {
  const now = new Date();
  const timestamp = now.toISOString();
  const eventId = newUlid(now);
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("fixture_redaction_failed");
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
      schemaCode: 1, channelCode: 2, sensitivityCode: 1, historyEligible: true, text: redacted, directOwnerText: true,
    },
    producerVersion: "conversation-v1",
  });
  const appended = await new EventRepository(env.DB).append({
    envelope, scope: "pr76-adversarial", key: eventId, requestHash: await sha256Hex(canonicalJson([eventId, text])),
  });
  return { eventId, sequence: appended.eventSequence };
}

function deepSeekBody(proposals: unknown[], finishReason = "stop"): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({ proposals }) } }],
    usage: { prompt_tokens: 200, completion_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 200 },
  }), { headers: { "content-type": "application/json" } });
}

function proposal(eventId: string, text: string, confidence: number) {
  return { text, sourceEventIds: [eventId], sourceExcerpts: [{ sourceEventId: eventId, excerpt: text }], confidence, sensitivity: "normal" };
}

async function hourly(principalId: string, scheduledTime: number): Promise<string> {
  const reports: unknown[][] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { reports.push(args); });
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "0 * * * *", scheduledTime }), {
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
  spy.mockRestore();
  return JSON.stringify(reports);
}

async function scalar(sql: string, ...binds: unknown[]): Promise<unknown> {
  return env.DB.prepare(sql).bind(...binds).first("v");
}

describe("PR #76 adversarial", () => {
  beforeAll(applyMemoryDistillationMigration);
  beforeEach(async () => { await env.DB.prepare("DELETE FROM scheduled_runs").run(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("F1a: frozen scheduled clock -- distillation reached 6 minutes after the cron fired is refused by D1", async () => {
    const principalId = await principal("late");
    const { eventId } = await ownerText(principalId, "My favourite subject is math.");
    const fetcher = vi.fn<typeof fetch>(async () => deepSeekBody([proposal(eventId, "My favourite subject is math.", 0.95)]));
    vi.stubGlobal("fetch", fetcher);

    const report = await hourly(principalId, Date.now() - 6 * 60_000);
    console.info("F1a report", report);

    expect(fetcher).not.toHaveBeenCalled();
    expect(report).toContain("Memory distillation failed");
    expect(await scalar("SELECT count(*) AS v FROM memory_items WHERE principal_id = ?", principalId)).toBe(0);
  });

  it("F1b: a DeepSeek call that straddles the 5-minute mark is paid for, then its settlement and memory are thrown away", async () => {
    const principalId = await principal("straddle");
    const { eventId } = await ownerText(principalId, "My favourite subject is math.");
    const fetcher = vi.fn<typeof fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return deepSeekBody([proposal(eventId, "My favourite subject is math.", 0.95)]);
    });
    vi.stubGlobal("fetch", fetcher);

    const report = await hourly(principalId, Date.now() - 288_000);
    console.info("F1b report", report);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(await scalar(`SELECT count(*) AS v FROM memory_cost_ledger WHERE principal_id = ? AND entry_type = 'reservation'`, principalId)).toBe(1);
    expect(await scalar(`SELECT count(*) AS v FROM memory_cost_ledger WHERE principal_id = ? AND entry_type = 'settlement'`, principalId)).toBe(0);
    expect(await scalar(`SELECT failure_code AS v FROM memory_runs WHERE principal_id = ? AND job = 'distillation'`, principalId))
      .toBe("memory_extraction_settlement_failed");
    expect(await scalar("SELECT count(*) AS v FROM memory_items WHERE principal_id = ?", principalId)).toBe(0);
  }, 90_000);

  it("F2: continuation with run-to-run wording drift pays twice, duplicates memories and never advances the cursor", async () => {
    const principalId = await principal("continuation");
    const texts = ["I play piano.", "My school is Westdale.", "I have a dog.", "My favourite subject is math.", "I am applying to Waterloo."];
    const events: { eventId: Ulid; sequence: number }[] = [];
    for (const text of texts) events.push(await ownerText(principalId, text));
    let call = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      call += 1;
      return deepSeekBody(events.map((event, index) => proposal(event.eventId, texts[index]!, 0.96 - call / 100)));
    });
    vi.stubGlobal("fetch", fetcher);

    const report = await hourly(principalId, Date.now());
    console.info("F2 report", report);

    const cursor = await scalar(`SELECT current_event_sequence AS v FROM memory_cursors WHERE principal_id = ? AND cursor_name = 'distillation'`, principalId);
    const items = await env.DB.prepare(`SELECT version.text AS text, count(*) AS n FROM memory_items item
      JOIN memory_item_state state ON state.principal_id = item.principal_id AND state.item_id = item.item_id
      JOIN memory_item_versions version ON version.principal_id = state.principal_id AND version.version_id = state.current_version_id
      WHERE item.principal_id = ? GROUP BY version.text ORDER BY version.text`).bind(principalId).all();
    const settlements = await scalar(`SELECT count(*) AS v FROM memory_cost_ledger WHERE principal_id = ? AND entry_type = 'settlement'`, principalId);
    console.info("F2 state", JSON.stringify({ calls: fetcher.mock.calls.length, cursor, items: items.results, settlements }));

    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(settlements).toBe(fetcher.mock.calls.length);
    expect(cursor ?? 0).toBeLessThan(events.at(-1)!.sequence);
    expect(items.results.some((row) => (row as { n: number }).n >= 2)).toBe(true);
    expect(items.results.some((row) => (row as { text: string }).text === "I am applying to Waterloo.")).toBe(false);
  }, 90_000);

  it("F3: one proposal whose excerpt normalises a curly apostrophe fails the whole batch, is paid for, and repeats every hour", async () => {
    const principalId = await principal("poison");
    const poison = await ownerText(principalId, "I’m in grade 12.");
    const later = await ownerText(principalId, "My favourite subject is math.");
    const fetcher = vi.fn<typeof fetch>(async () => deepSeekBody([
      proposal(poison.eventId, "I'm in grade 12.", 0.95),
      proposal(later.eventId, "My favourite subject is math.", 0.95),
    ]));
    const clock = () => new Date();
    const budget = new MemoryExtractionBudget({ database: env.DB, modelId: "deepseek-flash", monthlyCapUsd: "5", now: clock });
    const prepared = await budget.prepare(principalId);
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const workflow = new AutomaticMemoryDistillationWorkflow({
      database: env.DB,
      events: new TieredEventReader({ live: new EventRepository(env.DB), archive, state: new ArchiveRepository(env.DB) }),
      repository: new MemoryRepository(env.DB, { clock, archivedEventReader: archive }),
      provider: new DeepSeekJsonProvider({ apiKey: "k", model: "deepseek-flash", budget, fetchImplementation: fetcher }),
      providerModelId: budget.providerModelId,
      priceId: prepared.priceId,
      principalId,
      now: clock,
    });

    const hour1 = await workflow.runNext({ runKey: `memory-distill:hour-1:0` });
    const hour2 = await workflow.runNext({ runKey: `memory-distill:hour-2:0` });
    const hour3 = await workflow.runNext({ runKey: `memory-distill:hour-3:0` });
    const settled = await scalar(`SELECT sum(amount_micros) AS v FROM memory_cost_ledger WHERE principal_id = ? AND entry_type = 'settlement'`, principalId);
    const runCost = await scalar(`SELECT sum(settled_cost_micros) AS v FROM memory_runs WHERE principal_id = ? AND job = 'distillation'`, principalId);
    console.info("F3 state", JSON.stringify({ outcomes: [hour1, hour2, hour3].map((r) => [r.outcome, r.failureCode, r.cursorEventSequence]), settled, runCost }));

    expect([hour1, hour2, hour3].map((r) => r.failureCode)).toEqual([
      "distillation_provider_output_invalid", "distillation_provider_output_invalid", "distillation_provider_output_invalid",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(hour3.cursorEventSequence).toBeLessThan(later.sequence);
    expect(await scalar("SELECT count(*) AS v FROM memory_items WHERE principal_id = ?", principalId)).toBe(0);
    expect(settled).toBeGreaterThan(0);
  }, 90_000);

  it("F4: a provider failure after settlement records zero cost on the run receipt", async () => {
    const principalId = await principal("receipt");
    const { eventId } = await ownerText(principalId, "My favourite subject is math.");
    const fetcher = vi.fn<typeof fetch>(async () => deepSeekBody([proposal(eventId, "My favourite subject is math.", 0.95)], "length"));
    vi.stubGlobal("fetch", fetcher);

    const report = await hourly(principalId, Date.now());
    const ledger = await scalar(`SELECT sum(amount_micros) AS v FROM memory_cost_ledger WHERE principal_id = ? AND entry_type = 'settlement'`, principalId);
    const run = await env.DB.prepare(`SELECT outcome, failure_code, settled_cost_micros, reserved_cost_micros FROM memory_runs
      WHERE principal_id = ? AND job = 'distillation'`).bind(principalId).first();
    console.info("F4 state", JSON.stringify({ report, ledger, run }));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(ledger).toBeGreaterThan(0);
    expect(run).toMatchObject({ settled_cost_micros: 0, reserved_cost_micros: 0 });
  }, 60_000);
});

import { LiteralHistoryService } from "../src/memory/literal-history.js";

describe("PR #76 literal history throughput", () => {
  beforeAll(applyMemoryDistillationMigration);
  it("F5: measures real D1 statements for a 2-event and an 8-event index step", async () => {
    const principalId = await principal("history");
    for (let index = 0; index < 20; index += 1) await ownerText(principalId, `History throughput message ${index} about calculus.`);
    let count = 0;
    const originals = new WeakMap<object, D1PreparedStatement>();
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const wrapped = {
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        first: async <T>(column?: string) => { count += 1; return column === undefined ? statement.first<T>() : statement.first<T>(column); },
        run: async <T>() => { count += 1; return statement.run<T>(); },
        all: async <T>() => { count += 1; return statement.all<T>(); },
        raw: async () => { count += 1; return statement.raw(); },
      } as D1PreparedStatement;
      originals.set(wrapped as object, statement);
      return wrapped;
    };
    const database = {
      prepare: (query: string) => wrap(env.DB.prepare(query)),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        count += statements.length;
        return env.DB.batch<T>(statements.map((statement) => originals.get(statement as object) ?? statement));
      },
    } as D1Database;
    const archive = new ArchivalService({ database, bucket: env.ARCHIVE });
    const history = new LiteralHistoryService({
      database,
      events: new TieredEventReader({ live: new EventRepository(database), archive, state: new ArchiveRepository(database) }),
      archive: new ArchiveRepository(database),
      now: () => new Date(),
      nextId: () => newUlid(),
    });
    const measured: unknown[] = [];
    for (const [maxEvents, maxTextBytes] of [[2, 65_536], [2, 65_536], [8, 262_144], [8, 262_144]] as const) {
      count = 0;
      const result = await history.indexNext({ principalId, maxEvents, maxTextBytes });
      measured.push({ maxEvents, examined: result.eventsExamined, chunks: result.chunksWritten, statements: count });
    }
    console.info("F5 measured", JSON.stringify(measured));
    expect(measured.length).toBe(4);
  }, 60_000);
});

describe("PR #76 ledger growth", () => {
  beforeAll(applyMemoryDistillationMigration);
  it("F6: reserve and 80% spend queries scale with the whole ledger", async () => {
    const principalId = await principal("ledger");
    const now = new Date();
    const budget = new MemoryExtractionBudget({ database: env.DB, modelId: "deepseek-flash", monthlyCapUsd: "999999", now: () => new Date() });
    const prepared = await budget.prepare(principalId);
    const runId = newUlid(now);
    await env.DB.prepare(`INSERT INTO memory_runs (run_id, principal_id, run_key, job, provider_model_id, price_id, outcome, started_at)
      VALUES (?, ?, ?, 'distillation', ?, ?, 'running', ?)`).bind(runId, principalId, `ledger:${runId}`, prepared.providerModelId, prepared.priceId, now.toISOString()).run();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT sum(CASE
          WHEN EXISTS (SELECT 1 FROM memory_cost_ledger release WHERE release.principal_id = reservation.principal_id
            AND release.reservation_entry_id = reservation.cost_entry_id AND release.entry_type = 'release') THEN 0
          ELSE reservation.amount_micros END)
        FROM memory_cost_ledger reservation
        WHERE reservation.principal_id = ?1 AND reservation.budget_class = 'normal_monthly'
          AND reservation.entry_type = 'reservation' AND reservation.occurred_at >= ?2 AND reservation.occurred_at < ?3`)
      .bind(principalId, "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z").all().catch((error: unknown) => ({ results: [String(error)] }));
    const timings: unknown[] = [{ plan: plan.results }];
    let total = 0;
    for (const target of [100, 200]) {
      while (total < target) {
        const reservation = await budget.reserve({ principalId, runId, priceId: prepared.priceId, requestBytes: 1, maxOutputTokens: 1 });
        await budget.settle(reservation, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 });
        total += 1;
      }
      const samples: number[] = [];
      for (let sample = 0; sample < 3; sample += 1) {
        const started = performance.now();
        const reservation = await budget.reserve({ principalId, runId, priceId: prepared.priceId, requestBytes: 1, maxOutputTokens: 1 });
        samples.push(Math.round(performance.now() - started));
        await budget.settle(reservation, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 });
        total += 1;
      }
      const spend = await env.DB.prepare(`SELECT COALESCE(sum(CASE
          WHEN EXISTS (SELECT 1 FROM memory_cost_ledger release WHERE release.principal_id = reservation.principal_id
            AND release.reservation_entry_id = reservation.cost_entry_id AND release.entry_type = 'release') THEN 0
          WHEN EXISTS (SELECT 1 FROM memory_cost_ledger settlement WHERE settlement.principal_id = reservation.principal_id
            AND settlement.reservation_entry_id = reservation.cost_entry_id AND settlement.entry_type = 'settlement') THEN (
            SELECT settlement.amount_micros FROM memory_cost_ledger settlement WHERE settlement.principal_id = reservation.principal_id
              AND settlement.reservation_entry_id = reservation.cost_entry_id AND settlement.entry_type = 'settlement'
          ) + COALESCE((SELECT overrun.amount_micros FROM memory_cost_ledger overrun WHERE overrun.principal_id = reservation.principal_id
              AND overrun.reservation_entry_id = reservation.cost_entry_id AND overrun.entry_type = 'overrun'), 0)
          ELSE reservation.amount_micros END), 0) AS amount
        FROM memory_cost_ledger reservation
        WHERE reservation.principal_id = ? AND reservation.budget_class = 'normal_monthly'
          AND reservation.entry_type = 'reservation' AND reservation.occurred_at >= ? AND reservation.occurred_at < ?`)
        .bind(principalId, "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z").all();
      timings.push({ ledgerRows: total * 2, reserveMs: samples, monthSpendRowsRead: spend.meta.rows_read });
    }
    console.info("F6 timings", JSON.stringify(timings));
    expect(total).toBeGreaterThan(0);
  }, 300_000);
});

describe("PR #76 composition blast radius", () => {
  beforeAll(applyMemoryDistillationMigration);
  it("F7: an empty MEMORY_EXTRACTION_MODEL makes every cron invocation throw, including the 5-minute drain", async () => {
    const principalId = await principal("empty-model");
    const logs: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args); });
    const ctx = createExecutionContext();
    let thrown: unknown = null;
    try {
      await worker.scheduled(createScheduledController({ cron: "*/5 * * * *", scheduledTime: Date.now() }), {
        ...env,
        OWNER_PRINCIPAL_ID: principalId,
        DEEPSEEK_API_KEY: "test-deepseek-key",
        MEMORY_EXTRACTION_MODEL: "",
        TELEGRAM_BOT_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      }, ctx);
      await waitOnExecutionContext(ctx);
    } catch (error) {
      thrown = error;
    }
    console.info("F7", String(thrown), JSON.stringify(logs));
    expect(String(thrown)).toContain("deepseek_json_configuration_invalid");
    expect(logs.some((entry) => entry[0] === "scheduled")).toBe(false);
  });
});
