/**
 * The suppression anti-join on the control-target finder, which had none.
 *
 * `selectControlTargets` is the SQL arm the real `findControlTargets` uses once it
 * has search terms. Its sibling arm two hundred lines below, `readCandidates`,
 * carries two `NOT EXISTS` clauses against `memory_active_event_suppressions` --
 * one for the item's own creation event, one for the event recorded in
 * `memory_item_sources`. The control-target arm carried neither.
 *
 * So a memory whose originating event was suppressed could still be selected as a
 * control target: reachable by `memory_forget`, `memory_explain`, `memory_correct`,
 * `memory_confirm`, `memory_pin` and `memory_unpin` when the ledger said it should
 * not be. Nothing failed, because the two arms are separate SQL strings and no test
 * compared them.
 *
 * Each test below pins ONE anti-join, and each is arranged so the other one cannot
 * mask it:
 *
 *   - the first suppresses the candidate's own `creation_event_id` and leaves the
 *     candidate's source event unsuppressed, so only the `memory_items` clause can
 *     exclude it;
 *   - the second suppresses the candidate's `memory_item_sources` event and leaves
 *     its creation event unsuppressed, so only the `memory_item_sources` clause can
 *     exclude it.
 *
 * Both of those states are reachable: the suppression is written AFTER the item is
 * committed, and `selectControlTargets` reads `memory_item_state` live, so nothing
 * ties "this item exists" to "its event was suppressed when it was created".
 *
 * The two clauses therefore have to be neutered separately. A single mutant removing
 * both would be satisfied by either one alone, and would prove neither.
 *
 * Three fixture constraints are load-bearing and each was met by failing first:
 *
 *   - `validateLiveEventEvidence` requires the source event's payload to CONTAIN the
 *     excerpt, so an item's text is chosen together with the event that carries it
 *     and passed as one string;
 *   - items are committed through `MemoryRepository.commitInitialItem`, so they are
 *     real canonical items with placements and FTS rows rather than hand-written
 *     shapes a schema change would leave looking valid;
 *   - `memory_event_suppressions_insert_guard` refuses any suppression not backed by
 *     a matching owner command, so the command is built with the exact payload the
 *     guard cross-checks rather than a token one.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  newUlid,
  sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";

interface TestEvent {
  readonly eventId: Ulid;
  readonly sequence: number;
  readonly occurredAt: string;
}

interface TestItem {
  readonly itemId: Ulid;
  readonly versionId: Ulid;
  readonly sourceId: Ulid;
  readonly sourceEventId: Ulid;
}

async function seedPrincipal(): Promise<string> {
  const principalId = `principal:control-suppression:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'control suppression test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

/** Inserts one event row and returns its eventId, sequence and occurredAt. */
async function insertEvent(
  principalId: string,
  eventId: Ulid,
  eventType: string,
  source: string,
  envelope: Readonly<Record<string, unknown>> & { occurredAt: string; contentHash: string },
): Promise<TestEvent> {
  const occurredAt = envelope.occurredAt;
  const contentHash = envelope.contentHash;
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      eventId, eventType, source, principalId, occurredAt, occurredAt,
      contentHash, JSON.stringify(envelope), occurredAt,
    ).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("control_suppression_event_missing");
  return Object.freeze({ eventId, sequence: row.sequence, occurredAt });
}

/**
 * A committed conversation event carrying `text`.
 *
 * The envelope is built the way `test/memory/memory-repository.test.ts` builds one:
 * `validateLiveEventEvidence` re-derives the content hash from the payload and reads
 * fields out of the envelope, so an event row that merely "looks right" fails
 * `commitInitialItem` with `memory_corrupt` -- which reads as a database fault rather
 * than a fixture fault.
 */
async function seedEvent(principalId: string, text: string): Promise<TestEvent> {
  const eventId = newUlid();
  const occurredAt = new Date().toISOString();
  const payload = {
    schemaCode: 1,
    channelCode: 2,
    sensitivityCode: 1,
    historyEligible: true,
    text,
  };
  const contentHash = await sha256Hex(canonicalJson(payload));
  return insertEvent(principalId, eventId, "conversation.user_committed", "conversation", {
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(),
    contentType: "application/json",
    contentHash,
    payload,
    redaction: { status: "none", markers: [] },
    producerVersion: "conversation-v1",
  });
}

/**
 * One active, canonical memory item whose text is `itemText`, sourced from `source`.
 * `creation` is a separate event, so a test can suppress the item's creation event
 * without suppressing its source, and the reverse.
 */
async function commitItem(
  principalId: string,
  itemText: string,
  creation: TestEvent,
  source: TestEvent,
): Promise<TestItem> {
  const memory = new MemoryRepository(env.DB);
  const topics = await memory.bootstrapTopics(principalId);
  const itemId = newUlid();
  const versionId = newUlid();
  const sourceId = newUlid();
  const textHash = await sha256Hex(itemText);
  await memory.commitInitialItem({
    principalId,
    itemId,
    kind: "fact",
    lifetime: "durable",
    creationEventId: creation.eventId,
    creationEventSequence: creation.sequence,
    version: {
      versionId,
      text: itemText,
      textHash,
      basis: "stated",
      origin: "authenticated_first_person",
      uncertain: false,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "control-suppression-test-v1",
      extractorModelId: null,
    },
    sources: [{
      sourceId,
      eventId: source.eventId,
      eventSequence: source.sequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: itemText,
      excerptHash: textHash,
      channel: "telegram",
      occurredAt: source.occurredAt,
    }],
    transition: {
      transitionId: newUlid(),
      lifecycleState: "active",
      reason: "control suppression test",
      policyVersion: "control-suppression-test-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: topics.inbox.topicId,
      filingSource: "rule",
      confidence: 0.4,
      reason: "control suppression test",
    },
  });
  return Object.freeze({ itemId, versionId, sourceId, sourceEventId: source.eventId });
}

