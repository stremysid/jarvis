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
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import {
  cacheVerifiedMemoryBackupSet,
  continueVerifiedMemoryBackupRestore,
  finalizeVerifiedMemoryBackupRestore,
  readLatestVerifiedMemoryBackup,
  restoreVerifiedMemoryBackupRows,
  type MemoryBackupRestoreManifest,
  type MemoryBackupRestorePointer,
} from "../../src/backup/memory-backup-restore.js";
import memoryBackupRestoreOperator from "../../src/backup/memory-backup-restore-operator.js";
import {
  MEMORY_BACKUP_LATEST_KEY,
  MEMORY_BACKUP_SELF_REFERENCES,
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
const namedMigrationSources = Object.entries(migrationSql)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, sql]) => Object.freeze({ name: path.split("/").at(-1)!, sql }));
const migrationSources = namedMigrationSources.map(({ sql }) => sql);

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
  itemReceipt: "01k5nm0000000000000000000p",
  event2: "01k5nm0000000000000000000q",
  event3: "01k5nm0000000000000000000r",
  run2: "01k5nm0000000000000000000s",
  run3: "01k5nm0000000000000000000t",
  receipt2: "01k5nm0000000000000000000v",
  receipt3: "01k5nm0000000000000000000w",
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
  const event2Envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId: ids.event2,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: "principal:owner",
    occurredAt: oldTimestamp,
    receivedAt: oldTimestamp,
    correlationId: newUlid(),
    contentType: "application/json",
    payload: redactPayload({
      schemaCode: 1, channelCode: 2, sensitivityCode: 1,
      historyEligible: true, text: "second restore event",
    }),
    producerVersion: "conversation-v1",
  });
  const event3Envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId: ids.event3,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: "principal:owner",
    occurredAt: oldTimestamp,
    receivedAt: oldTimestamp,
    correlationId: newUlid(),
    contentType: "application/json",
    payload: redactPayload({
      schemaCode: 1, channelCode: 2, sensitivityCode: 1,
      historyEligible: true, text: "failed restore event",
    }),
    producerVersion: "conversation-v1",
  });
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
      env.DB.prepare(`INSERT INTO events (
        sequence, event_id, event_type, source, subject_id, occurred_at, received_at,
        content_hash, envelope_json, created_at
      ) VALUES (2, ?, 'conversation.user_committed', 'conversation', 'principal:owner',
        ?, ?, ?, ?, ?)`)
        .bind(
          ids.event2, oldTimestamp, oldTimestamp, event2Envelope.contentHash,
          canonicalJson(event2Envelope), oldTimestamp,
        ),
      env.DB.prepare(`INSERT INTO events (
        sequence, event_id, event_type, source, subject_id, occurred_at, received_at,
        content_hash, envelope_json, created_at
      ) VALUES (3, ?, 'conversation.user_committed', 'conversation', 'principal:owner',
        ?, ?, ?, ?, ?)`)
        .bind(
          ids.event3, oldTimestamp, oldTimestamp, event3Envelope.contentHash,
          canonicalJson(event3Envelope), oldTimestamp,
        ),
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
      env.DB.prepare(`INSERT INTO memory_distillation_item_receipts (
        receipt_id, principal_id, run_id, item_id, proposal_hash, created_in_run, recorded_at
      ) VALUES (?, 'principal:owner', ?, ?, ?, 0, ?)`)
        .bind(ids.itemReceipt, ids.run, ids.item, "d".repeat(64), laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_runs (
        run_id, principal_id, run_key, job, reprocess_job_id, start_event_sequence,
        end_event_sequence, provider_model_id, price_id, input_event_count,
        created_item_count, input_tokens, output_tokens, cache_read_tokens,
        reserved_cost_micros, settled_cost_micros, outcome, started_at, completed_at, failure_code
      ) VALUES (?, 'principal:owner', 'restore-second-run', 'distillation', NULL, 2, 2,
        'deepseek:restore', ?, 1, 0, 0, 0, 0, 0, 0, 'nothing_new', ?, ?, NULL)`)
        .bind(ids.run2, ids.price, oldTimestamp, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_distillation_event_receipts (
        receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
        disposition, skip_reason, source_location, r2_segment_id, recorded_at
      ) VALUES (?, 'principal:owner', ?, 2, ?, ?, 'skipped', 'history_ineligible', 'live', NULL, ?)`)
        .bind(ids.receipt2, ids.run2, ids.event2, event2Envelope.contentHash, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_runs (
        run_id, principal_id, run_key, job, reprocess_job_id, start_event_sequence,
        end_event_sequence, provider_model_id, price_id, input_event_count,
        created_item_count, input_tokens, output_tokens, cache_read_tokens,
        reserved_cost_micros, settled_cost_micros, outcome, started_at, completed_at, failure_code
      ) VALUES (?, 'principal:owner', 'restore-failed-run', 'distillation', NULL, 3, 3,
        'deepseek:restore', ?, 1, 0, 0, 0, 0, 0, 0, 'failed', ?, ?, 'provider_timeout')`)
        .bind(ids.run3, ids.price, oldTimestamp, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_distillation_event_receipts (
        receipt_id, principal_id, run_id, event_sequence, event_id, content_hash,
        disposition, skip_reason, source_location, r2_segment_id, recorded_at
      ) VALUES (?, 'principal:owner', ?, 3, ?, ?, 'eligible', NULL, 'live', NULL, ?)`)
        .bind(ids.receipt3, ids.run3, ids.event3, event3Envelope.contentHash, laterOldTimestamp),
      env.DB.prepare(`INSERT INTO memory_cursors (
        principal_id, cursor_name, current_event_sequence, updated_at
      ) VALUES ('principal:owner', 'distillation', ?, ?)`)
        .bind(2, laterOldTimestamp),
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

