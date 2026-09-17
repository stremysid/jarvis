import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type RedactedJsonValue,
} from "../../../../packages/contracts/src/index.js";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import {
  readLatestVerifiedMemoryBackup,
  restoreVerifiedMemoryBackupRows,
  type MemoryBackupRestoreManifest,
} from "../../src/backup/memory-backup-restore.js";
import {
  MEMORY_BACKUP_LATEST_KEY,
  MEMORY_BACKUP_TABLES,
  MemoryBackupService,
} from "../../src/backup/memory-backup.js";
import { LiteralHistoryService } from "../../src/memory/literal-history.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  clearMemoryBackupDataForTest,
  recreateFreshDatabaseForBackupRestoreTest,
} from "../persistence/migration.js";

const runDate = "2026-09-16";
const instant = new Date("2026-09-16T23:30:00.000Z");
const timestamp = instant.toISOString();
const oldTimestamp = "2026-09-15T12:00:00.000Z";
const laterOldTimestamp = "2026-09-15T12:01:00.000Z";
const backupBucket = env.BACKUP as R2Bucket;
const archiveBucket = env.ARCHIVE as R2Bucket;
const redactor = new Redactor();
const migrationSql = import.meta.glob("../../src/persistence/migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;
const migrationSources = Object.entries(migrationSql).sort(([left], [right]) => left.localeCompare(right))
  .map(([, sql]) => sql);

const ids = Object.freeze({
  event: "01k5nm00000000000000000001",
  item: "01k5nm00000000000000000002",
  version: "01k5nm00000000000000000003",
  source: "01k5nm00000000000000000004",
  turn: "01k5nm00000000000000000005",
  transition: "01k5nm00000000000000000006",
  topicEvent: "01k5nm00000000000000000007",
  topic: "01k5nm00000000000000000008",
  placementEvent: "01k5nm00000000000000000009",
  placement: "01k5nm0000000000000000000a",
  price: "01k5nm0000000000000000000b",
  run: "01k5nm0000000000000000000c",
  cost: "01k5nm0000000000000000000d",
  receipt: "01k5nm0000000000000000000e",
  reprocess: "01k5nm0000000000000000000f",
  literalSearch: "01k5nm0000000000000000000g",
  course: "01k5nm0000000000000000000h",
  practice: "01k5nm0000000000000000000j",
  evidence: "01k5nm0000000000000000000k",
  grant: "01k5nm0000000000000000000m",
  grantEvent: "01k5nm0000000000000000000n",
});

async function clearBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

async function withAllTriggersDropped(run: () => Promise<void>): Promise<void> {
  const triggers = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' ORDER BY name`).all<{ name: string; sql: string }>();
  for (const trigger of triggers.results) await env.DB.prepare(`DROP TRIGGER "${trigger.name}"`).run();
  try {
    await run();
  } finally {
    for (const trigger of triggers.results) await env.DB.prepare(trigger.sql).run();
  }
}

function redactPayload(value: unknown): RedactedJsonValue {
  if (typeof value === "string") {
    const result = redactor.redactText(value);
    if (!result.ok || result.text !== value) throw new Error("backup_restore_fixture_redaction_failed");
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  if (typeof value !== "object") throw new Error("backup_restore_fixture_payload_invalid");
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactPayload(child)]));
}

