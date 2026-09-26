import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, canonicalJson, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import livingNotesSql from "../../src/persistence/migrations/0032_memory_living_notes.sql?raw";
import { applyMemoryLivingNotesMigration } from "./migration.js";
import { proveWholeTrigger } from "./whole-trigger-proof.js";

const MODEL = "deepseek:deepseek-flash";

interface Fixture {
  readonly principalId: string;
  readonly runId: Ulid;
  readonly rootTopicId: Ulid;
  readonly inboxTopicId: Ulid;
  readonly rootTopicEventId: Ulid;
  readonly inboxTopicEventId: Ulid;
  readonly now: string;
}

async function fixture(): Promise<Fixture> {
  const principalId = `principal:living-note-migration:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'living note migration test', ?, ?)`)
    .bind(principalId, now, now).run();
  const topics = await new MemoryRepository(env.DB).bootstrapTopics(principalId);
  const runId = newUlid();
  await env.DB.prepare(`INSERT INTO memory_runs (
    run_id, principal_id, run_key, job, reprocess_job_id, start_event_sequence,
    end_event_sequence, provider_model_id, price_id, outcome, started_at
  ) VALUES (?, ?, ?, 'consolidation', NULL, NULL, NULL, ?, NULL, 'running', ?)`)
    .bind(runId, principalId, `migration:${runId}`, MODEL, now).run();
  const root = await env.DB.prepare(`SELECT last_topic_event_id FROM memory_topics
    WHERE principal_id = ? AND topic_id = ?`).bind(principalId, topics.root.topicId)
    .first<{ last_topic_event_id: Ulid }>();
  const inbox = await env.DB.prepare(`SELECT last_topic_event_id FROM memory_topics
    WHERE principal_id = ? AND topic_id = ?`).bind(principalId, topics.inbox.topicId)
    .first<{ last_topic_event_id: Ulid }>();
  if (root === null || inbox === null) throw new Error("living_note_migration_topic_missing");
  return {
    principalId,
    runId,
    rootTopicId: topics.root.topicId,
    inboxTopicId: topics.inbox.topicId,
    rootTopicEventId: root.last_topic_event_id,
    inboxTopicEventId: inbox.last_topic_event_id,
    now,
  };
}

function markdown(sourceId: Ulid): string {
  return `## Summary\nDerived from ${sourceId}.\n\n## Current facts\n- ${sourceId}\n\n`
    + "## Open items\n- None.\n\n## Related areas\n- Inbox.";
}

async function insertVersion(
  value: Fixture,
  topicId = value.rootTopicId,
  versionNumber = 1,
  sourceCount = 1,
  citedId = value.rootTopicEventId,
): Promise<Ulid> {
  const noteVersionId = newUlid();
  const text = markdown(citedId);
  await env.DB.prepare(`INSERT INTO memory_topic_note_versions (
    note_version_id, principal_id, topic_id, version_number, markdown, content_hash,
    source_count, token_count, run_id, model_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 40, ?, ?, ?)`)
    .bind(
      noteVersionId,
      value.principalId,
      topicId,
      versionNumber,
      text,
      await sha256Hex(text),
      sourceCount,
      value.runId,
      MODEL,
      value.now,
    ).run();
  return noteVersionId;
}

async function insertSource(
  value: Fixture,
  noteVersionId: Ulid,
  sourceId = value.rootTopicEventId,
): Promise<Ulid> {
  const sourceRefId = newUlid();
  await env.DB.prepare(`INSERT INTO memory_topic_note_sources (
    source_ref_id, principal_id, note_version_id, source_position, source_kind,
    source_id, item_version_id, created_at
  ) VALUES (?, ?, ?, 0, 'topic_event', ?, NULL, ?)`)
    .bind(sourceRefId, value.principalId, noteVersionId, sourceId, value.now).run();
  return sourceRefId;
}