function countingDatabase(counter: { statements: number; sql: string[] }): D1Database {
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        counter.statements += 1;
        counter.sql.push(sql);
        return target.prepare(sql);
      };
      if (property === "batch") return async (statements: D1PreparedStatement[]) => target.batch(statements);
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

function countingBucket(bucket: R2Bucket, gets: Map<string, number>): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "get") return async (key: string, options?: R2GetOptions) => {
        gets.set(key, (gets.get(key) ?? 0) + 1);
        return target.get(key, options);
      };
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as R2Bucket;
}

async function seedGuestCallBeyondOneRestorePage(): Promise<string> {
  const hash = "a".repeat(64);
  const sessionId = newUlid(new Date("2026-09-15T13:00:00.000Z"));
  await withAllTriggersDropped(async () => {
    const grantEvents = Array.from({ length: 80 }, (_, index) => {
      const at = new Date(Date.parse("2026-09-15T12:10:00.000Z") + index).toISOString();
      return env.DB.prepare(`INSERT INTO voice_access_grant_events (
        event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
        capability_ids_json, access_document_hash, created_at
      ) VALUES (?, ?, ?, 'permissions_replaced', 'identity:restore-voice', ?, '[]', ?, ?)`)
        .bind(newUlid(new Date(at)), ids.grant, index + 2, hash, hash, at);
    });
    await env.DB.batch([
      ...grantEvents,
      env.DB.prepare(`INSERT INTO call_sessions (
        session_id, call_sid, expected_attempt_id, principal_id, identity_id,
        destination_identity_id, direction, activation_only, activation_challenge_id,
        activation_hmac_key_version, relay_nonce, nonce_expires_at,
        relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
        access_kind, guest_grant_id, guest_grant_version, access_document_hash,
        provider_connected_at
      ) VALUES (?, ?, NULL, 'principal:owner', 'identity:restore-voice',
        'identity:restore-voice', 'inbound', 0, NULL, NULL, ?, ?, ?, NULL,
        'completed', ?, ?, 'guest', ?, 1, ?, NULL)`)
        .bind(
          sessionId,
          `CA${"1".repeat(32)}`,
          "A".repeat(43),
          "2026-09-15T13:01:00.000Z",
          "2026-09-15T13:01:00.000Z",
          "2026-09-15T13:00:00.000Z",
          "2026-09-15T13:01:00.000Z",
          ids.grant,
          hash,
        ),
    ]);
  });
  return sessionId;
}

