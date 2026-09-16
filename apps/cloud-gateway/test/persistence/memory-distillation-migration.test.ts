import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type PersistableEventEnvelopeV1,
  type RedactedJsonValue,
} from "../../../../packages/contracts/src/index.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { AutomaticMemoryDistillationWorkflow } from "../../src/memory/automatic-distillation.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { EventRepository, type AppendedEvent } from "../../src/persistence/event-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { Redactor } from "../../src/security/redaction.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import { applyMemoryDistillationMigration } from "./migration.js";

const MODEL_ID = "openai:fake-memory-distillation-v1";
const redactor = new Redactor();
let serial = 0;

function redacted(value: unknown): RedactedJsonValue {
  if (typeof value === "string") {
    const result = redactor.redactText(value);
    if (!result.ok || result.text !== value) throw new Error("memory_distillation_migration_fixture_redaction_failed");
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redacted);
  if (typeof value !== "object") throw new Error("memory_distillation_migration_fixture_invalid");
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redacted(child)]));
}

async function seedPrincipal(): Promise<string> {
  serial += 1;
  const principalId = `principal:distillation-migration:${serial}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'distillation migration test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

async function appendOwnerEvent(principalId: string): Promise<AppendedEvent> {
  const events = new EventRepository(env.DB);
  const eventId = newUlid();
  const now = new Date().toISOString();
  const text = "I prefer tea.";
  const envelope: PersistableEventEnvelopeV1 = await createEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: principalId,
    occurredAt: now,
    receivedAt: now,
    correlationId: newUlid(),
    contentType: "application/json",
    payload: redacted({
      schemaCode: 1,
      channelCode: 2,
      sensitivityCode: 1,
      historyEligible: true,
      text,
    }),
    producerVersion: "conversation-v1",
  });
  return events.append({
    envelope,
    scope: "memory-distillation-migration-test",
    key: eventId,
    requestHash: await sha256Hex(canonicalJson([eventId, text])),
  });
}

async function completedRun(itemCount = 1): Promise<{
  principalId: string;
  runId: string;
}> {
  const principalId = await seedPrincipal();
  const event = await appendOwnerEvent(principalId);
  const text = "I prefer tea.";
  const provider = new FakeModelProvider({
    completeJson: Array.from({ length: itemCount }, (_, index) => ({
      text: index === 0 ? text : `The owner recorded tea preference ${index}.`,
      sourceEventIds: [event.envelope.eventId],
      sourceExcerpts: [{ sourceEventId: event.envelope.eventId, excerpt: text }],
      confidence: 0.95,
      sensitivity: "normal",
    })),
  });
  const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
  const result = await new AutomaticMemoryDistillationWorkflow({
    database: env.DB,
    events: new TieredEventReader({
      live: new EventRepository(env.DB),
      archive,
      state: new ArchiveRepository(env.DB),
    }),
    repository: new MemoryRepository(env.DB, { archivedEventReader: archive }),
    provider,
    providerModelId: MODEL_ID,
    principalId,
    now: () => new Date(),
  }).runNext({ runKey: `migration:${newUlid()}` });
  if (result.outcome !== "succeeded") throw new Error("memory_distillation_migration_fixture_run_failed");
  return { principalId, runId: result.runId };
}

async function runningRun(
  principalId: string,
  startEventSequence = 1,
  endEventSequence = startEventSequence,
  startedAt = new Date(),
): Promise<string> {
  const runId = newUlid();
  await env.DB.prepare(`INSERT INTO memory_runs (
    run_id, principal_id, run_key, job, reprocess_job_id, start_event_sequence,
    end_event_sequence, provider_model_id, price_id, outcome, started_at
  ) VALUES (?, ?, ?, 'distillation', NULL, ?, ?, ?, NULL, 'running', ?)`)
    .bind(
      runId,
      principalId,
      `direct:${newUlid()}`,
      startEventSequence,
      endEventSequence,
      MODEL_ID,
      startedAt.toISOString(),
    ).run();
  return runId;
}

beforeAll(async () => {
  await applyMemoryDistillationMigration();
});

beforeEach(async () => {
  await resetArchiveFixture();
});

describe("0026 memory distillation migration", () => {
  it("memory_distillation_event_receipts_insert_guard rejects OR IGNORE and OR REPLACE replays", async () => {
    const principalId = await seedPrincipal();
    const first = await appendOwnerEvent(principalId);
    const second = await appendOwnerEvent(principalId);
    const runId = await runningRun(principalId, first.eventSequence, second.eventSequence);
    const recordedAt = new Date(Date.now() + 1).toISOString();
    const receiptId = newUlid();
    await env.DB.prepare(`INSERT INTO memory_distillation_event_receipts (
      receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
      disposition, source_location, r2_segment_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'eligible', 'live', NULL, ?)`)
      .bind(
        receiptId,
        principalId,
        runId,
        first.eventSequence,
        first.envelope.eventId,
        first.envelope.contentHash,
        recordedAt,
      ).run();
    for (const conflict of ["OR IGNORE", "OR REPLACE"] as const) {
      await expect(env.DB.prepare(`INSERT ${conflict} INTO memory_distillation_event_receipts (
        receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
        disposition, source_location, r2_segment_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'eligible', 'live', NULL, ?)`)
        .bind(
          receiptId,
          principalId,
          runId,
          second.eventSequence,
          second.envelope.eventId,
          second.envelope.contentHash,
          recordedAt,
        ).run())
        .rejects.toThrow("memory_distillation_event_receipt_invalid");
      await expect(env.DB.prepare(`INSERT ${conflict} INTO memory_distillation_event_receipts (
        receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
        disposition, source_location, r2_segment_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'eligible', 'live', NULL, ?)`)
        .bind(
          newUlid(),
          principalId,
          runId,
          first.eventSequence,
          first.envelope.eventId,
          first.envelope.contentHash,
          recordedAt,
        ).run())
        .rejects.toThrow("memory_distillation_event_receipt_invalid");
    }
  });

  it("memory_distillation_event_receipts_immutable_update rejects a changed receipt", async () => {
    const fixture = await completedRun();
    await expect(env.DB.prepare(`UPDATE memory_distillation_event_receipts
      SET disposition = 'skipped' WHERE principal_id = ? AND run_id = ?`)
      .bind(fixture.principalId, fixture.runId).run())
      .rejects.toThrow("memory_distillation_event_receipt_immutable");
  });

  it("memory_distillation_event_receipts_delete_forbidden rejects receipt deletion", async () => {
    const fixture = await completedRun();
    await expect(env.DB.prepare(`DELETE FROM memory_distillation_event_receipts
      WHERE principal_id = ? AND run_id = ?`).bind(fixture.principalId, fixture.runId).run())
      .rejects.toThrow("memory_distillation_event_receipt_delete_forbidden");
  });

  it("memory_distillation_item_receipts_insert_guard rejects OR IGNORE and OR REPLACE replays", async () => {
    const fixture = await completedRun(2);
    const event = await env.DB.prepare(`SELECT event_sequence, event_id, content_hash
      FROM memory_distillation_event_receipts WHERE principal_id = ? AND run_id = ?`)
      .bind(fixture.principalId, fixture.runId)
      .first<{ event_sequence: number; event_id: string; content_hash: string }>();
    const items = await env.DB.prepare(`SELECT item_id, proposal_hash
      FROM memory_distillation_item_receipts WHERE principal_id = ? AND run_id = ?
      ORDER BY item_id ASC`)
      .bind(fixture.principalId, fixture.runId)
      .all<{ item_id: string; proposal_hash: string }>();
    const first = items.results[0];
    const second = items.results[1];
    if (event === null || first === undefined || second === undefined) {
      throw new Error("memory_distillation_unique_fixture_missing");
    }
    const runId = await runningRun(fixture.principalId, event.event_sequence);
    const recordedAt = new Date(Date.now() + 1).toISOString();
    await env.DB.prepare(`INSERT INTO memory_distillation_event_receipts (
      receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
      disposition, source_location, r2_segment_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'eligible', 'live', NULL, ?)`)
      .bind(
        newUlid(),
        fixture.principalId,
        runId,
        event.event_sequence,
        event.event_id,
        event.content_hash,
        recordedAt,
      ).run();
    const receiptId = newUlid();
    await env.DB.prepare(`INSERT INTO memory_distillation_item_receipts (
      receipt_id, principal_id, run_id, item_id, proposal_hash, created_in_run, recorded_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
      .bind(receiptId, fixture.principalId, runId, first.item_id, first.proposal_hash, recordedAt).run();
    for (const conflict of ["OR IGNORE", "OR REPLACE"] as const) {
      await expect(env.DB.prepare(`INSERT ${conflict} INTO memory_distillation_item_receipts (
        receipt_id, principal_id, run_id, item_id, proposal_hash, created_in_run, recorded_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
        .bind(receiptId, fixture.principalId, runId, second.item_id, second.proposal_hash, recordedAt).run())
        .rejects.toThrow("memory_distillation_item_receipt_invalid");
      await expect(env.DB.prepare(`INSERT ${conflict} INTO memory_distillation_item_receipts (
        receipt_id, principal_id, run_id, item_id, proposal_hash, created_in_run, recorded_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
        .bind(newUlid(), fixture.principalId, runId, first.item_id, second.proposal_hash, recordedAt).run())
        .rejects.toThrow("memory_distillation_item_receipt_invalid");
      await expect(env.DB.prepare(`INSERT ${conflict} INTO memory_distillation_item_receipts (
        receipt_id, principal_id, run_id, item_id, proposal_hash, created_in_run, recorded_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
        .bind(newUlid(), fixture.principalId, runId, second.item_id, first.proposal_hash, recordedAt).run())
        .rejects.toThrow("memory_distillation_item_receipt_invalid");
    }
  });

  it("memory_distillation_item_receipts_insert_guard rejects an undercounted item created after its run began", async () => {
    const principalId = await seedPrincipal();
    const event = await appendOwnerEvent(principalId);
    const olderRunId = await runningRun(
      principalId,
      event.eventSequence,
      event.eventSequence,
      new Date(Date.now() - 1_000),
    );
    const text = "I prefer tea.";
    const provider = new FakeModelProvider({
      completeJson: [{
        text,
        sourceEventIds: [event.envelope.eventId],
        sourceExcerpts: [{ sourceEventId: event.envelope.eventId, excerpt: text }],
        confidence: 0.95,
        sensitivity: "normal",
      }],
    });
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const completed = await new AutomaticMemoryDistillationWorkflow({
      database: env.DB,
      events: new TieredEventReader({
        live: new EventRepository(env.DB),
        archive,
        state: new ArchiveRepository(env.DB),
      }),
      repository: new MemoryRepository(env.DB, { archivedEventReader: archive }),
      provider,
      providerModelId: MODEL_ID,
      principalId,
      now: () => new Date(),
    }).runNext({ runKey: `created-count:${newUlid()}` });
    const item = await env.DB.prepare(`SELECT item_id, proposal_hash
      FROM memory_distillation_item_receipts WHERE principal_id = ? AND run_id = ?`)
      .bind(principalId, completed.runId)
      .first<{ item_id: string; proposal_hash: string }>();
    if (item === null) throw new Error("memory_distillation_created_count_fixture_missing");
    const recordedAt = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO memory_distillation_event_receipts (
      receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
      disposition, source_location, r2_segment_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'eligible', 'live', NULL, ?)`)
      .bind(
        newUlid(),
        principalId,
        olderRunId,
        event.eventSequence,
        event.envelope.eventId,
        event.envelope.contentHash,
        recordedAt,
      ).run();

    await expect(env.DB.prepare(`INSERT INTO memory_distillation_item_receipts (
      receipt_id, principal_id, run_id, item_id, proposal_hash, created_in_run, recorded_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
      .bind(newUlid(), principalId, olderRunId, item.item_id, item.proposal_hash, recordedAt).run())
      .rejects.toThrow("memory_distillation_item_receipt_invalid");
  });

  it("memory_distillation_item_receipts_immutable_update rejects a changed receipt", async () => {
    const fixture = await completedRun();
    await expect(env.DB.prepare(`UPDATE memory_distillation_item_receipts
      SET created_in_run = 0 WHERE principal_id = ? AND run_id = ?`)
      .bind(fixture.principalId, fixture.runId).run())
      .rejects.toThrow("memory_distillation_item_receipt_immutable");
  });

  it("memory_distillation_item_receipts_delete_forbidden rejects receipt deletion", async () => {
    const fixture = await completedRun();
    await expect(env.DB.prepare(`DELETE FROM memory_distillation_item_receipts
      WHERE principal_id = ? AND run_id = ?`).bind(fixture.principalId, fixture.runId).run())
      .rejects.toThrow("memory_distillation_item_receipt_delete_forbidden");
  });

  it("memory_distillation_runs_reconcile_guard rejects a terminal count without receipt rows", async () => {
    const principalId = await seedPrincipal();
    await appendOwnerEvent(principalId);
    const runId = await runningRun(principalId);
    const completedAt = new Date(Date.now() + 1).toISOString();

    await expect(env.DB.prepare(`UPDATE memory_runs SET input_event_count = 1,
      outcome = 'nothing_new', completed_at = ? WHERE principal_id = ? AND run_id = ?`)
      .bind(completedAt, principalId, runId).run())
      .rejects.toThrow("memory_distillation_run_counts_invalid");
  });

  it("memory_distillation_runs_reconcile_guard rejects an input count not justified by event receipts", async () => {
    const principalId = await seedPrincipal();
    const event = await appendOwnerEvent(principalId);
    const runId = await runningRun(principalId, event.eventSequence);
    const completedAt = new Date(Date.now() + 1).toISOString();
    await env.DB.prepare(`INSERT INTO memory_distillation_event_receipts (
      receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
      disposition, source_location, r2_segment_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'eligible', 'live', NULL, ?)`)
      .bind(
        newUlid(),
        principalId,
        runId,
        event.eventSequence,
        event.envelope.eventId,
        event.envelope.contentHash,
        completedAt,
      ).run();

    await expect(env.DB.prepare(`UPDATE memory_runs SET input_event_count = 0,
      outcome = 'failed', completed_at = ?, failure_code = 'fixture_failure'
      WHERE principal_id = ? AND run_id = ?`)
      .bind(completedAt, principalId, runId).run())
      .rejects.toThrow("memory_distillation_run_counts_invalid");
  });

  it("memory_distillation_runs_reconcile_guard rejects a created count not justified by item receipts", async () => {
    const principalId = await seedPrincipal();
    const event = await appendOwnerEvent(principalId);
    const runId = await runningRun(principalId, event.eventSequence);
    const completedAt = new Date(Date.now() + 1).toISOString();
    await env.DB.prepare(`INSERT INTO memory_distillation_event_receipts (
      receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
      disposition, source_location, r2_segment_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'eligible', 'live', NULL, ?)`)
      .bind(
        newUlid(),
        principalId,
        runId,
        event.eventSequence,
        event.envelope.eventId,
        event.envelope.contentHash,
        completedAt,
      ).run();

    await expect(env.DB.prepare(`UPDATE memory_runs SET input_event_count = 1,
      created_item_count = 1, outcome = 'failed', completed_at = ?, failure_code = 'fixture_failure'
      WHERE principal_id = ? AND run_id = ?`)
      .bind(completedAt, principalId, runId).run())
      .rejects.toThrow("memory_distillation_run_counts_invalid");
  });

  it("memory_distillation_cursor_insert_guard rejects progress without a reconciled item batch", async () => {
    const principalId = await seedPrincipal();
    await expect(env.DB.prepare(`INSERT INTO memory_cursors (
      principal_id, cursor_name, current_event_sequence, updated_at
    ) VALUES (?, 'distillation', 1, ?)`)
      .bind(principalId, new Date().toISOString()).run())
      .rejects.toThrow("memory_distillation_cursor_advance_invalid");
  });

  it("memory_distillation_cursor_update_guard rejects progress without a reconciled item batch", async () => {
    const principalId = await seedPrincipal();
    const startedAt = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO memory_cursors (
      principal_id, cursor_name, current_event_sequence, updated_at
    ) VALUES (?, 'distillation', 0, ?)`)
      .bind(principalId, startedAt).run();

    await expect(env.DB.prepare(`UPDATE memory_cursors SET current_event_sequence = 1,
      updated_at = ? WHERE principal_id = ? AND cursor_name = 'distillation'`)
      .bind(new Date(Date.now() + 1).toISOString(), principalId).run())
      .rejects.toThrow("memory_distillation_cursor_advance_invalid");
  });

  it("reconciles the exposed run counts to immutable receipts before allowing cursor progress", async () => {
    const fixture = await completedRun();
    const run = await env.DB.prepare(`SELECT input_event_count, created_item_count, outcome
      FROM memory_runs WHERE principal_id = ? AND run_id = ?`)
      .bind(fixture.principalId, fixture.runId)
      .first<{ input_event_count: number; created_item_count: number; outcome: string }>();
    const eventCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM memory_distillation_event_receipts WHERE principal_id = ? AND run_id = ?`)
      .bind(fixture.principalId, fixture.runId).first<number>("count");
    const itemCount = await env.DB.prepare(`SELECT COALESCE(sum(created_in_run), 0) AS count
      FROM memory_distillation_item_receipts WHERE principal_id = ? AND run_id = ?`)
      .bind(fixture.principalId, fixture.runId).first<number>("count");
    const cursor = await env.DB.prepare(`SELECT current_event_sequence FROM memory_cursors
      WHERE principal_id = ? AND cursor_name = 'distillation'`)
      .bind(fixture.principalId).first<number>("current_event_sequence");

    expect(run).toEqual({ input_event_count: eventCount, created_item_count: itemCount, outcome: "succeeded" });
    expect(cursor).toBe(1);
  });
});
