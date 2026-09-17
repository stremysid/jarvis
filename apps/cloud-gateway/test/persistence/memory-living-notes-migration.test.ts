import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import livingNotesSql from "../../src/persistence/migrations/0032_memory_living_notes.sql?raw";
import { applyMemoryLivingNotesMigration } from "./migration.js";

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
): Promise<Ulid> {
  const noteVersionId = newUlid();
  const text = markdown(value.rootTopicEventId);
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

async function insertReceipt(value: Fixture, noteVersionId: Ulid): Promise<Ulid> {
  const receiptId = newUlid();
  await env.DB.prepare(`INSERT INTO memory_topic_note_receipts (
    receipt_id, principal_id, run_id, topic_id, prior_note_version_id,
    new_note_version_id, reason, created_at
  ) VALUES (?, ?, ?, ?, NULL, ?, 'initial living note', ?)`)
    .bind(
      receiptId,
      value.principalId,
      value.runId,
      value.rootTopicId,
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

async function proveWholeTriggerIsRequired(
  triggerName: string,
  mutation: () => Promise<unknown>,
  expectedFailure: string,
): Promise<void> {
  await expect(mutation()).rejects.toThrow(expectedFailure);
  const trigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
  ).bind(triggerName).first<{ sql: string }>();
  if (trigger === null) throw new Error(`missing trigger ${triggerName}`);
  await env.DB.prepare(`DROP TRIGGER ${triggerName}`).run();
  try { await expect(mutation()).resolves.toBeDefined(); }
  finally { await env.DB.prepare(trigger.sql).run(); }
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
    await proveWholeTriggerIsRequired(
      "memory_topic_note_versions_insert_guard",
      () => insertVersion(value, value.rootTopicId, 2),
      "memory_topic_note_version_invalid",
    );
  });

  it("needs the whole note-version update guard to preserve version history", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await proveWholeTriggerIsRequired(
      "memory_topic_note_versions_update_guard",
      () => env.DB.prepare("UPDATE memory_topic_note_versions SET token_count = 41 WHERE note_version_id = ?")
        .bind(id).run(),
      "memory_topic_note_version_immutable",
    );
  });

  it("needs the whole note-version delete guard to preserve version history", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await proveWholeTriggerIsRequired(
      "memory_topic_note_versions_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_topic_note_versions WHERE note_version_id = ?").bind(id).run(),
      "memory_topic_note_version_delete_forbidden",
    );
  });

  it("needs the whole note-source insert guard to require a citation in Markdown", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await proveWholeTriggerIsRequired(
      "memory_topic_note_sources_insert_guard",
      () => insertSource(value, id, value.inboxTopicEventId),
      "memory_topic_note_source_invalid",
    );
  });

  it("needs the whole note-source update guard to preserve cited evidence", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    const source = await insertSource(value, id);
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
      "memory_topic_note_receipts_update_guard",
      () => env.DB.prepare("UPDATE memory_topic_note_receipts SET reason = 'changed' WHERE receipt_id = ?")
        .bind(note.receiptId).run(),
      "memory_topic_note_receipt_immutable",
    );
  });

  it("needs the whole note-receipt delete guard to preserve rewrite receipts", async () => {
    const value = await fixture();
    const note = await completeNote(value);
    await proveWholeTriggerIsRequired(
      "memory_topic_note_receipts_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_topic_note_receipts WHERE receipt_id = ?")
        .bind(note.receiptId).run(),
      "memory_topic_note_receipt_delete_forbidden",
    );
  });

  it("needs the whole note-head insert guard to reject an unreceipted head", async () => {
    const value = await fixture();
    const id = await insertVersion(value);
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
      "memory_topic_note_heads_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_topic_note_heads WHERE principal_id = ? AND topic_id = ?")
        .bind(value.principalId, value.rootTopicId).run(),
      "memory_topic_note_head_delete_forbidden",
    );
  });

  it("needs the whole change-receipt insert guard to require the claimed canonical change", async () => {
    const value = await fixture();
    const id = newUlid();
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
      "memory_consolidation_change_receipts_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_consolidation_change_receipts WHERE change_receipt_id = ?")
        .bind(id).run(),
      "memory_consolidation_change_receipt_delete_forbidden",
    );
  });

  it("needs the whole model-step insert guard to reject a skipped checkpoint", async () => {
    const value = await fixture();
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
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
    await proveWholeTriggerIsRequired(
      "memory_consolidation_model_steps_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_consolidation_model_steps WHERE step_receipt_id = ?")
        .bind(id).run(),
      "memory_consolidation_model_step_delete_forbidden",
    );
  });
});