async function seedMergedTopicBeyondOneRestorePage(): Promise<Readonly<{
  older: string;
  newer: string;
}>> {
  const base = Date.parse("2026-09-15T14:00:00.000Z");
  const older = newUlid(new Date(base));
  const between = Array.from({ length: 80 }, (_, index) => newUlid(new Date(base + index + 1)));
  const newer = newUlid(new Date(base + 1_000));
  const insert = (
    topicId: string,
    name: string,
    status: "active" | "merged",
    redirect: string | null,
    offset: number,
  ) => env.DB.prepare(`INSERT INTO memory_topics (
      topic_id, principal_id, parent_topic_id, display_name, normalized_name,
      status, redirect_to_topic_id, last_topic_event_id, created_at, updated_at
    ) VALUES (?, 'principal:owner', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      topicId,
      ids.topic,
      name,
      name.toLowerCase(),
      status,
      redirect,
      newUlid(new Date(base + 2_000 + offset)),
      new Date(base + offset).toISOString(),
      new Date(base + 3_000 + offset).toISOString(),
  );
  await withAllTriggersDropped(async () => {
    await env.DB.batch([
      insert(older, "Older topic", "active", null, 0),
      ...between.map((topicId, index) => insert(
        topicId, `Between topic ${index}`, "active", null, index + 1,
      )),
      insert(newer, "Newer topic", "active", null, 1_000),
      env.DB.prepare(`UPDATE memory_topics SET status = 'merged',
        redirect_to_topic_id = ?, updated_at = ? WHERE topic_id = ?`)
        .bind(newer, new Date(base + 4_000).toISOString(), older),
    ]);
  });
  return Object.freeze({ older, newer });
}

describe("verified memory backup restore", () => {
  beforeEach(async () => {
    await recreateFreshDatabaseForBackupRestoreTest();
    await clearMemoryBackupDataForTest();
    await clearBucket(backupBucket);
    await clearBucket(archiveBucket);
  });

  it("orders every authoritative table after its foreign-key targets and inventories every nullable self-reference", async () => {
    const order = new Map<string, number>(MEMORY_BACKUP_TABLES.map((table, index) => [table, index]));
    const nullableSelfReferences = new Set<string>();
    for (const table of MEMORY_BACKUP_TABLES) {
      const foreignKeys = await env.DB.prepare(`PRAGMA foreign_key_list("${table}")`)
        .all<{ table: string; from: string; to: string }>();
      const columns = await env.DB.prepare(`PRAGMA table_info("${table}")`)
        .all<{ name: string; notnull: number }>();
      const nullable = new Set(columns.results.filter(({ notnull }) => notnull === 0)
        .map(({ name }) => name));
      for (const foreignKey of foreignKeys.results) {
        if (foreignKey.table === table) {
          if (nullable.has(foreignKey.from)) {
            nullableSelfReferences.add(`${table}.${foreignKey.from}->${foreignKey.to}`);
          }
          continue;
        }
        expect(order.has(foreignKey.table), `${table}.${foreignKey.from} target`).toBe(true);
        expect(order.get(foreignKey.table), `${table}.${foreignKey.from}->${foreignKey.table}`)
          .toBeLessThan(order.get(table)!);
      }
    }
    const declared = MEMORY_BACKUP_SELF_REFERENCES.flatMap(({ table, keyColumn, referenceColumns }) =>
      referenceColumns.map((column) => `${table}.${column}->${keyColumn}`));
    expect([...nullableSelfReferences].sort()).toEqual([...declared].sort());
  });

  it("downloads and hashes each verified object once before later restore steps use the durable cache", async () => {
    await seedBaseMemory();
    const manifest = await finishBackup();
    const latestBody = await backupBucket.get(MEMORY_BACKUP_LATEST_KEY);
    if (latestBody === null) throw new Error("restore fixture latest pointer missing");
    const pointer = JSON.parse(await latestBody.text()) as MemoryBackupRestorePointer;
    await recreateFreshDatabaseForBackupRestoreTest();
    const gets = new Map<string, number>();
    const bucket = countingBucket(backupBucket, gets);
    let cached = await cacheVerifiedMemoryBackupSet({
      database: env.DB,
      bucket,
      pointer,
      migrationSql: namedMigrationSources,
      maxObjectsPerStep: 2,
    });
    for (let step = 0; step < 500 && cached.outcome === "pending"; step += 1) {
      cached = await cacheVerifiedMemoryBackupSet({
        database: env.DB,
        bucket,
        pointer,
        migrationSql: namedMigrationSources,
        maxObjectsPerStep: 2,
      });
    }
    expect(cached.outcome).toBe("ready");
    const repeated = await cacheVerifiedMemoryBackupSet({
      database: env.DB,
      bucket,
      pointer,
      migrationSql: namedMigrationSources,
      maxObjectsPerStep: 2,
    });
    expect(repeated.outcome).toBe("ready");
    expect(gets.get(pointer.manifestObjectKey)).toBe(1);
    for (const object of manifest.objects) {
      expect(gets.get(object.objectKey), object.objectKey).toBe(1);
    }
    expect([...gets.values()].reduce((sum, count) => sum + count, 0))
      .toBe(manifest.objects.length + 1);
    expect(await env.DB.prepare(`SELECT state, next_object_index, set_hash
      FROM memory_backup_restore_cache_progress WHERE singleton = 1`).first())
      .toMatchObject({ state: "ready", next_object_index: manifest.objects.length });
  }, 300_000);

  it("restores 5,000 rows through bounded operator steps without reading an R2 object twice", async () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => env.DB.prepare(`INSERT INTO consumer_cursors (
      consumer_name, current_sequence, updated_at
    ) VALUES (?, ?, ?)`)
      .bind(`restore-measure-${index.toString().padStart(4, "0")}`, index, timestamp));
    for (let offset = 0; offset < rows.length; offset += 100) {
      await env.DB.batch(rows.slice(offset, offset + 100));
    }
    const manifest = await finishBackup();
    const latestBody = await backupBucket.get(MEMORY_BACKUP_LATEST_KEY);
    if (latestBody === null) throw new Error("restore fixture latest pointer missing");
    const pointer = JSON.parse(await latestBody.text()) as MemoryBackupRestorePointer;
    await recreateFreshDatabaseForBackupRestoreTest();
    const gets = new Map<string, number>();
    const token = `${newUlid()}${newUlid()}`;
    const operatorEnvironment = {
      DB: env.DB,
      ARCHIVE: archiveBucket,
      BACKUP: countingBucket(backupBucket, gets),
      RESTORE_TARGET_DATABASE_NAME: "jarvis-memory-restore-scratch",
      RESTORE_CONFIRMED_DATABASE_NAME: "jarvis-memory-restore-scratch",
      RESTORE_OPERATOR_TOKEN: token,
      RESTORE_RUN_DATE: pointer.runDate,
      RESTORE_RUN_ID: pointer.runId,
      RESTORE_MANIFEST_OBJECT_KEY: pointer.manifestObjectKey,
      RESTORE_MANIFEST_SHA256: pointer.manifestSha256,
    };
    const headers = { authorization: `Bearer ${token}` };
    const startedAt = performance.now();
    let steps = 0;
    let result: Record<string, unknown> = {};
    for (; steps < 500; steps += 1) {
      const response = await memoryBackupRestoreOperator.fetch(
        new Request("https://restore.invalid/step", { method: "POST", headers }),
        operatorEnvironment,
      );
      result = await response.json() as Record<string, unknown>;
      expect(response.status, JSON.stringify(result)).toBe(200);
      if (result.outcome === "complete") {
        steps += 1;
        break;
      }
      expect(result.outcome).toBe("pending");
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    expect(result.outcome).toBe("complete");
    expect((result.report as { restoredRows: Record<string, number> }).restoredRows.consumer_cursors)
      .toBe(5_000);
    expect(steps).toBeLessThan(200);
    expect(gets.get(pointer.manifestObjectKey)).toBe(1);
    for (const object of manifest.objects) expect(gets.get(object.objectKey), object.objectKey).toBe(1);
    console.log("5,000-row restore", JSON.stringify({ steps, elapsedMs, objects: manifest.objects.length }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const finalized = await memoryBackupRestoreOperator.fetch(
        new Request("https://restore.invalid/finalize", {
          method: "POST",
          headers: { ...headers, "x-restore-id": pointer.runId },
        }),
        operatorEnvironment,
      );
      expect(finalized.status).toBe(200);
      await expect(finalized.json()).resolves.toMatchObject({
        outcome: "finalized",
        restoreId: pointer.runId,
      });
    }
  }, 300_000);

  it("restores a guest call whose voice grant is more than one page earlier", async () => {
    await seedBaseMemory();
    await seedPostInitialRows();
    const sessionId = await seedGuestCallBeyondOneRestorePage();
    const manifest = await finishBackup();
    const set = await readLatestVerifiedMemoryBackup(backupBucket);
    const rows = MEMORY_BACKUP_TABLES.flatMap((table) =>
      (set.rowsByTable.get(table) ?? []).map((row) => ({ table, row })));
    const grantIndex = rows.findIndex(({ table, row }) =>
      table === "voice_access_grants" && row.grant_id === ids.grant);
    const callIndex = rows.findIndex(({ table, row }) =>
      table === "call_sessions" && row.session_id === sessionId);
    expect(callIndex - grantIndex).toBeGreaterThan(64);
    await recreateFreshDatabaseForBackupRestoreTest();
    await restoreVerifiedMemoryBackupRows({
      database: env.DB,
      databaseSchemaVersion: manifest.databaseSchemaVersion,
      rowsByTable: set.rowsByTable,
      migrationSql: namedMigrationSources,
      restoreId: manifest.runId,
      jobs: { rebuildHistory: async () => undefined, rebuildVectors: async () => undefined },
    });
    expect(await env.DB.prepare(`SELECT guest_grant_id FROM call_sessions WHERE session_id = ?`)
      .bind(sessionId).first()).toEqual({ guest_grant_id: ids.grant });
  }, 300_000);

  it("restores a merged topic whose redirect target is more than one page later", async () => {
    await seedBaseMemory();
    await seedPostInitialRows();
    const { older, newer } = await seedMergedTopicBeyondOneRestorePage();
    const manifest = await finishBackup();
    const set = await readLatestVerifiedMemoryBackup(backupBucket);
    const topics = set.rowsByTable.get("memory_topics") ?? [];
    expect(topics.findIndex((row) => row.topic_id === newer)
      - topics.findIndex((row) => row.topic_id === older)).toBeGreaterThan(64);
    await recreateFreshDatabaseForBackupRestoreTest();
    await restoreVerifiedMemoryBackupRows({
      database: env.DB,
      databaseSchemaVersion: manifest.databaseSchemaVersion,
      rowsByTable: set.rowsByTable,
      migrationSql: namedMigrationSources,
      restoreId: manifest.runId,
      jobs: { rebuildHistory: async () => undefined, rebuildVectors: async () => undefined },
    });
    expect(await env.DB.prepare(`SELECT status, redirect_to_topic_id FROM memory_topics
      WHERE topic_id = ?`).bind(older).first()).toEqual({
      status: "merged",
      redirect_to_topic_id: newer,
    });
  }, 300_000);

  it("restores post-initial rows and rebuilds every excluded memory projection", async () => {
    await seedBaseMemory();
    await seedPostInitialRows();
    await new AutonomyRepository(env.DB).setMode("live", timestamp);
    await env.DB.prepare(`UPDATE outbound_runtime_controls
      SET enabled = 1, quiet_starts_at = ?, quiet_ends_at = ? WHERE singleton_id = 1`)
      .bind("2026-09-17T01:00:00.000Z", "2026-09-17T02:00:00.000Z").run();
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
    const sourceCursors = await env.DB.prepare(`SELECT cursor_name, current_event_sequence
      FROM memory_cursors WHERE principal_id = 'principal:owner' ORDER BY cursor_name`)
      .all<{ cursor_name: string; current_event_sequence: number }>();
    expect(sourceCursors.results.map((row) => row.cursor_name)).toEqual([
      "distillation",
      "fts_history",
    ]);

    const manifest = await finishBackup();
    const verifiedSet = await readLatestVerifiedMemoryBackup(backupBucket);
    expect(verifiedSet.manifest.runId).toBe(manifest.runId);
    const rowsByTable = verifiedSet.rowsByTable;
    const sampledTables = [
      "events",
      "capability_tiers",
      "autonomy_mode",
      "outbound_runtime_controls",
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
      expectedHashes.set(table, await tableHash(table));
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
      WHERE principal_id = 'principal:owner' ORDER BY cursor_name`).all()).toMatchObject({
      results: sourceCursors.results,
    });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'trigger'`).first()).not.toEqual({ count: 0 });
  }, 300_000);

  it("resumes after triggers were dropped and keeps every continuation well below the D1 query limit", async () => {
    await seedBaseMemory();
    await seedPostInitialRows();
    await rebuildHistory();
    const manifest = await finishBackup();
    const set = await readLatestVerifiedMemoryBackup(backupBucket);
    await recreateFreshDatabaseForBackupRestoreTest();
    const laterMigration = `CREATE TABLE zz_later_table (id INTEGER PRIMARY KEY);