async function insertReceipt(
  value: Fixture,
  noteVersionId: Ulid,
  topicId = value.rootTopicId,
): Promise<Ulid> {
  const receiptId = newUlid();
  await env.DB.prepare(`INSERT INTO memory_topic_note_receipts (
    receipt_id, principal_id, run_id, topic_id, prior_note_version_id,
    new_note_version_id, reason, created_at
  ) VALUES (?, ?, ?, ?, NULL, ?, 'initial living note', ?)`)
    .bind(
      receiptId,
      value.principalId,
      value.runId,
      topicId,
      noteVersionId,
      value.now,
    ).run();
  return receiptId;
}

async function completeNote(value: Fixture): Promise<Readonly<{
  noteVersionId: Ulid;
  sourceRefId: Ulid;
  receiptId: Ulid;
}>> {
  const noteVersionId = await insertVersion(value);
  const sourceRefId = await insertSource(value, noteVersionId);
  const receiptId = await insertReceipt(value, noteVersionId);
  return { noteVersionId, sourceRefId, receiptId };
}

interface SeededItem {
  readonly itemId: Ulid;
  readonly versionId: Ulid;
  readonly sourceEventId: Ulid;
  /** The version's own timestamp, so a later item can be strictly newer. */
  readonly versionCreatedAt: string;
}

/** Moves forward per call, so a supersession's newer version is strictly newer. */
function steppingClock(from: string): { now(): Date } {
  let at = Date.parse(from);
  return { now: () => (at += 1_000, new Date(at)) };
}

/**
 * Commits one active item through `MemoryRepository`, so the item is bound by
 * the same guards production writes go through. Hand-written item rows would
 * let these tests prove states the product cannot reach.
 */
