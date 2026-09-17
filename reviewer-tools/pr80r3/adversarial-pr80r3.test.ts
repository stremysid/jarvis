import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type PersistableEventEnvelopeV1,
  type RedactedJsonValue,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import {
  readLatestVerifiedMemoryBackup,
  restoreVerifiedMemoryBackupRows,
  type VerifiedMemoryBackupSet,
} from "../../src/backup/memory-backup-restore.js";
import {
  MEMORY_BACKUP_TABLES,
  MemoryBackupService,
} from "../../src/backup/memory-backup.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import type { ConversationDeliveryId } from "../../src/conversation/conversation-types.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { buildJobTable, type JobEnvironment } from "../../src/jobs/job-table.js";
import { AutomaticMemoryDistillationWorkflow } from "../../src/memory/automatic-distillation.js";
import { LiteralHistoryService } from "../../src/memory/literal-history.js";
import { MemoryOwnerControlsService } from "../../src/memory/memory-owner-controls.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import type { MemoryControlIntent, MemoryOwnerTurnInput } from "../../src/memory/memory-types.js";
import { EventRepository, type AppendedEvent } from "../../src/persistence/event-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { ProviderFailure } from "../../src/providers/provider-types.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import { recreateFreshDatabaseForBackupRestoreTest } from "../persistence/migration.js";

const OWNER = "principal:owner";
const MODEL_ID = "openai:fake-memory-distillation-v1";
const backupBucket = env.BACKUP as R2Bucket;
const archiveBucket = env.ARCHIVE as R2Bucket;
const redactor = new Redactor();
const migrationSql = import.meta.glob("../../src/persistence/migrations/*.sql", {
  eager: true, import: "default", query: "?raw",
}) as Record<string, string>;
const migrationSources = Object.entries(migrationSql).sort(([l], [r]) => l.localeCompare(r)).map(([, sql]) => sql);

type Row = Record<string, unknown>;

async function clearBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

async function fresh(): Promise<void> {
  await recreateFreshDatabaseForBackupRestoreTest();
  await clearBucket(backupBucket);
  await clearBucket(archiveBucket);
}

function redactPayload(value: unknown): RedactedJsonValue {
  if (typeof value === "string") {
    const result = redactor.redactText(value);
    if (!result.ok || result.text !== value) throw new Error("fixture_redaction_failed");
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, redactPayload(v)]));
}

async function seedOwner(): Promise<void> {
  const timestamp = new Date(Date.now() - 3_600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?1, 'human', 'active', 'Sid', ?2, ?2)`).bind(OWNER, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES ('identity:telegram', ?1, 'telegram', '44112233', 'active', ?2, ?2)`).bind(OWNER, timestamp),
  ]);
}

async function appendConversation(text: string): Promise<AppendedEvent> {
  const now = new Date().toISOString();
  const eventId = newUlid();
  const envelope: PersistableEventEnvelopeV1 = await createEnvelope({
    schemaVersion: "1.0", eventId, eventType: "conversation.user_committed", source: "conversation",
    subjectId: OWNER, occurredAt: now, receivedAt: now, correlationId: newUlid(), contentType: "application/json",
    payload: redactPayload({ schemaCode: 1, channelCode: 2, sensitivityCode: 1, historyEligible: true, text, directOwnerText: true }),
    producerVersion: "conversation-v1",
  });
  return new EventRepository(env.DB).append({
    envelope, scope: "adversarial-pr80r3", key: eventId, requestHash: await sha256Hex(canonicalJson([eventId, text])),
  });
}

function proposal(event: AppendedEvent, text: string): Row {
  return { text, sourceEventIds: [event.envelope.eventId], sourceExcerpts: [{ sourceEventId: event.envelope.eventId, excerpt: text }], confidence: 0.95, sensitivity: "normal" };
}

function distiller(provider: FakeModelProvider, database: D1Database = env.DB): AutomaticMemoryDistillationWorkflow {
  const archive = new ArchivalService({ database, bucket: archiveBucket });
  return new AutomaticMemoryDistillationWorkflow({
    database,
    events: new TieredEventReader({ live: new EventRepository(database), archive, state: new ArchiveRepository(database) }),
    repository: new MemoryRepository(database, { archivedEventReader: archive }),
    provider, providerModelId: MODEL_ID, principalId: OWNER, now: () => new Date(),
  });
}

async function distilToEnd(provider: FakeModelProvider, label: string): Promise<void> {
  for (let step = 0; step < 12; step += 1) {
    const result = await distiller(provider).runNext({ runKey: `${label}:${step}:${newUlid()}` });
    if (result.outcome !== "succeeded" && result.outcome !== "nothing_new") throw new Error(`distil ${label} ${result.outcome} ${result.failureCode}`);
    if (result.backlogEventCount === 0) return;
  }
  throw new Error(`distil ${label} did not finish`);
}

async function indexHistory(): Promise<void> {
  const archive = new ArchivalService({ database: env.DB, bucket: archiveBucket });
  const state = new ArchiveRepository(env.DB);
  const history = new LiteralHistoryService({
    database: env.DB,
    events: new TieredEventReader({ live: new EventRepository(env.DB), archive, state }),
    archive: state, now: () => new Date(), nextId: () => newUlid(),
  });
  for (let step = 0; step < 60; step += 1) {
    const result = await history.indexNext({ principalId: OWNER, maxEvents: 8, maxTextBytes: 128 * 1024 });
    if (result.complete) return;
  }
  throw new Error("history did not complete");
}