CREATE TRIGGER zz_later_table_guard
BEFORE INSERT ON zz_later_table
BEGIN
  SELECT RAISE(ABORT, 'zz') WHERE NEW.id < 0;
END;
`;
    let outcome: Awaited<ReturnType<typeof continueVerifiedMemoryBackupRestore>> = {
      outcome: "pending",
      phase: "drop_triggers",
      itemIndex: 0,
    };
    let maxStatements = 0;
    let sawDroppedTriggerWindow = false;
    for (let invocation = 0; invocation < 200 && outcome.outcome === "pending"; invocation += 1) {
      const counter = { statements: 0, sql: [] as string[] };
      outcome = await continueVerifiedMemoryBackupRestore({
        database: countingDatabase(counter),
        databaseSchemaVersion: manifest.databaseSchemaVersion,
        rowsByTable: set.rowsByTable,
        migrationSql: [...migrationSources, laterMigration],
        restoreId: manifest.runId,
        maxStatementsPerStep: 32,
        jobs: { rebuildHistory, rebuildVectors: async () => undefined },
        shortfalls: Object.fromEntries(manifest.tableCuts.map((cut) => [cut.table, cut.shortfallRowCount])),
      });
      maxStatements = Math.max(maxStatements, counter.statements);
      if (outcome.outcome === "pending" && outcome.phase === "drop_triggers" && outcome.itemIndex > 0) {
        sawDroppedTriggerWindow = true;
      }
    }
    expect(outcome.outcome).toBe("complete");
    expect(sawDroppedTriggerWindow).toBe(true);
    expect(maxStatements).toBeLessThan(250);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'zz_later_table_guard'`).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'trigger'`).first()).not.toEqual({ count: 0 });
    await finalizeVerifiedMemoryBackupRestore(env.DB, manifest.runId);
    expect(await env.DB.prepare(`SELECT finalized FROM memory_backup_restore_progress
      WHERE singleton = 1`).first()).toEqual({ finalized: 1 });
  }, 300_000);

  it("refuses a non-fresh target before its first DDL", async () => {
    await seedBaseMemory();
    const manifest = await finishBackup();
    const set = await readLatestVerifiedMemoryBackup(backupBucket);
    const counter = { statements: 0, sql: [] as string[] };
    await expect(continueVerifiedMemoryBackupRestore({
      database: countingDatabase(counter),
      databaseSchemaVersion: manifest.databaseSchemaVersion,
      rowsByTable: set.rowsByTable,
      migrationSql: migrationSources,
      restoreId: manifest.runId,
      jobs: { rebuildHistory, rebuildVectors: async () => undefined },
    })).rejects.toThrow(/memory_backup_restore_target_not_fresh/u);
    expect(counter.sql.some((sql) => /^DROP TRIGGER/u.test(sql))).toBe(false);
    expect(counter.sql.some((sql) => /^CREATE TABLE memory_backup_restore_progress/u.test(sql))).toBe(false);
    expect(await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'memory_backup_restore_progress'`).first()).toBeNull();
  }, 300_000);

  it("refuses incompatible or changed sets before any new DDL at every resumable boundary", async () => {
    await seedBaseMemory();
    const manifest = await finishBackup();
    const set = await readLatestVerifiedMemoryBackup(backupBucket);
    const differentRestoreId = newUlid(new Date("2026-09-17T00:00:00.000Z"));
    const makeOptions = (
      database: D1Database,
      overrides: Readonly<{
        databaseSchemaVersion?: string;
        rowsByTable?: typeof set.rowsByTable;
        restoreId?: string;
      }> = {},
    ) => ({
      database,
      databaseSchemaVersion: overrides.databaseSchemaVersion ?? manifest.databaseSchemaVersion,
      rowsByTable: overrides.rowsByTable ?? set.rowsByTable,
      migrationSql: namedMigrationSources,
      restoreId: overrides.restoreId ?? manifest.runId,
      maxStatementsPerStep: 8,
      jobs: { rebuildHistory: async () => undefined, rebuildVectors: async () => undefined },
    });
    const attempt = async (
      options: ReturnType<typeof makeOptions>,
      expected: RegExp,
    ) => {
      const counter = { statements: 0, sql: [] as string[] };
      await expect(continueVerifiedMemoryBackupRestore({
        ...options,
        database: countingDatabase(counter),
      })).rejects.toThrow(expected);
      expect(counter.sql.filter((sql) => /^(?:ALTER|CREATE|DROP)\s/iu.test(sql))).toEqual([]);
    };

    await recreateFreshDatabaseForBackupRestoreTest();
    await attempt(makeOptions(env.DB, { databaseSchemaVersion: "0037_future.sql" }), /schema_mismatch/u);

    await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES ('0037_future.sql')").run();
    await attempt(makeOptions(env.DB, { databaseSchemaVersion: "0037_future.sql" }), /migrations_missing/u);
    await attempt(makeOptions(env.DB), /schema_mismatch/u);

    await recreateFreshDatabaseForBackupRestoreTest();
    for (let invocation = 0; invocation < 500; invocation += 1) {
      const outcome = await continueVerifiedMemoryBackupRestore(makeOptions(env.DB));
      if (outcome.outcome === "pending" && outcome.phase === "insert_rows" && outcome.itemIndex > 0) break;
    }
    expect(await env.DB.prepare(`SELECT phase FROM memory_backup_restore_progress
      WHERE singleton = 1`).first()).toEqual({ phase: "insert_rows" });
    await attempt(makeOptions(env.DB, { restoreId: differentRestoreId }), /progress_mismatch/u);

    const tamperedRows = new Map(set.rowsByTable);
    tamperedRows.set("principals", (set.rowsByTable.get("principals") ?? []).map((row) => ({
      ...row,
      display_name: "Changed after verification",
    })));
    await attempt(makeOptions(env.DB, { rowsByTable: tamperedRows }), /progress_mismatch/u);

    for (let invocation = 0; invocation < 2_000; invocation += 1) {
      const outcome = await continueVerifiedMemoryBackupRestore(makeOptions(env.DB));
      if (outcome.outcome === "complete") break;
    }
    expect(await env.DB.prepare(`SELECT phase FROM memory_backup_restore_progress
      WHERE singleton = 1`).first()).toEqual({ phase: "complete" });
    await attempt(makeOptions(env.DB, { restoreId: differentRestoreId }), /progress_mismatch/u);
  }, 300_000);

  it("refuses an unclassified live trigger before the restore creates or drops anything", async () => {
    await seedBaseMemory();
    const manifest = await finishBackup();
    const set = await readLatestVerifiedMemoryBackup(backupBucket);
    await recreateFreshDatabaseForBackupRestoreTest();
    await env.DB.prepare(`CREATE TRIGGER restore_unclassified_trigger
      BEFORE INSERT ON principals BEGIN SELECT 1; END`).run();
    const counter = { statements: 0, sql: [] as string[] };
    await expect(continueVerifiedMemoryBackupRestore({
      database: countingDatabase(counter),
      databaseSchemaVersion: manifest.databaseSchemaVersion,
      rowsByTable: set.rowsByTable,
      migrationSql: namedMigrationSources,
      restoreId: manifest.runId,
      jobs: { rebuildHistory: async () => undefined, rebuildVectors: async () => undefined },
    })).rejects.toThrow(/trigger_classification_invalid/u);
    expect(counter.sql.filter((sql) => /^(?:ALTER|CREATE|DROP)\s/iu.test(sql))).toEqual([]);
    expect(await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'memory_backup_restore_progress'`).first()).toBeNull();
  }, 300_000);
});