async function seedItem(value: Fixture, text: string, notBefore = value.now): Promise<SeededItem> {
  const clock = steppingClock(notBefore);
  const repository = new MemoryRepository(env.DB, { clock: clock.now });
  const eventId = newUlid(clock.now());
  const occurredAt = clock.now().toISOString();
  const payload = {
    schemaCode: 1,
    channelCode: 2,
    sensitivityCode: 1,
    historyEligible: true,
    directOwnerText: true,
    text,
  };
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: value.principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(clock.now()),
    contentType: "application/json",
    contentHash,
    payload,
    redaction: { status: "none", markers: [] },
    producerVersion: "conversation-v1",
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'conversation', ?, ?, ?, ?, ?, ?)`)
    .bind(
      eventId,
      value.principalId,
      occurredAt,
      occurredAt,
      contentHash,
      canonicalJson(envelope),
      occurredAt,
    ).run();
  const sequence = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<number>("sequence");
  if (sequence === null) throw new Error("living_note_migration_source_event_missing");
  const itemId = newUlid(clock.now());
  const versionId = newUlid(clock.now());
  await repository.commitInitialItem({
    principalId: value.principalId,
    itemId,
    kind: "fact",
    lifetime: "durable",
    creationEventId: eventId,
    creationEventSequence: sequence,
    version: {
      versionId,
      text,
      textHash: await sha256Hex(text),
      basis: "stated",
      origin: "authenticated_first_person",
      uncertain: false,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "living-note-migration-test-v1",
      extractorModelId: null,
    },
    sources: [{
      sourceId: newUlid(clock.now()),
      eventId,
      eventSequence: sequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: "telegram",
      occurredAt,
    }],
    transition: {
      transitionId: newUlid(clock.now()),
      lifecycleState: "active",
      reason: "authenticated first-person migration-test evidence",
      policyVersion: "living-note-migration-test-v1",
    },
    placement: {
      placementId: newUlid(clock.now()),
      placementEventId: newUlid(clock.now()),
      topicId: value.inboxTopicId,
      filingSource: "rule",
      confidence: 0.9,
      reason: "living-note migration test places its item in the inbox area",
    },
  });
  const versionCreatedAt = await env.DB.prepare(
    "SELECT created_at FROM memory_item_versions WHERE version_id = ?",
  ).bind(versionId).first<string>("created_at");
  if (versionCreatedAt === null) throw new Error("living_note_migration_version_missing");
  return { itemId, versionId, sourceEventId: eventId, versionCreatedAt };
}

/** A current root-topic note whose one cited source is a live item. */
async function itemNoteCase(): Promise<Readonly<{
  value: Fixture;
  item: SeededItem;
}>> {
  const value = await fixture();
  const item = await seedItem(value, "The migration test item is citable.");
  await insertItemSource(value, item);
  return { value, item };
}

async function insertItemSource(value: Fixture, item: SeededItem, position = 0): Promise<void> {
  const noteVersionId = await insertVersion(value, value.rootTopicId, 1, 1, item.itemId);
  await env.DB.prepare(`INSERT INTO memory_topic_note_sources (
    source_ref_id, principal_id, note_version_id, source_position, source_kind,
    source_id, item_version_id, created_at
  ) VALUES (?, ?, ?, ?, 'item', ?, ?, ?)`)
    .bind(
      newUlid(),
      value.principalId,
      noteVersionId,
      position,
      item.itemId,
      item.versionId,
      value.now,
    ).run();
  await insertReceipt(value, noteVersionId);
}

/**
 * The redaction triggers refuse nothing themselves: they move the affected
 * note head to 'redacted'. Removal is made observable through the same
 * refusal-then-acceptance proof the guards use by committing the triggering
 * row and then trying to put that head back to 'current' -- an un-redaction
 * the head guard refuses. With the redaction trigger gone, nothing redacts the
 * head and the same call succeeds.
 *
 * Each call builds its own case, so a refused half leaves nothing behind for
 * the second call to trip over.
 */
function unredact(value: Fixture, topicId: Ulid): Promise<unknown> {
  return env.DB.prepare(`UPDATE memory_topic_note_heads SET visibility = 'current'
    WHERE principal_id = ? AND topic_id = ?`).bind(value.principalId, topicId).run();
}

/**
 * Mirrors the merge event the consolidation workflow writes, including the
 * alias entry the topic-events guard requires. The source area must be a child
 * area, and the root is the merge target, so the redaction covers the root
 * note that `completeNote` installed.
 */
async function insertTopicMerge(value: Fixture): Promise<void> {
  const source = await env.DB.prepare(`SELECT display_name, normalized_name, parent_topic_id, updated_at
    FROM memory_topics WHERE principal_id = ? AND topic_id = ?`)
    .bind(value.principalId, value.inboxTopicId)
    .first<{
      display_name: string;
      normalized_name: string;
      parent_topic_id: string;
      updated_at: string;
    }>();
  if (source === null) throw new Error("living_note_migration_merge_source_missing");
  // The topic-events guard refuses an event older than the area's last one,
  // so the merge is stamped after the bootstrap event rather than at `now`.
  const occurredAt = new Date(Date.parse(source.updated_at) + 1_000).toISOString();
  await env.DB.prepare(`INSERT INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
    new_parent_topic_id, previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, 'merge', ?, NULL, ?, ?, NULL, NULL, ?, '[]', '[]', ?, ?, 'model', NULL, ?)`)
    .bind(
      newUlid(),
      value.principalId,
      value.inboxTopicId,
      source.parent_topic_id,
      source.display_name,
      source.normalized_name,
      value.rootTopicId,
      canonicalJson([{
        aliasId: newUlid(),
        topicId: value.rootTopicId,
        displayName: source.display_name,
        normalizedName: source.normalized_name,
        pathAlias: source.normalized_name,
      }]),
      "the migration test merges the inbox area into the profile area",
      occurredAt,
    ).run();
}

/**
 * Expires one item the way the nightly run does, so the item-transition
 * redaction trigger sees the row production creates.
 */
async function insertExpiredTransition(value: Fixture, item: SeededItem): Promise<void> {
  const state = await env.DB.prepare(`SELECT current_version_id, last_transition_number, updated_at
    FROM memory_item_state WHERE principal_id = ? AND item_id = ?`)
    .bind(value.principalId, item.itemId)
    .first<{ current_version_id: string; last_transition_number: number; updated_at: string }>();
  if (state === null) throw new Error("living_note_migration_item_state_missing");
  await env.DB.prepare(`INSERT INTO memory_item_transitions (
    transition_id, principal_id, item_id, transition_number, version_id,
    lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, ?, 'expired', ?, 'rules', ?, NULL, ?)`)
    .bind(
      newUlid(),
      value.principalId,
      item.itemId,
      state.last_transition_number + 1,
      state.current_version_id,
      "The fact's explicit validity end passed.",
      "living-note-migration-test-v1",
      new Date(Date.parse(state.updated_at) + 1_000).toISOString(),
    ).run();
}

/** A note citing an older item, plus the newer item that supersedes it. */
async function supersessionCase(): Promise<Readonly<{
  value: Fixture;
  older: SeededItem;
  newer: SeededItem;
}>> {
  const value = await fixture();
  const older = await seedItem(value, "The superseded migration item is citable.");
  const newer = await seedItem(
    value,
    "The newer migration item supersedes the older one.",
    older.versionCreatedAt,
  );
  await insertItemSource(value, older);
  return { value, older, newer };
}

async function insertSupersession(
  value: Fixture,
  older: SeededItem,
  newer: SeededItem,
): Promise<void> {
  await env.DB.prepare(`INSERT INTO memory_consolidation_change_receipts (
    change_receipt_id, principal_id, run_id, change_kind, subject_id, related_id,
    reason, transition_or_event_id, created_at
  ) VALUES (?, ?, ?, 'supersession', ?, ?, ?, ?, ?)`)
    .bind(
      newUlid(),
      value.principalId,
      value.runId,
      older.itemId,
      newer.itemId,
      "The newer migration item supersedes the older one.",
      newer.itemId,
      value.now,
    ).run();
}

/**
 * Hides one cited turn the way `history.suppress` does: a canonical owner
 * command event and the suppression row it authorizes, both written through
 * their guards.
 */
async function insertSuppression(value: Fixture, item: SeededItem): Promise<void> {
  const suppressionId = newUlid();
  const commandEventId = newUlid();
  const contentHash = await sha256Hex(canonicalJson({ suppressionId, commandEventId }));
  const envelope = {
    schemaVersion: "1.0",
    eventId: commandEventId,
    correlationId: commandEventId,
    eventType: "memory.owner_command",
    source: "memory-control",
    subjectId: value.principalId,
    occurredAt: value.now,
    receivedAt: value.now,
    contentHash,
    producerVersion: "memory-control-v1",
    payload: {
      operation: "history.suppress",
      targetId: suppressionId,
      targetEventId: item.sourceEventId,
      startEventSequence: null,
      endEventSequence: null,
      newlyHiddenTurnCount: 1,
      totalCoveredTurnCount: 1,
    },
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'memory.owner_command', 'memory-control', ?, ?, ?, ?, ?, ?)`)
    .bind(
      commandEventId,
      value.principalId,
      value.now,
      value.now,
      contentHash,
      canonicalJson(envelope),
      value.now,
    ).run();
  await env.DB.prepare(`INSERT INTO memory_event_suppressions (
    suppression_id, principal_id, target_event_id, start_event_sequence,
    end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
    source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
  ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'owner asked Jarvis to forget this turn', 1, 1, ?)`)
    .bind(suppressionId, value.principalId, item.sourceEventId, commandEventId, value.now).run();
}

