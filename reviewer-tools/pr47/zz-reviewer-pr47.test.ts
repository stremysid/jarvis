// Reviewer probes for PR #47. Each test ASSERTS THE GAP EXISTS (passes on the head under review).
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import type { CommitInitialMemoryInput } from "../../src/memory/memory-types.js";
import { applyMemoryIngressMigration } from "../persistence/migration.js";

async function seedPrincipal(label: string): Promise<string> {
  const principalId = `principal:pr47-probe:${label}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'service', 'active', 'pr47 probe', ?, ?)`).bind(principalId, now, now).run();
  return principalId;
}

async function seedEvent(principalId: string, envelope: string) {
  const eventId = newUlid();
  const occurredAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'jarvis.conversation', ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, principalId, occurredAt, occurredAt, await sha256Hex(envelope), envelope, occurredAt).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("pr47_probe_event_missing");
  return { eventId: eventId as Ulid, sequence: row.sequence, occurredAt };
}

async function seedArchivedEventForSomeoneElse() {
  const eventId = newUlid();
  const occurredAt = new Date().toISOString();
  const manifestId = await sha256Hex(`manifest:${eventId}`);
  const segmentId = await sha256Hex(`segment:${eventId}`);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO archive_manifests (
      manifest_id, start_sequence, end_sequence, event_count, status, created_at, sealed_at
    ) VALUES (?, 900001, 900001, 1, 'sealed', ?, ?)`).bind(manifestId, occurredAt, occurredAt),
    env.DB.prepare(`INSERT INTO archive_segments (
      segment_id, manifest_id, object_key, compressed_sha256,
      compressed_byte_length, uncompressed_byte_length, codec, created_at
    ) VALUES (?, ?, ?, ?, 1, 1, 'jarvis-gzip-ndjson-v1', ?)`)
      .bind(segmentId, manifestId, `pr47-probe/${segmentId}.ndjson.gz`, segmentId, occurredAt),
    env.DB.prepare(`INSERT INTO archive_segment_events (
      event_sequence, event_id, segment_id, envelope_sha256, content_hash, created_at
    ) VALUES (900001, ?, ?, ?, ?, ?)`)
      .bind(eventId, segmentId, await sha256Hex(`env:${eventId}`), await sha256Hex(`c:${eventId}`), occurredAt),
  ]);
  return { eventId: eventId as Ulid, sequence: 900001, occurredAt, segmentId };
}

async function input(
  principalId: string,
  creation: { eventId: Ulid; sequence: number },
  source: CommitInitialMemoryInput["sources"][number],
  topicId: Ulid,
  text: string,
  archived: boolean,
): Promise<CommitInitialMemoryInput> {
  return {
    principalId,
    itemId: newUlid(),
    kind: "fact",
    creationEventId: creation.eventId,
    creationEventSequence: creation.sequence,
    version: {
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: archived ? "inferred" : "stated",
      origin: archived ? "model" : "authenticated_first_person",
      uncertain: archived,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "memory-policy-v1",
      extractorModelId: archived ? "deepseek:deepseek-v4-pro" : null,
    },
    sources: [source],
    transition: {
      transitionId: newUlid(),
      lifecycleState: archived ? "proposed" : "active",
      reason: "pr47 probe",
      policyVersion: "memory-policy-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId,
      filingSource: "rule",
      confidence: 0.9,
      reason: "pr47 probe",
    },
  };
}

beforeAll(async () => {
  await applyMemoryIngressMigration();
});

describe("PR47 reviewer probes", () => {
  it("Q1: a stated, active memory is accepted with an excerpt that never appears in its live source event", async () => {
    const principalId = await seedPrincipal("q1");
    const event = await seedEvent(principalId, JSON.stringify({ payload: { text: "What time is practice?" } }));
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const fabricated = "I am allergic to penicillin.";
    const result = await repository.commitInitialItem(await input(principalId, event, {
      sourceId: newUlid(), eventId: event.eventId, eventSequence: event.sequence,
      sourceLocation: "live", r2SegmentId: null, excerpt: fabricated,
      excerptHash: await sha256Hex(fabricated), channel: "telegram", occurredAt: event.occurredAt,
    }, topics.inbox.topicId, fabricated, false));
    expect(result.item.lifecycle.state).toBe("active");
    expect(result.item.sources[0]?.excerpt).toBe(fabricated);
  });

  it("Q2: an archived event with no link to the principal is accepted as that principal's memory source", async () => {
    const principalId = await seedPrincipal("q2");
    const creation = await seedEvent(principalId, "{}");
    const foreign = await seedArchivedEventForSomeoneElse();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const text = "Probably likes early practice.";
    const result = await repository.commitInitialItem(await input(principalId, creation, {
      sourceId: newUlid(), eventId: foreign.eventId, eventSequence: foreign.sequence,
      sourceLocation: "archived", r2SegmentId: foreign.segmentId, excerpt: text,
      excerptHash: await sha256Hex(text), channel: "voice", occurredAt: foreign.occurredAt,
    }, topics.inbox.topicId, text, true));
    expect(result.item.sources[0]?.sourceLocation).toBe("archived");
  });
});