async function seedBaseMemory(): Promise<void> {
  const text = "Sid keeps the verified backup restore test.";
  const envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId: ids.event,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: "principal:owner",
    occurredAt: timestamp,
    receivedAt: timestamp,
    correlationId: ids.turn,
    contentType: "application/json",
    payload: redactPayload({
      schemaCode: 1,
      channelCode: 2,
      sensitivityCode: 1,
      historyEligible: true,
      text,
    }),
    producerVersion: "conversation-v1",
  });
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES ('principal:owner', 'human', 'active', 'Sid', ?, ?)`).bind(timestamp, timestamp).run();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'conversation', 'principal:owner', ?, ?, ?, ?, ?)`)
    .bind(
      ids.event,
      timestamp,
      timestamp,
      envelope.contentHash,
      canonicalJson(envelope),
      timestamp,
    ).run();
  const event = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(ids.event).first<{ sequence: number }>();
  if (event === null) throw new Error("restore fixture event missing");
  await env.DB.prepare(`INSERT INTO conversation_turns (
    turn_id, session_id, principal_id, channel, request_hash, user_event_id,
    state, created_at, updated_at
  ) VALUES (?, 'restore-session', 'principal:owner', 'telegram', ?, ?, 'user_committed', ?, ?)`)
    .bind(ids.turn, await sha256Hex("restore-request"), ids.event, timestamp, timestamp).run();
  await env.DB.prepare(`INSERT INTO memory_items (
    item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
  ) VALUES (?, 'principal:owner', 'fact', ?, ?, ?)`)
    .bind(ids.item, ids.event, event.sequence, timestamp).run();
  await env.DB.prepare(`INSERT INTO memory_item_versions (
    version_id, principal_id, item_id, version_number, text, text_normalization,
    text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
    extractor_version, extractor_model_id, created_at
  ) VALUES (?, 'principal:owner', ?, 1, ?, 'NFC', ?, 'stated',
    'authenticated_first_person', 0, 'normal', NULL, NULL, 'restore-test', NULL, ?)`)
    .bind(ids.version, ids.item, text, await sha256Hex(text), timestamp).run();
  await env.DB.prepare(`INSERT INTO memory_item_sources (
    source_id, principal_id, item_id, version_id, source_position, event_id,
    event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
    channel, occurred_at, created_at
  ) VALUES (?, 'principal:owner', ?, ?, 0, ?, ?, 'live', NULL, ?, ?, 'telegram', ?, ?)`)
    .bind(
      ids.source,
      ids.item,
      ids.version,
      ids.event,
      event.sequence,
      text,
      await sha256Hex(text),
      timestamp,
      timestamp,
    ).run();
}