let turnClock = 0;
async function ownerTurn(text: string, memoryIntent: MemoryControlIntent): Promise<MemoryOwnerTurnInput> {
  turnClock = Math.max(turnClock + 10, Date.now());
  const eventId = newUlid(new Date(turnClock));
  const occurredAt = new Date(turnClock).toISOString();
  const payload = { schemaCode: 1, channelCode: 2, sensitivityCode: 1, historyEligible: true, text };
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = {
    schemaVersion: "1.0", eventId, eventType: "conversation.user_committed", source: "conversation", subjectId: OWNER,
    occurredAt, receivedAt: occurredAt, correlationId: newUlid(new Date(turnClock + 1)), contentType: "application/json",
    contentHash, payload, redaction: { status: "none", markers: [] }, producerVersion: "conversation-v1",
  };
  await env.DB.prepare(`INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at)
    VALUES (?, 'conversation.user_committed', 'conversation', ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, OWNER, occurredAt, occurredAt, contentHash, canonicalJson(envelope), occurredAt).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?").bind(eventId).first<{ sequence: number }>();
  return Object.freeze({
    principalId: OWNER, eventId: eventId as Ulid, eventSequence: row!.sequence, occurredAt, channel: "telegram" as const,
    memoryIntent, forwarded: false, quoted: false, pasted: false, hasAttachment: false, modelGenerated: false, toolGenerated: false, guest: false,
  });
}

async function telegramTurn(text: string, now: Date): Promise<Ulid> {
  const repository = new ConversationRepository(env.DB, new EventRepository(env.DB));
  const turnId = newUlid(now) as Ulid;
  const redaction = redactor.redactText(text);
  if (!redaction.ok) throw new Error("fixture_redaction_failed");
  const admission = await repository.getOrCreateTurn({ turnId, sessionId: "telegram:44112233", principalId: OWNER, channel: "telegram", userText: redaction, now });
  const claim = await repository.claimModelTurn({ turnId, requestHash: admission.turn.requestHash, now });
  if (claim.kind !== "claimed") throw new Error("fixture_claim_missing");
  repository.beginModelStream(claim.capability, turnId, admission.turn.requestHash);
  const answer = redactor.redactText(`Noted: ${text}`);
  if (!answer.ok) throw new Error("fixture_answer_redaction_failed");
  const staged = await repository.stageAssistantDelivery({ claim: claim.capability, text: answer, targetIdentityId: "identity:telegram", replyToMessageId: 17, now });
  const dispatch = await new DefaultOutboxDispatcher({
    repository, identityResolver: new D1TelegramIdentityResolver(env.DB),
    channels: new Map([["telegram", new FakeTelegramProvider()]]), circuitBreaker: new ProviderCircuitBreaker(), now: () => new Date(now),
  }).dispatch(staged.delivery.deliveryId as ConversationDeliveryId);
  if (dispatch.outcome !== "delivered") throw new Error(`fixture_dispatch_${dispatch.outcome}`);
  return turnId;
}

async function withTriggersDropped(run: () => Promise<void>): Promise<void> {
  const triggers = await env.DB.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all<{ name: string; sql: string }>();
  for (const trigger of triggers.results) await env.DB.prepare(`DROP TRIGGER "${trigger.name}"`).run();
  try { await run(); } finally { for (const trigger of triggers.results) await env.DB.prepare(trigger.sql).run(); }
}

/** Hours-old rows that only a long-running production database would hold. */
async function seedAgedRows(): Promise<void> {
  const event = await env.DB.prepare("SELECT sequence, event_id FROM events ORDER BY sequence DESC LIMIT 1").first<{ sequence: number; event_id: string }>();
  const turn = await env.DB.prepare("SELECT turn_id FROM conversation_turns LIMIT 1").first<{ turn_id: string }>();
  const old = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const later = new Date(Date.now() - 6 * 3_600_000 + 60_000).toISOString();
  const hash = "a".repeat(64);
  const ids = { price: newUlid(), run: newUlid(), cost: newUlid(), settle: newUlid(), reprocess: newUlid(), search: newUlid(), grant: newUlid(), grantEvent: newUlid() };
  await withTriggersDropped(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at)
        VALUES ('device:pc', ?, 'key:pc', ?, ?, 1, 'ed25519', 'active', 'pc', ?, ?, NULL)`).bind(OWNER, "A".repeat(43) + "=", "b".repeat(64), "c".repeat(64), old),
      env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
        VALUES ('identity:voice', ?, 'voice', 'voice-subject', 'active', ?, ?, 'device:pc')`).bind(OWNER, old, old),
      env.DB.prepare(`INSERT INTO memory_model_prices (price_id, principal_id, provider, model_id, effective_at, input_micros_per_million, output_micros_per_million, cache_read_micros_per_million, currency, source_receipt, created_at)
        VALUES (?, ?, 'deepseek', 'deepseek:aged', ?, 1, 1, 1, 'USD', 'aged fixture', ?)`).bind(ids.price, OWNER, old, old),
      env.DB.prepare(`INSERT INTO memory_runs (run_id, principal_id, run_key, job, reprocess_job_id, start_event_sequence, end_event_sequence, provider_model_id, price_id, input_event_count, created_item_count, input_tokens, output_tokens, cache_read_tokens, reserved_cost_micros, settled_cost_micros, outcome, started_at, completed_at, failure_code)
        VALUES (?, ?, 'aged-finished-run', 'distillation', NULL, 1, 1, 'deepseek:aged', ?, 1, 0, 1, 1, 0, 5, 5, 'succeeded', ?, ?, NULL)`).bind(ids.run, OWNER, ids.price, old, later),
      env.DB.prepare(`INSERT INTO memory_cost_ledger (cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id, provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at)
        VALUES (?, ?, ?, 'reservation', NULL, 'deepseek', 'deepseek:aged', 'normal_monthly', NULL, 5, ?, ?)`).bind(ids.cost, OWNER, ids.run, ids.price, old),
      env.DB.prepare(`INSERT INTO memory_reprocess_jobs (job_id, principal_id, owner_authorizing_event_id, start_event_sequence, end_event_sequence, start_day, end_day, maximum_event_count, provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence, status, final_receipt_hash, failure_code, created_at, updated_at)
        VALUES (?, ?, ?, 1, 1, NULL, NULL, 1, 'deepseek:aged', 1, 1, 1, 'succeeded', ?, NULL, ?, ?)`).bind(ids.reprocess, OWNER, event!.event_id, hash, old, later),
      env.DB.prepare(`INSERT INTO memory_literal_search_jobs (job_id, principal_id, job_key, attempt, query_text, query_hash, snapshot_event_sequence, checkpoint_event_sequence, scanned_event_count, matched_event_count, status, failure_code, created_at, updated_at, completed_at)
        VALUES (?, ?, 'aged-search', 1, 'tea', ?, ?, ?, 1, 0, 'succeeded', NULL, ?, ?, ?)`).bind(ids.search, OWNER, await sha256Hex("tea"), event!.sequence, event!.sequence, old, later, later),
      env.DB.prepare(`INSERT INTO owner_passphrase_verifiers (owner_principal_id, owner_identity_id, verifier_version, algorithm, domain_version, word_list_version, pepper_version, iterations, salt, digest, status, created_by_device_id, created_by_key_id, created_by_key_fingerprint, created_by_key_generation, created_at, status_changed_at)
        VALUES (?, 'identity:voice', 1, 'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 'eff-long-cmudict-2026-09-v2', 'v1', 600000, ?, ?, 'active', 'device:pc', 'key:pc', ?, 1, ?, ?)`)
        .bind(OWNER, new Uint8Array(16).fill(7), new Uint8Array(32).fill(9), "b".repeat(64), old, later),
      env.DB.prepare(`INSERT INTO voice_access_grants (grant_id, principal_id, identity_id, grant_version, capability_ids_json, resource_scopes_json, access_document_hash, pin_schema_version, pin_algorithm, pin_pepper_version, pin_iterations, pin_salt_base64, pin_digest_base64, status, created_by_identity_id, created_at, activated_at, updated_at, revoked_at)
        VALUES (?, ?, 'identity:voice', 1, '[]', '{}', ?, '2.0', 'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 600000, ?, ?, 'active', 'identity:voice', ?, ?, ?, NULL)`)
        .bind(ids.grant, OWNER, hash, "A".repeat(24), "B".repeat(44), old, old, old),
      env.DB.prepare(`INSERT INTO voice_access_grant_events (event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash, capability_ids_json, access_document_hash, created_at)
        VALUES (?, ?, 1, 'activated', 'identity:voice', ?, '[]', ?, ?)`).bind(ids.grantEvent, ids.grant, hash, hash, old),
      env.DB.prepare(`INSERT INTO guest_grant_notices (mutation_id, owner_principal_id, status, claim_id, claim_expires_at, provider_message_id, created_at, delivered_at)
        VALUES (?, ?, 'delivered', NULL, NULL, '1', ?, ?)`).bind(ids.grantEvent, OWNER, old, later),
    ]);
  });
  void turn;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { blob: [...new Uint8Array(value)] };
  if (ArrayBuffer.isView(value)) return { blob: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
  return value;
}

