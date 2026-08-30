import { env } from "cloudflare:test";
import { canonicalJson, createEnvelope, newUlid, sha256Hex, type PersistableEventEnvelopeV1 } from "../../../../packages/contracts/src/index.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { applyFoundationMigration, clearOutboundCallAttemptsForTest } from "../persistence/migration.js";

const eventTimestamp = "2026-08-29T12:00:00.000Z";

export async function resetArchiveFixture(): Promise<void> {
  await applyFoundationMigration();
  const triggers = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'archive_%' OR name = 'events_reject_archived_event_id') ORDER BY name",
  ).all<{ name: string; sql: string }>();
  for (const trigger of triggers.results) await env.DB.exec(`DROP TRIGGER ${trigger.name}`);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM archive_purge_receipts"),
    env.DB.prepare("DELETE FROM archive_segment_events"),
    env.DB.prepare("DELETE FROM archive_segments"),
    env.DB.prepare("DELETE FROM archive_manifests"),
    env.DB.prepare("UPDATE archive_state SET sealed_through = 0, circuit_state = 'closed', circuit_reason = NULL, circuit_opened_at = NULL, updated_at = '1970-01-01T00:00:00.000Z' WHERE singleton = 1"),
    env.DB.prepare("DELETE FROM provider_events"),
  ]);
  await clearOutboundCallAttemptsForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
  ]);
  for (const trigger of triggers.results) await env.DB.prepare(trigger.sql).run();

  let cursor: string | undefined;
  do {
    const listed = await env.ARCHIVE.list({ prefix: "events/sha256/", cursor });
    if (listed.objects.length > 0) await env.ARCHIVE.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

export async function appendEvents(count: number): Promise<EventRepository> {
  const repository = new EventRepository(env.DB);
  for (let index = 1; index <= count; index += 1) {
    const payload = { attempt: index, accepted: true };
    const envelope: PersistableEventEnvelopeV1 = await createEnvelope({
      schemaVersion: "1.0",
      eventId: newUlid(),
      eventType: "telegram.update",
      source: "telegram",
      subjectId: "principal:test",
      occurredAt: eventTimestamp,
      receivedAt: eventTimestamp,
      correlationId: newUlid(),
      contentType: "application/json",
      payload,
      producerVersion: "test",
    });
    await repository.append({
      envelope,
      scope: "telegram:update",
      key: `fixture:${index}`,
      requestHash: await sha256Hex(canonicalJson({ index })),
    });
  }
  return repository;
}

export async function setCreatedAt(sequence: number, createdAt: string): Promise<void> {
  await env.DB.prepare("UPDATE events SET created_at = ? WHERE sequence = ?").bind(createdAt, sequence).run();
}

export async function markDelivered(...sequences: readonly number[]): Promise<void> {
  for (const sequence of sequences) {
    await env.DB.prepare("UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE event_sequence = ?")
      .bind("2026-08-30T00:00:00.000Z", sequence).run();
  }
}