async function seedPostInitialRows(): Promise<void> {
  const event = await env.DB.prepare("SELECT sequence, content_hash FROM events WHERE event_id = ?")
    .bind(ids.event).first<{ sequence: number; content_hash: string }>();
  if (event === null) throw new Error("restore fixture event missing");
  const hash = "a".repeat(64);
  await withAllTriggersDropped(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO device_keys (
        device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
        algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at
      ) VALUES ('device:restore', 'principal:owner', 'key:restore', ?, ?, 1,
        'ed25519', 'active', 'restore', ?, ?, NULL)`)
        .bind("A".repeat(43) + "=", "b".repeat(64), "c".repeat(64), oldTimestamp),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at,
        created_at, enrolled_by_device_id
      ) VALUES ('identity:restore-voice', 'principal:owner', 'voice', 'restore-voice',
        'active', ?, ?, 'device:restore')`).bind(oldTimestamp, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, 'principal:owner', ?, 1, ?, 'active', 'restore fixture',
        'rules', 'restore-v1', NULL, ?)`)
        .bind(ids.transition, ids.item, ids.version, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_item_state (
        principal_id, item_id, current_version_id, lifecycle_state,
        last_transition_id, last_transition_number, updated_at
      ) VALUES ('principal:owner', ?, ?, 'active', ?, 1, ?)`)
        .bind(ids.item, ids.version, ids.transition, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_topic_events (
        topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
        new_parent_topic_id, previous_display_name, previous_normalized_name,
        new_display_name, new_normalized_name, merge_target_topic_id,
        reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
        reason, actor, owner_authorizing_event_id, occurred_at
      ) VALUES (?, 'principal:owner', ?, 'create', NULL, NULL, NULL, NULL,
        'Restore', 'restore', NULL, '[]', '[]', '[]', 'restore fixture', 'rules', NULL, ?)`)
        .bind(ids.topicEvent, ids.topic, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_topics (
        topic_id, principal_id, parent_topic_id, display_name, normalized_name,
        status, redirect_to_topic_id, last_topic_event_id, created_at, updated_at
      ) VALUES (?, 'principal:owner', NULL, 'Restore', 'restore', 'active', NULL, ?, ?, ?)`)
        .bind(ids.topic, ids.topicEvent, oldTimestamp, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_item_placement_events (
        placement_event_id, principal_id, placement_id, placement_event_number, item_id,
        operation, previous_topic_id, new_topic_id, relation, filing_source, confidence,
        reason, owner_authorizing_event_id, occurred_at
      ) VALUES (?, 'principal:owner', ?, 1, ?, 'place', NULL, ?, 'primary', 'rule', 1.0,
        'restore fixture', NULL, ?)`)
        .bind(ids.placementEvent, ids.placement, ids.item, ids.topic, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_item_placement_state (
        principal_id, placement_id, item_id, topic_id, relation, status,
        last_event_kind, last_event_id, last_placement_event_number, updated_at
      ) VALUES ('principal:owner', ?, ?, ?, 'primary', 'active', 'placement', ?, 1, ?)`)
        .bind(ids.placement, ids.item, ids.topic, ids.placementEvent, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_model_prices (
        price_id, principal_id, provider, model_id, effective_at,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, currency, source_receipt, created_at
      ) VALUES (?, 'principal:owner', 'deepseek', 'deepseek:restore', ?, 1, 1, 1,
        'USD', 'restore fixture', ?)`)
        .bind(ids.price, oldTimestamp, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_runs (
        run_id, principal_id, run_key, job, reprocess_job_id, start_event_sequence,
        end_event_sequence, provider_model_id, price_id, input_event_count,
        created_item_count, input_tokens, output_tokens, cache_read_tokens,
        reserved_cost_micros, settled_cost_micros, outcome, started_at, completed_at, failure_code
      ) VALUES (?, 'principal:owner', 'restore-finished-run', 'distillation', NULL, 1, 1,
        'deepseek:restore', ?, 1, 0, 1, 1, 0, 5, 5, 'succeeded', ?, ?, NULL)`)
        .bind(ids.run, ids.price, oldTimestamp, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_cost_ledger (
        cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at
      ) VALUES (?, 'principal:owner', ?, 'reservation', NULL, 'deepseek', 'deepseek:restore',
        'normal_monthly', NULL, 5, ?, ?)`)
        .bind(ids.cost, ids.run, ids.price, oldTimestamp),
      env.DB.prepare(`INSERT INTO memory_distillation_event_receipts (
        receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
        disposition, skip_reason, source_location, r2_segment_id, recorded_at
      ) VALUES (?, 'principal:owner', ?, ?, ?, ?, 'eligible', NULL, 'live', NULL, ?)`)
        .bind(ids.receipt, ids.run, event.sequence, ids.event, event.content_hash, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_cursors (
        principal_id, cursor_name, current_event_sequence, updated_at
      ) VALUES ('principal:owner', 'distillation', ?, ?)`)
        .bind(event.sequence, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
        job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
        end_event_sequence, start_day, end_day, maximum_event_count,
        provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
        status, final_receipt_hash, failure_code, created_at, updated_at
      ) VALUES (?, 'principal:owner', ?, 1, 1, NULL, NULL, 1,
        'deepseek:restore', 1, 1, 1, 'succeeded', ?, NULL, ?, ?)`)
        .bind(ids.reprocess, ids.event, hash, oldTimestamp, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_literal_search_jobs (
        job_id, principal_id, job_key, attempt, query_text, query_hash,
        snapshot_event_sequence, checkpoint_event_sequence, scanned_event_count,
        matched_event_count, status, failure_code, created_at, updated_at, completed_at
      ) VALUES (?, 'principal:owner', 'restore-search', 1, 'restore', ?, ?, ?, 1,
        0, 'succeeded', NULL, ?, ?, ?)`)
        .bind(
          ids.literalSearch, await sha256Hex("restore"), event.sequence, event.sequence,
          oldTimestamp, laterOldTimestamp, laterOldTimestamp,
        ),
      env.DB.prepare(`INSERT INTO owner_passphrase_verifiers (
        owner_principal_id, owner_identity_id, verifier_version, algorithm, domain_version,
        word_list_version, pepper_version, iterations, salt, digest, status,
        created_by_device_id, created_by_key_id, created_by_key_fingerprint,
        created_by_key_generation, created_at, status_changed_at
      ) VALUES ('principal:owner', 'identity:restore-voice', 1,
        'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 'eff-long-cmudict-2026-09-v2',
        'v1', 600000, ?, ?, 'active', 'device:restore', 'key:restore', ?, 1, ?, ?)`)
        .bind(new Uint8Array(16), new Uint8Array(32), "b".repeat(64), oldTimestamp, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO voice_access_grants (
        grant_id, principal_id, identity_id, grant_version, capability_ids_json,
        resource_scopes_json, access_document_hash, pin_schema_version, pin_algorithm,
        pin_pepper_version, pin_iterations, pin_salt_base64, pin_digest_base64,
        status, created_by_identity_id, created_at, activated_at, updated_at, revoked_at
      ) VALUES (?, 'principal:owner', 'identity:restore-voice', 1, '[]', '{}', ?, '2.0',
        'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 600000, ?, ?, 'active',
        'identity:restore-voice', ?, ?, ?, NULL)`)
        .bind(ids.grant, hash, "A".repeat(24), "B".repeat(44), oldTimestamp, oldTimestamp, oldTimestamp),
      env.DB.prepare(`INSERT INTO voice_access_grant_events (
        event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
        capability_ids_json, access_document_hash, created_at
      ) VALUES (?, ?, 1, 'activated', 'identity:restore-voice', ?, '[]', ?, ?)`)
        .bind(ids.grantEvent, ids.grant, hash, hash, oldTimestamp),
      env.DB.prepare(`INSERT INTO guest_grant_notices (
        mutation_id, owner_principal_id, status, claim_id, claim_expires_at,
        provider_message_id, created_at, delivered_at
      ) VALUES (?, 'principal:owner', 'delivered', NULL, NULL, '1', ?, ?)`)
        .bind(ids.grantEvent, oldTimestamp, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO school_course_cards (
        principal_id, course_id, course_key, course_name, course_name_source,
        platform_name, platform_source, platform_source_ref, platform_observed_at,
        owner_source_turn_id, active, created_at, updated_at
      ) VALUES ('principal:owner', ?, 'restore-course', 'Restore course', 'owner_reported',
        NULL, NULL, NULL, NULL, ?, 1, ?, ?)`)
        .bind(ids.course, ids.turn, oldTimestamp, oldTimestamp),
      env.DB.prepare(`INSERT INTO school_practice_items (
        principal_id, item_id, item_key, practice_id, course_id, mode, position,
        question, answer, answer_support, source_kind, source_turn_id, source_fact_id,
        source_excerpt, source_observed_at, status, owner_answer, result,
        result_turn_id, answered_at, created_at, updated_at
      ) VALUES ('principal:owner', ?, 'restore-practice', ?, ?, 'quiz', 1,
        'Question?', 'Answer.', 'supported', 'owner_topic', ?, NULL, 'Restore source', ?,
        'answered', 'Answer.', 'easy', ?, ?, ?, ?)`)
        .bind(
          ids.practice, ids.practice, ids.course, ids.turn, oldTimestamp,
          ids.turn, laterOldTimestamp, oldTimestamp, laterOldTimestamp,
        ),
      env.DB.prepare(`INSERT INTO school_study_evidence (
        principal_id, evidence_id, source_key, course_id, topic_key, topic,
        outcome, evidence_kind, evidence_text, confidence, source_turn_id,
        source_fact_id, source_practice_item_id, observed_at, practice_due_on,
        last_prompted_on, status, control_turn_id, controlled_at, created_at, updated_at
      ) VALUES ('principal:owner', ?, 'restore-evidence', ?, 'restore-topic', 'Restore topic',
        'easy', 'practice_result', 'Restore evidence', 'high', ?, NULL, ?, ?, '2026-09-17',
        NULL, 'corrected', ?, ?, ?, ?)`)
        .bind(
          ids.evidence, ids.course, ids.turn, ids.practice, laterOldTimestamp,
          ids.turn, laterOldTimestamp, oldTimestamp, laterOldTimestamp,
        ),
    ]);
  });
}