/**
 * Suppresses one event, through the real guard.
 *
 * `memory_event_suppressions_insert_guard` refuses any row not backed by an owner
 * command whose envelope carries a `history.suppress` payload matching the
 * suppression field for field, and whose sequence is greater than the target event's.
 * So the command is built here with those exact values rather than a placeholder
 * envelope.
 */
async function suppressEvent(principalId: string, target: TestEvent): Promise<void> {
  const suppressionId = newUlid();
  const commandId = newUlid();
  const occurredAt = new Date().toISOString();
  const command = {
    eventId: commandId,
    correlationId: commandId,
    eventType: "memory.owner_command",
    source: "memory-control",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    contentHash: await sha256Hex(`${commandId}:history.suppress`),
    producerVersion: "memory-control-v1",
    payload: {
      operation: "history.suppress",
      targetId: suppressionId,
      targetEventId: target.eventId,
      startEventSequence: null,
      endEventSequence: null,
      newlyHiddenTurnCount: 1,
      totalCoveredTurnCount: 1,
    },
  };
  await insertEvent(principalId, commandId, "memory.owner_command", "memory-control", command);
  // The sequence comparisons in the guard are integer-typed, so the values are
  // inlined rather than bound: a bound integer can arrive as a string and
  // `typeof x = 'integer'` then fails.
  await env.DB.prepare(`INSERT INTO memory_event_suppressions (
    suppression_id, principal_id, target_event_id, start_event_sequence,
    end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
    source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
  ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, 1, 1, ?)`)
    .bind(
      suppressionId, principalId, target.eventId, commandId,
      "control-suppression test fixture", occurredAt,
    ).run();
}

function retriever(): TelegramMemoryRetriever {
  return new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE });
}

beforeAll(async () => {
  await applyNewestRuntimeMigration();
});

describe("the control-target finder refuses a memory whose event was suppressed", () => {
  it("excludes an item whose own creation event is suppressed", async () => {
    const principalId = await seedPrincipal();
    const keptCreation = await seedEvent(principalId, "an unrelated earlier remark");
    const keptText = "the kite is in the shed";
    const keptSource = await seedEvent(principalId, keptText);
    const kept = await commitItem(principalId, keptText, keptCreation, keptSource);

    const goneCreation = await seedEvent(principalId, "another unrelated earlier remark");
    const goneText = "the kite is in the attic";
    const goneSource = await seedEvent(principalId, goneText);
    const gone = await commitItem(principalId, goneText, goneCreation, goneSource);
    // Suppressed AFTER the item exists, which is the reachable shape: the ledger's
    // suppression and the item's live state are separate facts.
    await suppressEvent(principalId, goneCreation);

    // Both sources are unsuppressed, so the `memory_item_sources` clause cannot be
    // what excludes the second item; only the `memory_items` clause can.
    const found = await retriever().findControlTargets({
      principalId,
      operation: "forget",
      query: "kite",
    });
    expect(found).toEqual([kept.itemId]);
    expect(found).not.toContain(gone.itemId);
  });

  it("excludes an item whose source event is suppressed, when its creation event is not", async () => {
    const principalId = await seedPrincipal();
    const keptCreation = await seedEvent(principalId, "an earlier remark about the garage");
    const keptText = "the ladder is in the garage";
    const keptSource = await seedEvent(principalId, keptText);
    const kept = await commitItem(principalId, keptText, keptCreation, keptSource);

    const liveCreation = await seedEvent(principalId, "an earlier remark about the attic");
    const goneText = "the ladder is in the attic";
    const goneSource = await seedEvent(principalId, goneText);
    const gone = await commitItem(principalId, goneText, liveCreation, goneSource);
    await suppressEvent(principalId, goneSource);

    // The candidate's creation event is unsuppressed here, so only the
    // `memory_item_sources` clause can exclude it.
    const found = await retriever().findControlTargets({
      principalId,
      operation: "forget",
      query: "ladder",
    });
    expect(found).toEqual([kept.itemId]);
    expect(found).not.toContain(gone.itemId);
  });

  it("still finds the item when nothing is suppressed", async () => {
    // The control. Without it, a finder that returned nothing for any reason --
    // including a broken query -- would pass both tests above.
    const principalId = await seedPrincipal();
    const creation = await seedEvent(principalId, "an earlier remark about the porch");
    const text = "the rake is by the door";
    const source = await seedEvent(principalId, text);
    const item = await commitItem(principalId, text, creation, source);

    const found = await retriever().findControlTargets({
      principalId,
      operation: "forget",
      query: "rake",
    });
    expect(found).toEqual([item.itemId]);
  });
});