beforeAll(async () => applyMemoryLivingNotesMigration());

describe("memory living notes migration", () => {
  it("installs both promised memory-history lookup indexes", async () => {
    const content = await env.DB.prepare(
      "PRAGMA index_info(memory_history_chunks_principal_content_hash)",
    ).all<{ seqno: number; name: string }>();
    const sequence = await env.DB.prepare(
      "PRAGMA index_info(memory_history_chunks_principal_start_event_sequence)",
    ).all<{ seqno: number; name: string }>();

    expect(content.results.map(({ seqno, name }) => [seqno, name])).toEqual([
      [0, "principal_id"],
      [1, "content_hash"],
    ]);
    expect(sequence.results.map(({ seqno, name }) => [seqno, name])).toEqual([
      [0, "principal_id"],
      [1, "start_event_sequence"],
    ]);
  });

  it("installs every guard as one remote-D1-compatible whole trigger", () => {
    const guardNames = Array.from(livingNotesSql.matchAll(
      /^CREATE TRIGGER ([a-z0-9_]+_guard)$/gmu,
    ), (match) => match[1]);
    expect(guardNames).toEqual([
      "memory_topic_note_versions_insert_guard",
      "memory_topic_note_versions_update_guard",
      "memory_topic_note_versions_delete_guard",
      "memory_topic_note_sources_insert_guard",
      "memory_topic_note_sources_update_guard",
      "memory_topic_note_sources_delete_guard",
      "memory_topic_note_receipts_insert_guard",
      "memory_topic_note_receipts_update_guard",
      "memory_topic_note_receipts_delete_guard",
      "memory_topic_note_heads_insert_guard",
      "memory_topic_note_heads_update_guard",
      "memory_topic_note_heads_delete_guard",
      "memory_consolidation_change_receipts_insert_guard",
      "memory_consolidation_change_receipts_update_guard",
      "memory_consolidation_change_receipts_delete_guard",
      "memory_consolidation_model_steps_insert_guard",
      "memory_consolidation_model_steps_update_guard",
      "memory_consolidation_model_steps_delete_guard",
    ]);
    for (const name of guardNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const whole = livingNotesSql.match(new RegExp(
        `CREATE TRIGGER ${escaped}\\b[\\s\\S]*?\\nEND;`,
        "u",
      ));
      expect(whole?.[0], name).toMatch(/SELECT\s+RAISE\s*\([^;]+\)\s+WHERE/iu);
      expect(whole?.[0], name).not.toMatch(/SELECT\s+CASE[^;]+RAISE/iu);
    }
  });

  it("needs the whole note-version insert guard to reject a skipped version number", async () => {
    const value = await fixture();
    await proveWholeTrigger(
      "memory_topic_note_versions_insert_guard",
      () => insertVersion(value, value.rootTopicId, 2),
      "memory_topic_note_version_invalid",
    );
  });

  it("needs the whole note-version update guard to preserve version history", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await proveWholeTrigger(
      "memory_topic_note_versions_update_guard",
      () => env.DB.prepare("UPDATE memory_topic_note_versions SET token_count = 41 WHERE note_version_id = ?")
        .bind(id).run(),
      "memory_topic_note_version_immutable",
    );
  });

  it("needs the whole note-version delete guard to preserve version history", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await proveWholeTrigger(
      "memory_topic_note_versions_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_topic_note_versions WHERE note_version_id = ?").bind(id).run(),
      "memory_topic_note_version_delete_forbidden",
    );
  });

  it("accepts a note source the schema holds even when the markdown never names it", async () => {
    const value = await fixture();
    const noteVersionId = newUlid();
    const text = "A note written in the model's own words, with no id in it.";
    await env.DB.prepare(`INSERT INTO memory_topic_note_versions (
      note_version_id, principal_id, topic_id, version_number, markdown, content_hash,
      source_count, token_count, run_id, model_id, created_at
    ) VALUES (?, ?, ?, 1, ?, ?, 1, 40, ?, ?, ?)`)
      .bind(
        noteVersionId,
        value.principalId,
        value.rootTopicId,
        text,
        await sha256Hex(text),
        value.runId,
        MODEL,
        value.now,
      ).run();

    // 0047 removed the markdown-citation clause from this guard. The receipt is
    // the source row the action names, not a copy of the id inside prose.
    const sourceRefId = newUlid();
    await expect(env.DB.prepare(`INSERT INTO memory_topic_note_sources (
      source_ref_id, principal_id, note_version_id, source_position, source_kind,
      source_id, item_version_id, created_at
    ) VALUES (?, ?, ?, 0, 'topic_event', ?, NULL, ?)`)
      .bind(sourceRefId, value.principalId, noteVersionId, value.rootTopicEventId, value.now).run())
      .resolves.toBeDefined();
  });

  it("needs the whole note-source insert guard to reject a topic event the principal does not hold", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await proveWholeTrigger(
      "memory_topic_note_sources_insert_guard",
      () => insertSource(value, id, newUlid()),
      "memory_topic_note_source_invalid",
    );
  });

  it("needs the whole note-source insert guard to reject an item source whose version does not exist", async () => {
    const value = await fixture();
    const item = await seedItem(value, "An item the note may cite.");
    const id = await insertVersion(value, value.rootTopicId, 1, 1, item.itemId);
    await proveWholeTrigger(
      "memory_topic_note_sources_insert_guard",
      () => env.DB.prepare(`INSERT INTO memory_topic_note_sources (
        source_ref_id, principal_id, note_version_id, source_position, source_kind,
        source_id, item_version_id, created_at
      ) VALUES (?, ?, ?, 0, 'item', ?, ?, ?)`)
        .bind(newUlid(), value.principalId, id, item.itemId, newUlid(), value.now).run(),
      "memory_topic_note_source_invalid",
    );
  });

  it("needs the whole note-source update guard to preserve cited evidence", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    const source = await insertSource(value, id);
    await proveWholeTrigger(
      "memory_topic_note_sources_update_guard",
      () => env.DB.prepare("UPDATE memory_topic_note_sources SET source_position = 1 WHERE source_ref_id = ?")
        .bind(source).run(),
      "memory_topic_note_source_immutable",
    );
  });

  it("needs the whole note-source delete guard to preserve cited evidence", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    const source = await insertSource(value, id);
    await proveWholeTrigger(
      "memory_topic_note_sources_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_topic_note_sources WHERE source_ref_id = ?").bind(source).run(),
      "memory_topic_note_source_delete_forbidden",
    );
  });

  it("needs the whole note-receipt insert guard to bind the rewrite to its topic", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await insertSource(value, id);
    const receiptId = newUlid();
    await proveWholeTrigger(
      "memory_topic_note_receipts_insert_guard",
      () => env.DB.prepare(`INSERT INTO memory_topic_note_receipts (
        receipt_id, principal_id, run_id, topic_id, prior_note_version_id,
        new_note_version_id, reason, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?, 'wrong topic', ?)`)
        .bind(receiptId, value.principalId, value.runId, value.inboxTopicId, id, value.now).run(),
      "memory_topic_note_receipt_invalid",
    );
  });

  it("needs the whole note-receipt update guard to preserve rewrite receipts", async () => {
    const value = await fixture();
    const note = await completeNote(value);
    await proveWholeTrigger(
      "memory_topic_note_receipts_update_guard",
      () => env.DB.prepare("UPDATE memory_topic_note_receipts SET reason = 'changed' WHERE receipt_id = ?")
        .bind(note.receiptId).run(),
      "memory_topic_note_receipt_immutable",
    );
  });

  it("needs the whole note-receipt delete guard to preserve rewrite receipts", async () => {
    const value = await fixture();
    const note = await completeNote(value);
    await proveWholeTrigger(
      "memory_topic_note_receipts_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_topic_note_receipts WHERE receipt_id = ?")
        .bind(note.receiptId).run(),
      "memory_topic_note_receipt_delete_forbidden",
    );
  });

  it("needs the whole note-head insert guard to reject an unreceipted head", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await proveWholeTrigger(
      "memory_topic_note_heads_insert_guard",
      () => env.DB.prepare(`INSERT INTO memory_topic_note_heads (
        principal_id, topic_id, current_note_version_id, visibility, updated_at
      ) VALUES (?, ?, ?, 'current', ?)`)
        .bind(value.principalId, value.inboxTopicId, id, value.now).run(),
      "memory_topic_note_head_invalid",
    );
  });

  it("needs the whole note-head update guard to reject an unreceipted pointer change", async () => {
    const value = await fixture();
    const first = await completeNote(value);
    const second = await insertVersion(value, value.rootTopicId, 2);
    await insertSource(value, second);
    await proveWholeTrigger(
      "memory_topic_note_heads_update_guard",
      () => env.DB.prepare(`UPDATE memory_topic_note_heads
        SET current_note_version_id = ?, updated_at = ? WHERE principal_id = ? AND topic_id = ?`)
        .bind(second, new Date(Date.parse(value.now) + 1).toISOString(), value.principalId, value.rootTopicId).run(),
      "memory_topic_note_head_transition_invalid",
    );
    expect(first.noteVersionId).not.toBe(second);
  });

  it("needs the whole note-head delete guard to retain the current pointer", async () => {
    const value = await fixture();
    await completeNote(value);
    await proveWholeTrigger(
      "memory_topic_note_heads_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_topic_note_heads WHERE principal_id = ? AND topic_id = ?")
        .bind(value.principalId, value.rootTopicId).run(),
      "memory_topic_note_head_delete_forbidden",
    );
  });

  it("needs the whole change-receipt insert guard to require the claimed canonical change", async () => {
    const value = await fixture();
    const id = newUlid();
    await proveWholeTrigger(
      "memory_consolidation_change_receipts_insert_guard",
      () => env.DB.prepare(`INSERT INTO memory_consolidation_change_receipts (
        change_receipt_id, principal_id, run_id, change_kind, subject_id, related_id,
        reason, transition_or_event_id, created_at
      ) VALUES (?, ?, ?, 'topic_merge', ?, ?, 'unperformed merge', ?, ?)`)
        .bind(id, value.principalId, value.runId, value.inboxTopicId, value.rootTopicId, newUlid(), value.now)
        .run(),
      "memory_consolidation_change_receipt_invalid",
    );
  });

  it("needs the whole change-receipt update guard to preserve explanations", async () => {
    const value = await fixture();
    const id = newUlid();
    const guard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'memory_consolidation_change_receipts_insert_guard'`)
      .first<{ sql: string }>();
    if (guard === null) throw new Error("change receipt insert guard missing");
    await env.DB.prepare("DROP TRIGGER memory_consolidation_change_receipts_insert_guard").run();
    try {
      await env.DB.prepare(`INSERT INTO memory_consolidation_change_receipts (
        change_receipt_id, principal_id, run_id, change_kind, subject_id, related_id,
        reason, transition_or_event_id, created_at
      ) VALUES (?, ?, ?, 'topic_merge', ?, ?, 'fixture', ?, ?)`)
        .bind(id, value.principalId, value.runId, value.inboxTopicId, value.rootTopicId, newUlid(), value.now)
        .run();
    } finally { await env.DB.prepare(guard.sql).run(); }
    await proveWholeTrigger(
      "memory_consolidation_change_receipts_update_guard",
      () => env.DB.prepare(`UPDATE memory_consolidation_change_receipts SET reason = 'changed'
        WHERE change_receipt_id = ?`).bind(id).run(),
      "memory_consolidation_change_receipt_immutable",
    );
  });

  it("needs the whole change-receipt delete guard to preserve explanations", async () => {
    const value = await fixture();
    const id = newUlid();
    const guard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'memory_consolidation_change_receipts_insert_guard'`)
      .first<{ sql: string }>();
    if (guard === null) throw new Error("change receipt insert guard missing");
    await env.DB.prepare("DROP TRIGGER memory_consolidation_change_receipts_insert_guard").run();
    try {
      await env.DB.prepare(`INSERT INTO memory_consolidation_change_receipts (
        change_receipt_id, principal_id, run_id, change_kind, subject_id, related_id,
        reason, transition_or_event_id, created_at
      ) VALUES (?, ?, ?, 'topic_merge', ?, ?, 'fixture', ?, ?)`)
        .bind(id, value.principalId, value.runId, value.inboxTopicId, value.rootTopicId, newUlid(), value.now)
        .run();
    } finally { await env.DB.prepare(guard.sql).run(); }
    await proveWholeTrigger(
      "memory_consolidation_change_receipts_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_consolidation_change_receipts WHERE change_receipt_id = ?")
        .bind(id).run(),
      "memory_consolidation_change_receipt_delete_forbidden",
    );
  });

  it("needs the whole model-step insert guard to reject a skipped checkpoint", async () => {
    const value = await fixture();
    await proveWholeTrigger(
      "memory_consolidation_model_steps_insert_guard",
      () => env.DB.prepare(`INSERT INTO memory_consolidation_model_steps (
        step_receipt_id, principal_id, run_id, step_number, response_json, response_hash,
        input_tokens, output_tokens, cache_read_tokens, reserved_cost_micros,
        settled_cost_micros, created_at
      ) VALUES (?, ?, ?, 2, '[]', ?, 0, 0, 0, 0, 0, ?)`)
        .bind(newUlid(), value.principalId, value.runId, "a".repeat(64), value.now).run(),
      "memory_consolidation_model_step_invalid",
    );
  });

  it("needs the whole model-step update guard to preserve replay input", async () => {
    const value = await fixture();
    const id = newUlid();
    await env.DB.prepare(`INSERT INTO memory_consolidation_model_steps (
      step_receipt_id, principal_id, run_id, step_number, response_json, response_hash,
      input_tokens, output_tokens, cache_read_tokens, reserved_cost_micros,
      settled_cost_micros, created_at
    ) VALUES (?, ?, ?, 1, '[]', ?, 0, 0, 0, 0, 0, ?)`)
      .bind(id, value.principalId, value.runId, "a".repeat(64), value.now).run();
    await proveWholeTrigger(
      "memory_consolidation_model_steps_update_guard",
      () => env.DB.prepare("UPDATE memory_consolidation_model_steps SET response_hash = ? WHERE step_receipt_id = ?")
        .bind("b".repeat(64), id).run(),
      "memory_consolidation_model_step_immutable",
    );
  });

  it("needs the whole model-step delete guard to preserve replay input", async () => {
    const value = await fixture();
    const id = newUlid();
    await env.DB.prepare(`INSERT INTO memory_consolidation_model_steps (
      step_receipt_id, principal_id, run_id, step_number, response_json, response_hash,
      input_tokens, output_tokens, cache_read_tokens, reserved_cost_micros,
      settled_cost_micros, created_at
    ) VALUES (?, ?, ?, 1, '[]', ?, 0, 0, 0, 0, 0, ?)`)
      .bind(id, value.principalId, value.runId, "a".repeat(64), value.now).run();
    await proveWholeTrigger(
      "memory_consolidation_model_steps_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_consolidation_model_steps WHERE step_receipt_id = ?")
        .bind(id).run(),
      "memory_consolidation_model_step_delete_forbidden",
    );
  });

  it("needs the whole supersession redaction trigger to take a superseded fact out of its note", async () => {
    await proveWholeTrigger(
      "memory_topic_notes_redact_for_supersession",
      async () => {
        const { value, older, newer } = await supersessionCase();
        await insertSupersession(value, older, newer);
        return unredact(value, value.rootTopicId);
      },
      "memory_topic_note_head_transition_invalid",
    );
  });

  it("needs the whole topic-merge redaction trigger to take both merged areas' notes out", async () => {
    await proveWholeTrigger(
      "memory_topic_notes_redact_for_topic_merge",
      async () => {
        const value = await fixture();
        await completeNote(value);
        await insertTopicMerge(value);
        return unredact(value, value.rootTopicId);
      },
      "memory_topic_note_head_transition_invalid",
    );
  });

  it("needs the whole item-transition redaction trigger to take an expired fact out of its note", async () => {
    await proveWholeTrigger(
      "memory_topic_notes_redact_for_item_transition",
      async () => {
        const { value, item } = await itemNoteCase();
        await insertExpiredTransition(value, item);
        return unredact(value, value.rootTopicId);
      },
      "memory_topic_note_head_transition_invalid",
    );
  });

  it("needs the whole event-suppression redaction trigger to take a forgotten turn out of its note", async () => {
    await proveWholeTrigger(
      "memory_topic_notes_redact_for_event_suppression",
      async () => {
        const { value, item } = await itemNoteCase();
        await insertSuppression(value, item);
        return unredact(value, value.rootTopicId);
      },
      "memory_topic_note_head_transition_invalid",
    );
  });
});