async function rebuildHistory(): Promise<void> {
  let tick = 0;
  const archive = new ArchivalService({ database: env.DB, bucket: archiveBucket });
  const state = new ArchiveRepository(env.DB);
  const history = new LiteralHistoryService({
    database: env.DB,
    events: new TieredEventReader({
      live: new EventRepository(env.DB),
      archive,
      state,
    }),
    archive: state,
    now: () => new Date(instant.getTime()),
    nextId: () => newUlid(new Date(instant.getTime() + ++tick)),
  });
  for (let step = 0; step < 10; step += 1) {
    const result = await history.indexNext({
      principalId: "principal:owner",
      maxEvents: 16,
      maxTextBytes: 128 * 1024,
    });
    if (result.complete) return;
  }
  throw new Error("restore history rebuild did not complete");
}

async function finishBackup(): Promise<MemoryBackupRestoreManifest> {
  const backup = new MemoryBackupService({
    database: env.DB,
    bucket: backupBucket,
    clock: { now: () => new Date(instant.getTime()) },
    notice: { send: async () => undefined },
  });
  let outcome = await backup.runNightly(runDate);
  for (let invocation = 0; invocation < 80 && outcome.outcome === "pending"; invocation += 1) {
    outcome = await backup.continueActive(runDate);
  }
  expect(outcome.outcome).toBe("verified");
  const latestBody = await backupBucket.get(MEMORY_BACKUP_LATEST_KEY);
  if (latestBody === null) throw new Error("restore fixture latest pointer missing");
  const latest = JSON.parse(await latestBody.text()) as { manifestObjectKey: string };
  const manifestBody = await backupBucket.get(latest.manifestObjectKey);
  if (manifestBody === null) throw new Error("restore fixture manifest missing");
  return JSON.parse(await manifestBody.text()) as MemoryBackupRestoreManifest;
}