async function tableRows(table: string, where = ""): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT * FROM "${table}"${where}`).all<Row>();
  return rows.results.map((row) => canonicalJson(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalizeValue(v)]))) as string).sort();
}

interface Snapshot {
  readonly tables: Map<string, string[]>;
  readonly triggers: Map<string, string>;
  readonly cursors: Map<string, number>;
  readonly ftsItems: string[];
  readonly ftsHistory: string[];
  readonly chunks: string[];
  readonly coverage: string[];
}

const normalizeSql = (sql: string) => sql.replace(/\r\n/gu, "\n").replace(/\s+/gu, " ").trim();

async function snapshot(scheduledSince: string): Promise<Snapshot> {
  const tables = new Map<string, string[]>();
  for (const table of MEMORY_BACKUP_TABLES) {
    tables.set(table, await tableRows(table, table === "scheduled_runs" ? ` WHERE started_at >= '${scheduledSince}'` : ""));
  }
  for (const table of ["memory_item_state", "memory_item_placement_state"]) tables.set(table, await tableRows(table));
  const triggers = await env.DB.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'").all<{ name: string; sql: string }>();
  const cursors = await env.DB.prepare("SELECT cursor_name, current_event_sequence FROM memory_cursors WHERE principal_id = ?").bind(OWNER).all<{ cursor_name: string; current_event_sequence: number }>();
  const ftsItems = await env.DB.prepare(`SELECT version.version_id FROM memory_item_fts JOIN memory_item_versions version ON version.version_rowid = memory_item_fts.rowid WHERE memory_item_fts MATCH 'tea OR tables OR calculus OR waterloo'`).all<{ version_id: string }>();
  const ftsHistory = await env.DB.prepare(`SELECT chunk.text FROM memory_history_fts JOIN memory_history_chunks chunk ON chunk.chunk_rowid = memory_history_fts.rowid WHERE memory_history_fts MATCH 'tea OR tables OR chemistry OR waterloo'`).all<{ text: string }>();
  const chunks = await env.DB.prepare("SELECT principal_id, start_event_sequence, end_event_sequence, text, content_hash FROM memory_history_chunks").all<Row>();
  const coverage = await env.DB.prepare("SELECT * FROM memory_history_coverage").all<Row>();
  return {
    tables,
    triggers: new Map(triggers.results.map((t) => [t.name, normalizeSql(t.sql)])),
    cursors: new Map(cursors.results.map((c) => [c.cursor_name, c.current_event_sequence])),
    ftsItems: ftsItems.results.map((r) => r.version_id).sort(),
    ftsHistory: ftsHistory.results.map((r) => r.text).sort(),
    chunks: chunks.results.map((r) => canonicalJson(r) as string).sort(),
    coverage: coverage.results.map((r) => canonicalJson(Object.fromEntries(Object.entries(r).filter(([k]) => !["coverage_id", "indexed_at", "source_location", "r2_segment_id"].includes(k)))) as string).sort(),
  };
}

async function backupToVerified(now = new Date()): Promise<VerifiedMemoryBackupSet> {
  const notices: string[] = [];
  const make = () => new MemoryBackupService({ database: env.DB, bucket: backupBucket, clock: { now: () => new Date(now.getTime()) }, notice: { send: async (text) => { notices.push(text); } } });
  const runDate = now.toISOString().slice(0, 10);
  let outcome = await make().runNightly(runDate);
  for (let i = 0; i < 400 && outcome.outcome === "pending"; i += 1) outcome = await make().continueActive(runDate);
  if (outcome.outcome !== "verified") throw new Error(`backup ${JSON.stringify(outcome)} ${notices.join("|")}`);
  return readLatestVerifiedMemoryBackup(backupBucket);
}

function countingDatabase(counter: { statements: number; sql: string[] }, base: D1Database = env.DB): D1Database {
  return new Proxy(base, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => { counter.statements += 1; counter.sql.push(sql); return target.prepare(sql); };
      if (property === "batch") return async (statements: D1PreparedStatement[]) => target.batch(statements);
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

function bypassCursorInsertGuard(base: D1Database): D1Database {
  const name = "memory_distillation_cursor_insert_guard";
  return new Proxy(base, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/^INSERT INTO memory_cursors/u.test(sql)) return statement;
          const wrap = (inner: D1PreparedStatement): D1PreparedStatement => new Proxy(inner, {
            get(t, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(t.bind(...args));
              if (p === "run") {
                return async () => {
                  const guard = await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").bind(name).first<{ sql: string }>();
                  if (guard !== null) await env.DB.prepare(`DROP TRIGGER ${name}`).run();
                  try { return await t.run(); } finally { if (guard !== null) await env.DB.prepare(guard.sql).run(); }
                };
              }
              const value = Reflect.get(t, p) as unknown;
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
            },
          });
          return wrap(statement);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

async function restore(set: VerifiedMemoryBackupSet, database: D1Database = env.DB, sources = migrationSources): Promise<void> {
  await restoreVerifiedMemoryBackupRows({
    database,
    databaseSchemaVersion: set.manifest.databaseSchemaVersion,
    rowsByTable: set.rowsByTable,
    migrationSql: sources,
    jobs: { rebuildHistory: indexHistory, rebuildVectors: async () => undefined },
    shortfalls: Object.fromEntries(set.manifest.tableCuts.map((cut) => [cut.table, cut.shortfallRowCount])),
  });
}

function jobContext(provider: FakeModelProvider): JobEnvironment {
  return {
    env: { ...env, OWNER_PRINCIPAL_ID: OWNER, GITHUB_TOKEN: undefined, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, GOOGLE_REFRESH_TOKEN: undefined, BRIGHTSPACE_ICAL_URL: undefined },
    clock: { now: () => new Date() },
    delivery: { send: async () => undefined },
    fetcher: globalThis.fetch.bind(globalThis),
    memoryDistillation: { provider, providerModelId: MODEL_ID },
  };
}

describe("PR 80 round 3 narrow", () => {
  for (const bypass of [false, true]) it(bypass
    ? "R1b (diagnostic: distillation cursor insert guard bypassed only for the restore's cursor INSERT) restored tables, derived state, FTS, triggers and hourly jobs match the source"
    : "R1 production-shaped restore reproduces every backed-up table, derived state, FTS and triggers, and the hourly jobs do not re-pay", async () => {
    await fresh();
    await seedOwner();
    // Conversation turns with deliveries, events, outbox and idempotency.
    await telegramTurn("Hi Jarvis", new Date(Date.now() - 50 * 60_000));
    await telegramTurn("What is due tomorrow?", new Date(Date.now() - 49 * 60_000));
    // Hour 1 of distillation.
    const e1 = await appendConversation("I prefer tea.");
    const e2 = await appendConversation("I am studying calculus.");
    await distilToEnd(new FakeModelProvider({ completeJson: [proposal(e1, "I prefer tea."), proposal(e2, "I am studying calculus.")] }), "hour1");
    // Owner controls: remember, forget, lift; and a memory that stays forgotten.
    const controls = new MemoryOwnerControlsService(env.DB, archiveBucket);
    const kept = await controls.remember({ ownerTurn: await ownerTurn("Remember that I prefer reports without tables.", "remember"), text: "I prefer reports without tables.", kind: "preference", sensitivity: "normal" });
    await controls.forget({ ownerTurn: await ownerTurn("Forget my report preference.", "forget"), candidateItemIds: [kept.item.itemId] });
    await controls.lift({ ownerTurn: await ownerTurn("Use my report preference again.", "lift"), candidateItemIds: [kept.item.itemId] });
    const gone = await controls.remember({ ownerTurn: await ownerTurn("Remember that I like quiet study rooms.", "remember"), text: "I like quiet study rooms.", kind: "preference", sensitivity: "normal" });
    await controls.forget({ ownerTurn: await ownerTurn("Forget the study room memory.", "forget"), candidateItemIds: [gone.item.itemId] });
    // School save then replan (deletes superseded actions), and a university save.
    const schoolNow = new Date("2026-09-15T11:30:00.000Z");
    const schoolTurn = await telegramTurn("Chemistry uses Classroom and I missed the acid-base lab.", schoolNow);
    const school = new SchoolCatchupRepository(env.DB);
    await school.applyOwnerPlan({ principalId: OWNER, turnId: schoolTurn, today: "2026-09-15", responseHash: "b".repeat(64), now: schoolNow, plan: {
      engaged: true, reply: "Plan made.",
      courseUpdates: [{ courseRef: "new-1", name: "Chemistry", platform: "Google Classroom", addFacts: [{ kind: "missed_work", statement: "The acid-base lab was missed" }], resolveFactIds: [] }],
      completeActionIds: [],
      plan: [{ courseRef: "new-1", localDate: "2026-09-15", sequenceRank: 1, text: "Finish the lab observations", estimatedMinutes: 25 }, { courseRef: "new-1", localDate: "2026-09-16", sequenceRank: 1, text: "Draft the conclusion", estimatedMinutes: 35 }],
    } });
    const snap = await school.readSnapshot(OWNER, "2026-09-15");
    const replanNow = new Date("2026-09-15T12:00:00.000Z");
    const replanTurn = await telegramTurn("I finished the observations.", replanNow);
    await school.applyOwnerPlan({ principalId: OWNER, turnId: replanTurn, today: "2026-09-15", responseHash: "c".repeat(64), now: replanNow, plan: {
      engaged: true, reply: "Replanned.",
      courseUpdates: [{ courseRef: snap.courses[0]!.courseId, name: null, platform: null, addFacts: [], resolveFactIds: [snap.courses[0]!.ownerReportedFacts[0]!.factId] }],
      completeActionIds: [snap.courses[0]!.currentNextAction!.actionId],
      plan: [{ courseRef: snap.courses[0]!.courseId, localDate: "2026-09-15", sequenceRank: 1, text: "Do three titration calculations", estimatedMinutes: 30 }],
    } });
    const uniNow = new Date("2026-09-15T15:00:00.000Z");
    const uniTurn = await telegramTurn("I'm considering Waterloo Computer Science for 2027.", uniNow);
    await new UniversityTrackerRepository(env.DB).applyOwnerPlan({ principalId: OWNER, turnId: uniTurn, responseHash: "d".repeat(64), now: uniNow, plan: {
      engaged: true,
      programUpdates: [{ programRef: "new-1", university: "University of Waterloo", campus: "Main campus", programName: "Computer Science", ouacCode: null,
        verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
        addRequirements: [{ label: "Grade 12 prerequisites", detail: "Advanced Functions is required", verification: { state: "unverified", sourceUrl: null, cycle: "2027" } }],
        addDates: [], resolveItemIds: [] }],
      applicationUpdates: [], workflowUpdates: [],
    } });
    // Hour 2: distil everything that exists, then index literal history to completion.
    const e3 = await appendConversation("I drink green tea before exams.");
    await distilToEnd(new FakeModelProvider({ completeJson: [proposal(e3, "I drink green tea before exams.")] }), "hour2");
    await indexHistory();
    await seedAgedRows();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO scheduled_runs (job, run_key, started_at, finished_at, failure) VALUES ('digest', 'old-day', ?, ?, NULL)").bind(new Date(Date.now() - 3 * 86_400_000).toISOString(), new Date(Date.now() - 3 * 86_400_000).toISOString()),
      env.DB.prepare("INSERT INTO scheduled_runs (job, run_key, started_at, finished_at, failure) VALUES ('digest', 'today', ?, ?, NULL)").bind(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString()),
    ]);
    // Archive the first conversation events (as the hourly poll does after 90 days).
    const firstSequences = await env.DB.prepare("SELECT sequence FROM events ORDER BY sequence LIMIT 4").all<{ sequence: number }>();
    const aged = new Date(Date.now() - 100 * 86_400_000).toISOString();
    for (const { sequence } of firstSequences.results) {
      await env.DB.batch([
        env.DB.prepare("UPDATE events SET created_at = ? WHERE sequence = ?").bind(aged, sequence),
        env.DB.prepare("UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE event_sequence = ?").bind(aged, sequence),
      ]);
    }
    let archived = "no";
    try {
      const segment = await new ArchivalService({ database: env.DB, bucket: archiveBucket }).archiveEligible(new Date(), 8);
      archived = segment === null ? "none eligible" : `sealed ${JSON.stringify(segment).slice(0, 80)}`;
    } catch (error) { archived = `archive failed ${String(error)}`; }

    const now = new Date();
    const scheduledSince = new Date(now.getTime() - 48 * 3_600_000).toISOString();
    const counts = await env.DB.prepare(`SELECT (SELECT count(*) FROM events) events, (SELECT count(*) FROM memory_runs) runs,
      (SELECT count(*) FROM memory_items) items, (SELECT count(*) FROM memory_event_suppressions) suppressions, (SELECT count(*) FROM memory_event_suppression_lifts) lifts,
      (SELECT count(*) FROM memory_history_chunks) chunks, (SELECT count(*) FROM archive_segment_events) archived, (SELECT sealed_through FROM archive_state) sealed,
      (SELECT count(*) FROM school_catchup_actions) actions, (SELECT count(*) FROM university_program_items) uni, (SELECT count(*) FROM conversation_deliveries) deliveries`).first();
    const source = await snapshot(scheduledSince);
    const sourceGuard = await env.DB.prepare(`INSERT INTO memory_runs (run_id, principal_id, run_key, job, provider_model_id, outcome, started_at) VALUES (?, ?, 'probe', 'distillation', ?, 'succeeded', ?)`)
      .bind(newUlid(), OWNER, MODEL_ID, new Date().toISOString()).run().then(() => "accepted", (error: unknown) => String(error));
    const sourceCursorGuard = await env.DB.prepare("UPDATE memory_cursors SET current_event_sequence = 0 WHERE principal_id = ? AND cursor_name = 'distillation'")
      .bind(OWNER).run().then(() => "accepted", (error: unknown) => String(error));
    console.log("R1 source", JSON.stringify({ counts, archived, cursors: [...source.cursors], sourceGuard, sourceCursorGuard }));

    const set = await backupToVerified(now);
    await recreateFreshDatabaseForBackupRestoreTest();
    const counter = { statements: 0, sql: [] as string[] };
    const totalRows = [...set.rowsByTable.values()].reduce((sum, rows) => sum + rows.length, 0);
    let restoreError: string | null = null;
    try { await restore(set, bypass ? bypassCursorInsertGuard(countingDatabase(counter)) : countingDatabase(counter)); } catch (error) { restoreError = String(error); }
    console.log(bypass ? "R1b restore" : "R1 restore", JSON.stringify({ restoreError, totalRows, statements: counter.statements }));
    expect(restoreError).toBeNull();
    if (!bypass) return;

    const target = await snapshot(scheduledSince);
    const tableDiffs: string[] = [];
    for (const [table, rows] of source.tables) {
      const restored = target.tables.get(table) ?? [];
      const missing = rows.filter((row) => !restored.includes(row));
      const extra = restored.filter((row) => !rows.includes(row));
      if (missing.length > 0 || extra.length > 0) tableDiffs.push(`${table}: missing ${missing.length} extra ${extra.length} e.g. ${(missing[0] ?? extra[0] ?? "").slice(0, 300)}`);
    }
    const cursorDiffs = [...new Set([...source.cursors.keys(), ...target.cursors.keys()])]
      .filter((name) => source.cursors.get(name) !== target.cursors.get(name))
      .map((name) => `${name}: source ${source.cursors.get(name)} restored ${target.cursors.get(name)}`);
    const triggerDiffs = [...new Set([...source.triggers.keys(), ...target.triggers.keys()])]
      .filter((name) => source.triggers.get(name) !== target.triggers.get(name)).map((name) => `${name}: ${source.triggers.has(name) ? "" : "extra"}${target.triggers.has(name) ? "" : "missing"}`);
    console.log("R1 diffs", JSON.stringify({ tableDiffs, cursorDiffs, triggerDiffs: triggerDiffs.slice(0, 20), triggerCounts: [source.triggers.size, target.triggers.size] }));
    expect.soft(tableDiffs, "backed-up and state tables").toEqual([]);
    expect.soft(cursorDiffs, "memory_cursors").toEqual([]);
    expect.soft(triggerDiffs, "triggers").toEqual([]);
    expect.soft(target.ftsItems, "memory_item_fts").toEqual(source.ftsItems);
    expect.soft(target.ftsHistory, "memory_history_fts").toEqual(source.ftsHistory);
    expect.soft(target.chunks, "history chunks").toEqual(source.chunks);
    expect.soft(target.coverage, "history coverage").toEqual(source.coverage);

    const targetGuard = await env.DB.prepare(`INSERT INTO memory_runs (run_id, principal_id, run_key, job, provider_model_id, outcome, started_at) VALUES (?, ?, 'probe', 'distillation', ?, 'succeeded', ?)`)
      .bind(newUlid(), OWNER, MODEL_ID, new Date().toISOString()).run().then(() => "accepted", (error: unknown) => String(error));
    expect.soft(targetGuard, "guard after restore").toBe(sourceGuard);
    const cursorGuard = await env.DB.prepare("UPDATE memory_cursors SET current_event_sequence = 0 WHERE principal_id = ? AND cursor_name = 'distillation'")
      .bind(OWNER).run().then(() => "accepted", (error: unknown) => String(error));
    expect.soft(cursorGuard).toBe(sourceCursorGuard);

    // Hourly jobs on the restored database: nothing is new, so no provider call and no duplicate items.
    const itemsBefore = await env.DB.prepare("SELECT count(*) AS count FROM memory_items").first<{ count: number }>();
    const provider = new FakeModelProvider({ completeJson: [] });
    const poll = buildJobTable(jobContext(provider)).poll!;
    const result = await poll();
    const itemsAfter = await env.DB.prepare("SELECT count(*) AS count FROM memory_items").first<{ count: number }>();
    console.log("R1 poll", JSON.stringify({ result, requests: provider.requests.length, itemsBefore, itemsAfter }));
    expect.soft(provider.requests.length, "provider calls after restore").toBe(0);
    expect.soft(itemsAfter).toEqual(itemsBefore);
    expect.soft(JSON.stringify(result)).not.toContain("failed");
  }, 600_000);

  it("R2a a set whose distillation took two ordinary successful hourly runs restores", async () => {
    await fresh();
    await seedOwner();
    const e1 = await appendConversation("I prefer tea.");
    await distilToEnd(new FakeModelProvider({ completeJson: [proposal(e1, "I prefer tea.")] }), "hour1");
    const e2 = await appendConversation("I am studying calculus.");
    await distilToEnd(new FakeModelProvider({ completeJson: [proposal(e2, "I am studying calculus.")] }), "hour2");
    const runs = await env.DB.prepare("SELECT start_event_sequence, end_event_sequence, outcome FROM memory_runs ORDER BY started_at").all();
    const sourceCursor = await env.DB.prepare("SELECT current_event_sequence FROM memory_cursors WHERE principal_id = ? AND cursor_name = 'distillation'").bind(OWNER).first("current_event_sequence");
    const set = await backupToVerified();
    await recreateFreshDatabaseForBackupRestoreTest();
    let error: string | null = null;
    try { await restore(set); } catch (caught) { error = String(caught); }
    const restoredCursor = await env.DB.prepare("SELECT current_event_sequence FROM memory_cursors WHERE principal_id = ? AND cursor_name = 'distillation'").bind(OWNER).first("current_event_sequence");
    console.log("R2a", JSON.stringify({ runs: runs.results, sourceCursor, restoredCursor, error }));
    expect(error).toBeNull();
    expect(restoredCursor).toBe(sourceCursor);
  }, 300_000);

  for (const bypass of [false, true]) it(bypass
    ? "R2b (diagnostic: cursor insert guard bypassed) a restored distillation cursor does not jump past events whose run failed"
    : "R2 a restored distillation cursor does not jump past events whose run failed (receipts exist, cursor did not advance)", async () => {
    await fresh();
    await seedOwner();
    const e1 = await appendConversation("I prefer tea.");
    await distilToEnd(new FakeModelProvider({ completeJson: [proposal(e1, "I prefer tea.")] }), "ok");
    const e2 = await appendConversation("I am moving to Calgary in June.");
    const failing = new FakeModelProvider({ completeJson: [proposal(e2, "I am moving to Calgary in June.")] });
    failing.failNext(ProviderFailure.transient("timeout"));
    const failed = await distiller(failing).runNext({ runKey: `outage:${newUlid()}` });
    expect(failed).toMatchObject({ outcome: "failed", cursorEventSequence: e1.eventSequence });
    const sourceCursor = await env.DB.prepare("SELECT current_event_sequence FROM memory_cursors WHERE principal_id = ? AND cursor_name = 'distillation'").bind(OWNER).first("current_event_sequence");
    const set = await backupToVerified();
    await recreateFreshDatabaseForBackupRestoreTest();
    let restoreError: string | null = null;
    try { await restore(set, bypass ? bypassCursorInsertGuard(env.DB) : env.DB); } catch (caught) { restoreError = String(caught); }
    console.log(bypass ? "R2b restore" : "R2 restore", JSON.stringify({ restoreError }));
    const restoredCursor = await env.DB.prepare("SELECT current_event_sequence FROM memory_cursors WHERE principal_id = ? AND cursor_name = 'distillation'").bind(OWNER).first("current_event_sequence");
    const retry = new FakeModelProvider({ completeJson: [proposal(e2, "I am moving to Calgary in June.")] });
    const next = await distiller(retry).runNext({ runKey: `after-restore:${newUlid()}` });
    const items = await env.DB.prepare("SELECT count(*) AS count FROM memory_items").first("count");
    console.log(bypass ? "R2b" : "R2", JSON.stringify({ sourceCursor, restoredCursor, e2: e2.eventSequence, next: { outcome: next.outcome, created: next.createdItemCount }, requests: retry.requests.length, items }));
    expect.soft(restoredCursor, "restored distillation cursor").toBe(sourceCursor);
    expect.soft(retry.requests.length, "the failed event is retried after restore").toBe(1);
    expect.soft(items).toBe(2);
  }, 300_000);

  it("R3 a set taken after Sid changed a migration-seeded row (autonomy live, outbound enabled) restores", async () => {
    await fresh();
    await seedOwner();
    await new AutonomyRepository(env.DB).setMode("live", new Date().toISOString());
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1 WHERE singleton_id = 1").run();
    const sourceRows = [await tableRows("autonomy_mode"), await tableRows("outbound_runtime_controls")];
    const set = await backupToVerified();
    await recreateFreshDatabaseForBackupRestoreTest();
    let error: string | null = null;
    try { await restore(set); } catch (caught) { error = String(caught); }
    console.log("R3", JSON.stringify({ error }));
    expect(error).toBeNull();
    expect([await tableRows("autonomy_mode"), await tableRows("outbound_runtime_controls")]).toEqual(sourceRows);
  }, 300_000);

  it("R4 restore pointed at a live (non-fresh) database refuses before changing its schema", async () => {
    await fresh();
    await seedOwner();
    await appendConversation("I prefer tea.");
    const set = await backupToVerified();
    // The live database moves on after the backup.
    await new AutonomyRepository(env.DB).setMode("live", new Date().toISOString());
    const triggersBefore = await env.DB.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger'").first("count");
    const counter = { statements: 0, sql: [] as string[] };
    let error: string | null = null;
    try { await restore(set, countingDatabase(counter)); } catch (caught) { error = String(caught); }
    const drops = counter.sql.filter((sql) => /^DROP TRIGGER/u.test(sql)).length;
    const creates = counter.sql.filter((sql) => /^CREATE TRIGGER/u.test(sql)).length;
    const triggersAfter = await env.DB.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger'").first("count");
    console.log("R4", JSON.stringify({ error, drops, creates, triggersBefore, triggersAfter }));
    expect(error).not.toBeNull();
    expect(drops, "DROP TRIGGER statements run against the live database").toBe(0);
  }, 300_000);

  it("R5 runtime fails closed with the owner notice on an unclassified table", async () => {
    await fresh();
    await seedOwner();
    await env.DB.prepare("CREATE TABLE zz_unclassified_probe (id INTEGER PRIMARY KEY, note TEXT)").run();
    const notices: string[] = [];
    try {
      const outcome = await new MemoryBackupService({ database: env.DB, bucket: backupBucket, clock: { now: () => new Date() }, notice: { send: async (text) => { notices.push(text); } } })
        .runNightly(new Date().toISOString().slice(0, 10));
      console.warn("R5", JSON.stringify({ outcome, notices }));
      expect(outcome.outcome).toBe("failed");
      expect(notices).toHaveLength(1);
    } finally {
      await env.DB.prepare("DROP TABLE zz_unclassified_probe").run();
    }
  }, 300_000);

  it("R6 ordinal paging uses the key index (no source scan) and backup invocations stay under 1,000 D1 statements", async () => {
    await fresh();
    await seedOwner();
    for (let i = 0; i < 20; i += 1) await appendConversation(`I note fact number ${i}.`);
    await distilToEnd(new FakeModelProvider({ completeJson: [] }), "plan");
    const withoutRowid = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID%'").all<{ name: string }>();
    const scans: string[] = [];
    for (const { name } of withoutRowid.results) {
      if (!(MEMORY_BACKUP_TABLES as readonly string[]).includes(name)) continue;
      const info = await env.DB.prepare(`PRAGMA table_info("${name}")`).all<{ name: string; pk: number }>();
      const keys = info.results.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const match = keys.map((column, index) => `source."${column}" IS ordinal_page.key_${index + 1}`).join(" AND ");
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN WITH ordinal_page AS (
         SELECT ordinal, key_1, key_2, key_3, key_4 FROM memory_backup_row_ordinals
         WHERE table_name = ? AND ordinal > ? AND ordinal <= ? ORDER BY ordinal LIMIT ?)
       SELECT source.*, ordinal_page.ordinal AS __memory_backup_key FROM ordinal_page JOIN "${name}" source ON ${match} ORDER BY ordinal_page.ordinal`)
        .bind(name, 0, 1_000_000, 16).all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail);
      if (details.some((d) => /SCAN source|SCAN memory_backup_row_ordinals/u.test(d))) scans.push(`${name}: ${details.join(" | ")}`);
    }
    let maxStatements = 0;
    const runDate = new Date().toISOString().slice(0, 10);
    const make = () => {
      const counter = { statements: 0, sql: [] as string[] };
      return { counter, service: new MemoryBackupService({ database: countingDatabase(counter), bucket: backupBucket, clock: { now: () => new Date() }, notice: { send: async () => undefined } }) };
    };
    let step = make();
    let outcome = await step.service.runNightly(runDate);
    maxStatements = Math.max(maxStatements, step.counter.statements);
    for (let i = 0; i < 400 && outcome.outcome === "pending"; i += 1) {
      step = make();
      outcome = await step.service.continueActive(runDate);
      maxStatements = Math.max(maxStatements, step.counter.statements);
    }
    console.warn("R6", JSON.stringify({ scans, withoutRowid: withoutRowid.results.length, outcome, maxStatements }));
    expect(scans).toEqual([]);
    expect(outcome.outcome).toBe("verified");
    expect(maxStatements).toBeLessThanOrEqual(1000);
  }, 300_000);

  it("R7 restoring an older set with the repository's later migration files in the list", async () => {
    await fresh();
    await seedOwner();
    await appendConversation("I prefer tea.");
    const set = await backupToVerified();
    await recreateFreshDatabaseForBackupRestoreTest();
    const later = "CREATE TABLE zz_later_table (id INTEGER PRIMARY KEY);\n\nCREATE TRIGGER zz_later_table_guard\nBEFORE INSERT ON zz_later_table\nBEGIN\n  SELECT RAISE(ABORT, 'zz') WHERE NEW.id < 0;\nEND;\n";
    let error: string | null = null;
    try { await restore(set, env.DB, [...migrationSources, later]); } catch (caught) { error = String(caught); }
    const events = await env.DB.prepare("SELECT count(*) AS count FROM events").first("count");
    const triggers = await env.DB.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger'").first("count");
    console.log("R7", JSON.stringify({ error, eventsAfterFailure: events, triggers }));
    expect(error).toBeNull();
  }, 300_000);
});