async function tablePrimaryKey(table: string): Promise<readonly string[]> {
  const info = await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string; pk: number }>();
  return info.results.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk).map((column) => column.name);
}

async function tableHash(table: string, omittedColumns: readonly string[] = []): Promise<string> {
  const primaryKey = await tablePrimaryKey(table);
  const rows = await env.DB.prepare(`SELECT * FROM "${table}"
    ORDER BY ${primaryKey.map((column) => `"${column}"`).join(", ")}`).all<Record<string, unknown>>();
  const normalized = rows.results.map((row) => Object.fromEntries(
    Object.entries(row).filter(([column]) => !omittedColumns.includes(column)),
  )).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return sha256Hex(canonicalJson(normalized));
}

describe("verified memory backup restore", () => {
  beforeEach(async () => {
    await clearMemoryBackupDataForTest();
    await clearBucket(backupBucket);
    await clearBucket(archiveBucket);
  });

  it("restores post-initial rows and rebuilds every excluded memory projection", async () => {
    await seedBaseMemory();
    await seedPostInitialRows();
    await rebuildHistory();
    expect(await env.DB.prepare(`SELECT outcome FROM memory_runs WHERE run_id = ?`)
      .bind(ids.run).first()).toEqual({ outcome: "succeeded" });
    expect(await env.DB.prepare(`SELECT status FROM memory_reprocess_jobs WHERE job_id = ?`)
      .bind(ids.reprocess).first()).toEqual({ status: "succeeded" });
    expect(await env.DB.prepare(`SELECT status FROM memory_literal_search_jobs WHERE job_id = ?`)
      .bind(ids.literalSearch).first()).toEqual({ status: "succeeded" });
    expect(await env.DB.prepare(`SELECT status FROM guest_grant_notices WHERE mutation_id = ?`)
      .bind(ids.grantEvent).first()).toEqual({ status: "delivered" });
    expect(await env.DB.prepare(`SELECT status FROM owner_passphrase_verifiers WHERE verifier_version = 1`)
      .first()).toEqual({ status: "active" });
    expect(await env.DB.prepare(`SELECT status FROM school_practice_items WHERE item_id = ?`)
      .bind(ids.practice).first()).toEqual({ status: "answered" });
    expect(await env.DB.prepare(`SELECT status FROM school_study_evidence WHERE evidence_id = ?`)
      .bind(ids.evidence).first()).toEqual({ status: "corrected" });

    const manifest = await finishBackup();
    const verifiedSet = await readLatestVerifiedMemoryBackup(backupBucket);
    expect(verifiedSet.manifest.runId).toBe(manifest.runId);
    const rowsByTable = verifiedSet.rowsByTable;
    const sampledTables = [
      "events",
      "conversation_turns",
      "memory_runs",
      "memory_cost_ledger",
      "memory_topic_events",
      "guest_grant_notices",
      "owner_passphrase_verifiers",
      "memory_reprocess_jobs",
      "memory_literal_search_jobs",
      "school_practice_items",
      "school_study_evidence",
    ] as const;
    const expectedHashes = new Map<string, string>();
    for (const table of sampledTables) {
      expectedHashes.set(table, await sha256Hex(canonicalJson(rowsByTable.get(table) ?? [])));
    }
    const derivedSamples = new Map<string, readonly string[]>([
      ["memory_item_state", []],
      ["memory_item_placement_state", []],
      ["memory_history_chunks", ["chunk_rowid", "chunk_id"]],
      ["memory_history_coverage", ["coverage_id"]],
    ]);
    const expectedDerived = new Map<string, string>();
    for (const [table, omittedColumns] of derivedSamples) {
      expectedDerived.set(table, await tableHash(table, omittedColumns));
    }

    await recreateFreshDatabaseForBackupRestoreTest();
    expect(await env.DB.prepare("PRAGMA foreign_keys").first("foreign_keys")).toBe(1);
    let historyRan = false;
    let vectorsRan = false;
    const report = await restoreVerifiedMemoryBackupRows({
      database: env.DB,
      databaseSchemaVersion: manifest.databaseSchemaVersion,
      rowsByTable,
      migrationSql: migrationSources,
      jobs: {
        rebuildHistory: async () => {
          historyRan = true;
          await rebuildHistory();
        },
        rebuildVectors: async () => {
          vectorsRan = true;
          expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_vectors").first())
            .toEqual({ count: 0 });
        },
      },
      shortfalls: Object.fromEntries(manifest.tableCuts.map((cut) => [cut.table, cut.shortfallRowCount])),
    });
    expect(historyRan).toBe(true);
    expect(vectorsRan).toBe(true);
    expect(report.rebuiltItemStates).toBe(1);
    expect(report.rebuiltPlacementStates).toBe(1);
    expect(report.rebuiltCursors).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });

    for (const cut of manifest.tableCuts) {
      if (!MEMORY_BACKUP_TABLES.includes(cut.table)) continue;
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM "${cut.table}"`).first(), cut.table)
        .toEqual({ count: cut.exportedRowCount });
    }
    for (const table of sampledTables) {
      expect(await tableHash(table), table).toBe(expectedHashes.get(table));
    }
    for (const [table, expected] of expectedDerived) {
      expect(await tableHash(table, derivedSamples.get(table)), table).toBe(expected);
    }
    expect(await env.DB.prepare(`SELECT cursor_name, current_event_sequence FROM memory_cursors
      WHERE principal_id = 'principal:owner' ORDER BY cursor_name`).all()).toMatchObject({ results: [
      { cursor_name: "distillation", current_event_sequence: 1 },
      { cursor_name: "fts_history", current_event_sequence: 1 },
      { cursor_name: "fts_items", current_event_sequence: 1 },
    ] });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'trigger'`).first()).not.toEqual({ count: 0 });
  }, 300_000);
});
