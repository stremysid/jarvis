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
  continueVerifiedMemoryBackupRestore,
  finalizeVerifiedMemoryBackupRestore,
  readLatestVerifiedMemoryBackup,
  type MemoryBackupRestorePhase,
  type MemoryBackupRestoreStep,
  type VerifiedMemoryBackupSet,
} from "../../src/backup/memory-backup-restore.js";
import { MEMORY_BACKUP_TABLES, MemoryBackupService } from "../../src/backup/memory-backup.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import type { ConversationDeliveryId } from "../../src/conversation/conversation-types.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { AutomaticMemoryDistillationWorkflow } from "../../src/memory/automatic-distillation.js";
import { LiteralHistoryService } from "../../src/memory/literal-history.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { EventRepository, type AppendedEvent } from "../../src/persistence/event-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { ProviderFailure } from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { recreateFreshDatabaseForBackupRestoreTest } from "../persistence/migration.js";

const OWNER = "principal:owner";
const MODEL_ID = "openai:fake-memory-distillation-v1";
const backupBucket = env.BACKUP as R2Bucket;
const archiveBucket = env.ARCHIVE as R2Bucket;
const redactor = new Redactor();
const migrationFiles = import.meta.glob("../../src/persistence/migrations/*.sql", {
  eager: true, import: "default", query: "?raw",
}) as Record<string, string>;
/** The operator's shape: ordered { name, sql } records (MEMORY_BACKUP_RESTORE_MIGRATIONS). */
const namedMigrations = Object.entries(migrationFiles).sort(([l], [r]) => l.localeCompare(r))
  .map(([path, sql]) => Object.freeze({ name: path.split("/").at(-1)!, sql }));

type Row = Record<string, unknown>;
const PHASES: readonly MemoryBackupRestorePhase[] = [
  "drop_triggers", "reset_seeded_rows", "insert_rows", "rebuild_archive", "rebuild_item_state",
  "rebuild_placement_state", "rebuild_history", "rebuild_vectors", "rebuild_fts", "rebuild_cursors",
  "recreate_triggers", "verify", "complete",
];

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
    envelope, scope: "adversarial-pr80r4", key: eventId, requestHash: await sha256Hex(canonicalJson([eventId, text])),
  });
}

function proposal(event: AppendedEvent, text: string): Row {
  return { text, sourceEventIds: [event.envelope.eventId], sourceExcerpts: [{ sourceEventId: event.envelope.eventId, excerpt: text }], confidence: 0.95, sensitivity: "normal" };
}

function distiller(provider: FakeModelProvider): AutomaticMemoryDistillationWorkflow {
  const archive = new ArchivalService({ database: env.DB, bucket: archiveBucket });
  return new AutomaticMemoryDistillationWorkflow({
    database: env.DB,
    events: new TieredEventReader({ live: new EventRepository(env.DB), archive, state: new ArchiveRepository(env.DB) }),
    repository: new MemoryRepository(env.DB, { archivedEventReader: archive }),
    provider, providerModelId: MODEL_ID, principalId: OWNER, now: () => new Date(),
  });
}

async function distilToEnd(provider: FakeModelProvider, label: string, cap = 400): Promise<number> {
  for (let step = 0; step < cap; step += 1) {
    const result = await distiller(provider).runNext({ runKey: `${label}:${step}:${newUlid()}` });
    if (result.outcome !== "succeeded" && result.outcome !== "nothing_new") throw new Error(`distil ${label} ${result.outcome} ${result.failureCode}`);
    if (result.backlogEventCount === 0) return step + 1;
  }
  throw new Error(`distil ${label} did not finish`);
}

function historyService(database: D1Database): LiteralHistoryService {
  const archive = new ArchivalService({ database, bucket: archiveBucket });
  const state = new ArchiveRepository(database);
  return new LiteralHistoryService({
    database,
    events: new TieredEventReader({ live: new EventRepository(database), archive, state }),
    archive: state, now: () => new Date(), nextId: () => newUlid(),
  });
}

async function indexHistory(): Promise<void> {
  const history = historyService(env.DB);
  for (let step = 0; step < 2_000; step += 1) {
    const result = await history.indexNext({ principalId: OWNER, maxEvents: 16, maxTextBytes: 128 * 1024 });
    if (result.complete) return;
  }
  throw new Error("history did not complete");
}

/** Exactly the operator's historyStep (memory-backup-restore-operator.ts:112-139), on the given binding. */
function operatorHistoryStep(database: D1Database): () => Promise<boolean> {
  return async () => {
    const principals = await database.prepare(`SELECT principal_id FROM principals
      WHERE principal_type = 'human' ORDER BY principal_id`).all<{ principal_id: string }>();
    const history = historyService(database);
    let complete = true;
    for (const { principal_id: principalId } of principals.results) {
      const result = await history.indexNext({ principalId, maxEvents: 16, maxTextBytes: 128 * 1024 });
      complete &&= result.complete;
    }
    return complete;
  };
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

/** A voice identity, an active guest grant and its event, as round 3's aged fixture. */
async function seedGuestGrant(): Promise<string> {
  const old = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const hash = "a".repeat(64);
  const grant = newUlid();
  await withTriggersDropped(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at)
        VALUES ('device:pc', ?, 'key:pc', ?, ?, 1, 'ed25519', 'active', 'pc', ?, ?, NULL)`).bind(OWNER, "A".repeat(43) + "=", "b".repeat(64), "c".repeat(64), old),
      env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
        VALUES ('identity:voice', ?, 'voice', 'voice-subject', 'active', ?, ?, 'device:pc')`).bind(OWNER, old, old),
      env.DB.prepare(`INSERT INTO voice_access_grants (grant_id, principal_id, identity_id, grant_version, capability_ids_json, resource_scopes_json, access_document_hash, pin_schema_version, pin_algorithm, pin_pepper_version, pin_iterations, pin_salt_base64, pin_digest_base64, status, created_by_identity_id, created_at, activated_at, updated_at, revoked_at)
        VALUES (?, ?, 'identity:voice', 1, '[]', '{}', ?, '2.0', 'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 600000, ?, ?, 'active', 'identity:voice', ?, ?, ?, NULL)`)
        .bind(grant, OWNER, hash, "A".repeat(24), "B".repeat(44), old, old, old),
    ]);
  });
  return grant;
}

/** A completed inbound guest call admitted under that grant (call_sessions.guest_grant_id). */
async function seedGuestCall(grant: string): Promise<void> {
  const created = new Date(Date.now() - 5 * 3_600_000);
  const at = created.toISOString();
  const setup = new Date(created.getTime() + 60_000).toISOString();
  await withTriggersDropped(async () => {
    await env.DB.prepare(`INSERT INTO call_sessions (session_id, call_sid, expected_attempt_id, principal_id, identity_id,
        destination_identity_id, direction, activation_only, activation_challenge_id, activation_hmac_key_version,
        relay_nonce, nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
        access_kind, guest_grant_id, guest_grant_version, access_document_hash, provider_connected_at)
      VALUES (?, ?, NULL, ?, 'identity:voice', 'identity:voice', 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'completed', ?, ?,
        'guest', ?, 1, ?, NULL)`)
      .bind(newUlid(created), `CA${"1".repeat(32)}`, OWNER, "A".repeat(43), setup, setup, at, setup, grant, "a".repeat(64)).run();
  });
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

const normalizeSql = (sql: string) => sql.replace(/\r\n/gu, "\n").replace(/\s+/gu, " ").trim();

interface Snapshot {
  readonly tables: Map<string, string[]>;
  readonly triggers: Map<string, string>;
  readonly cursors: Map<string, number>;
  readonly chunks: string[];
  readonly coverage: string[];
  readonly ftsHistory: number;
  readonly ftsItems: number;
}

async function snapshot(scheduledSince: string | null, derivedIds: boolean): Promise<Snapshot> {
  const tables = new Map<string, string[]>();
  for (const table of MEMORY_BACKUP_TABLES) {
    tables.set(table, await tableRows(table, table === "scheduled_runs" && scheduledSince !== null ? ` WHERE started_at >= '${scheduledSince}'` : ""));
  }
  for (const table of ["memory_item_state", "memory_item_placement_state"]) tables.set(table, await tableRows(table));
  const triggers = await env.DB.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'").all<{ name: string; sql: string }>();
  const cursors = await env.DB.prepare("SELECT principal_id, cursor_name, current_event_sequence FROM memory_cursors").all<{ principal_id: string; cursor_name: string; current_event_sequence: number }>();
  const chunks = await env.DB.prepare(`SELECT ${derivedIds ? "*" : "principal_id, start_event_sequence, end_event_sequence, text, content_hash"} FROM memory_history_chunks`).all<Row>();
  const coverage = await env.DB.prepare("SELECT * FROM memory_history_coverage").all<Row>();
  const ftsHistory = await env.DB.prepare(`SELECT count(*) AS count FROM memory_history_fts WHERE memory_history_fts MATCH 'fact OR tea'`).first<{ count: number }>();
  const ftsItems = await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_fts WHERE memory_item_fts MATCH 'tea OR calculus OR exams'`).first<{ count: number }>();
  const omit = derivedIds ? [] : ["coverage_id", "indexed_at", "source_location", "r2_segment_id"];
  return {
    tables,
    triggers: new Map(triggers.results.map((t) => [t.name, normalizeSql(t.sql)])),
    cursors: new Map(cursors.results.map((c) => [`${c.principal_id}/${c.cursor_name}`, c.current_event_sequence])),
    chunks: chunks.results.map((r) => canonicalJson(Object.fromEntries(Object.entries(r).filter(([k]) => derivedIds || k !== "indexed_at"))) as string).sort(),
    coverage: coverage.results.map((r) => canonicalJson(Object.fromEntries(Object.entries(r).filter(([k]) => !omit.includes(k)))) as string).sort(),
    ftsHistory: ftsHistory?.count ?? -1,
    ftsItems: ftsItems?.count ?? -1,
  };
}

function diffSnapshots(left: Snapshot, right: Snapshot, compareTriggers = true): string[] {
  const diffs: string[] = [];
  for (const [table, rows] of left.tables) {
    const other = right.tables.get(table) ?? [];
    const otherSet = new Set(other);
    const rowSet = new Set(rows);
    const missing = rows.filter((row) => !otherSet.has(row)).length;
    const extra = other.filter((row) => !rowSet.has(row)).length;
    if (missing > 0 || extra > 0 || rows.length !== other.length) diffs.push(`${table}: ${rows.length} vs ${other.length} (missing ${missing}, extra ${extra})`);
  }
  for (const name of new Set([...left.cursors.keys(), ...right.cursors.keys()])) {
    if (left.cursors.get(name) !== right.cursors.get(name)) diffs.push(`cursor ${name}: ${left.cursors.get(name)} vs ${right.cursors.get(name)}`);
  }
  if (compareTriggers) {
    for (const name of new Set([...left.triggers.keys(), ...right.triggers.keys()])) {
      if (left.triggers.get(name) !== right.triggers.get(name)) diffs.push(`trigger ${name}: ${left.triggers.has(name)} vs ${right.triggers.has(name)}`);
    }
  }
  if (canonicalJson(left.chunks) !== canonicalJson(right.chunks)) diffs.push(`history chunks: ${left.chunks.length} vs ${right.chunks.length}`);
  if (canonicalJson(left.coverage) !== canonicalJson(right.coverage)) diffs.push(`history coverage: ${left.coverage.length} vs ${right.coverage.length}`);
  if (left.ftsHistory !== right.ftsHistory) diffs.push(`fts history: ${left.ftsHistory} vs ${right.ftsHistory}`);
  if (left.ftsItems !== right.ftsItems) diffs.push(`fts items: ${left.ftsItems} vs ${right.ftsItems}`);
  return diffs;
}

async function backupToVerified(now = new Date()): Promise<VerifiedMemoryBackupSet> {
  const notices: string[] = [];
  const make = () => new MemoryBackupService({ database: env.DB, bucket: backupBucket, clock: { now: () => new Date(now.getTime()) }, notice: { send: async (text) => { notices.push(text); } } });
  const runDate = now.toISOString().slice(0, 10);
  let outcome = await make().runNightly(runDate);
  for (let i = 0; i < 5_000 && outcome.outcome === "pending"; i += 1) outcome = await make().continueActive(runDate);
  if (outcome.outcome !== "verified") throw new Error(`backup ${JSON.stringify(outcome)} ${notices.join("|")}`);
  return readLatestVerifiedMemoryBackup(backupBucket);
}

class Killed extends Error {}

interface Meter { ops: number; executed: number; prepared: number; sql: string[]; killed: boolean }

/**
 * Counts every executed D1 statement (a batch counts each member) and, when killAfter > 0,
 * throws after the killAfter-th operation has committed: the invocation dies with its
 * last write durable but unacknowledged.
 */
function meteredDatabase(base: D1Database, meter: Meter, killAfter = 0): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const tick = () => {
    meter.ops += 1;
    if (killAfter > 0 && meter.ops === killAfter) { meter.killed = true; throw new Killed(`killed after op ${killAfter}`); }
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === "run" || property === "all" || property === "first" || property === "raw") {
          return async (...args: unknown[]) => {
            meter.executed += 1;
            const result = await (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[property as string]!(...args);
            tick();
            return result;
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    real.set(proxy, statement);
    return proxy;
  };
  return new Proxy(base, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => { meter.prepared += 1; meter.sql.push(sql); return wrap(target.prepare(sql)); };
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          meter.executed += statements.length;
          const result = await target.batch(statements.map((statement) => real.get(statement) ?? statement));
          tick();
          return result;
        };
      }
      if (property === "exec") return async (sql: string) => { meter.executed += 1; const result = await target.exec(sql); tick(); return result; };
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

const newMeter = (): Meter => ({ ops: 0, executed: 0, prepared: 0, sql: [], killed: false });

function operatorOptions(set: VerifiedMemoryBackupSet, database: D1Database, migrations: readonly Readonly<{ name: string; sql: string }>[] = namedMigrations) {
  return {
    database,
    databaseSchemaVersion: set.manifest.databaseSchemaVersion,
    rowsByTable: set.rowsByTable,
    migrationSql: migrations,
    restoreId: set.manifest.runId,
    maxStatementsPerStep: 64,
    jobs: { rebuildHistory: operatorHistoryStep(database), rebuildVectors: async () => true },
    shortfalls: Object.fromEntries(set.manifest.tableCuts.map((cut) => [cut.table, cut.shortfallRowCount])),
  };
}

async function progressRow(): Promise<{ phase: string; item_index: number } | null> {
  const exists = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'memory_backup_restore_progress'").first();
  if (exists === null) return null;
  return env.DB.prepare("SELECT phase, item_index FROM memory_backup_restore_progress WHERE singleton = 1").first<{ phase: string; item_index: number }>();
}

const triggerCount = async () => (await env.DB.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger'").first<{ count: number }>())!.count;
const ddlIn = (meter: Meter) => meter.sql.filter((sql) => /^\s*(DROP TRIGGER|CREATE TRIGGER|CREATE TABLE|DROP TABLE|DELETE FROM)/u.test(sql));

describe("PR 80 round 4 narrow", () => {
  it("K1 killed at every operation of every phase and rerun, a production-shaped restore equals an uninterrupted one; every invocation stays under 1,000 D1 statements", async () => {
    await fresh();
    await seedOwner();
    for (let i = 0; i < 6; i += 1) await telegramTurn(`Telegram message ${i}`, new Date(Date.now() - (50 - i) * 60_000));
    const e1 = await appendConversation("I prefer tea.");
    const e2 = await appendConversation("I am studying calculus.");
    await distilToEnd(new FakeModelProvider({ completeJson: [proposal(e1, "I prefer tea."), proposal(e2, "I am studying calculus.")] }), "hour1");
    for (let i = 0; i < 900; i += 1) await appendConversation(`I note fact number ${i}.`);
    const bulkRuns = await distilToEnd(new FakeModelProvider({ completeJson: [] }), "bulk");
    const e3 = await appendConversation("I drink green tea before exams.");
    await distilToEnd(new FakeModelProvider({ completeJson: [proposal(e3, "I drink green tea before exams.")] }), "hour3");
    const e4 = await appendConversation("I am moving to Calgary in June.");
    const failing = new FakeModelProvider({ completeJson: [proposal(e4, "I am moving to Calgary in June.")] });
    failing.failNext(ProviderFailure.transient("timeout"));
    const failed = await distiller(failing).runNext({ runKey: `outage:${newUlid()}` });
    expect(failed.outcome).toBe("failed");
    await new AutonomyRepository(env.DB).setMode("live", new Date().toISOString());
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1 WHERE singleton_id = 1").run();
    await seedGuestGrant();
    await indexHistory();
    const runs = await env.DB.prepare("SELECT outcome, count(*) AS count FROM memory_runs GROUP BY outcome").all();
    const now = new Date();
    const scheduledSince = new Date(now.getTime() - 48 * 3_600_000).toISOString();
    const source = await snapshot(scheduledSince, false);

    const set = await backupToVerified(now);
    const totalRows = [...set.rowsByTable.values()].reduce((sum, rows) => sum + rows.length, 0);

    // A: uninterrupted, as the operator runs it, metering every invocation.
    await recreateFreshDatabaseForBackupRestoreTest();
    let outcome: MemoryBackupRestoreStep = { outcome: "pending", phase: "drop_triggers", itemIndex: 0 };
    const perPhaseMax = new Map<string, number>();
    let invocationsA = 0;
    for (; invocationsA < 5_000 && outcome.outcome === "pending"; invocationsA += 1) {
      const before = (await progressRow())?.phase ?? "init";
      const meter = newMeter();
      outcome = await continueVerifiedMemoryBackupRestore(operatorOptions(set, meteredDatabase(env.DB, meter)));
      perPhaseMax.set(before, Math.max(perPhaseMax.get(before) ?? 0, meter.executed));
    }
    expect(outcome.outcome).toBe("complete");
    const reportA = outcome.outcome === "complete" ? outcome.report : null;
    const restoredA = await snapshot(null, false);
    await finalizeVerifiedMemoryBackupRestore(env.DB, set.manifest.runId);
    const maxA = Math.max(...perPhaseMax.values());
    console.log("K1 fixture", JSON.stringify({ totalRows, bulkRuns, runs: runs.results, invocationsA, perPhaseMax: Object.fromEntries(perPhaseMax), reportA }));
    expect.soft(totalRows, "fixture size").toBeGreaterThanOrEqual(2_500);
    expect.soft(maxA, "max executed D1 statements in one invocation").toBeLessThan(1_000);
    // Round-3 fixes on this data: tables, changed seeded rows, failed-last-run cursor, cursor names.
    const sourceDiffs = diffSnapshots(source, restoredA);
    console.log("K1 source vs uninterrupted", JSON.stringify(sourceDiffs));
    expect.soft(sourceDiffs, "uninterrupted restore vs source").toEqual([]);
    const restoredASnapshotWithIds = await snapshot(null, false);

    // B: killed after every operation of every step, then rerun.
    await recreateFreshDatabaseForBackupRestoreTest();
    let kills = 0;
    let invocationsB = 0;
    let killAfter = 1;
    let lastStart = "";
    const regressions: string[] = [];
    const untruthful: string[] = [];
    let lastReported = { phase: -1, index: -1 };
    let maxB = 0;
    outcome = { outcome: "pending", phase: "drop_triggers", itemIndex: 0 };
    for (let attempt = 0; attempt < 60_000; attempt += 1) {
      const start = await progressRow();
      const startKey = start === null ? "none" : `${start.phase}:${start.item_index}`;
      if (startKey !== lastStart) { killAfter = 1; lastStart = startKey; }
      const meter = newMeter();
      try {
        outcome = await continueVerifiedMemoryBackupRestore(operatorOptions(set, meteredDatabase(env.DB, meter, killAfter)));
      } catch (error) {
        // The history service wraps any storage error (including the simulated death) as memory_history_unavailable.
        if (!(error instanceof Killed) && !meter.killed) throw error;
        kills += 1;
        killAfter += start?.phase === "rebuild_history" && killAfter >= 6 ? 5 : 1;
        continue;
      }
      invocationsB += 1;
      maxB = Math.max(maxB, meter.executed);
      killAfter = 1;
      const after = await progressRow();
      const reportedPhase = outcome.outcome === "complete" ? "complete" : outcome.phase;
      const reportedIndex = outcome.outcome === "complete" ? 0 : outcome.itemIndex;
      if (after === null || after.phase !== reportedPhase || after.item_index !== reportedIndex) untruthful.push(`${reportedPhase}:${reportedIndex} db ${JSON.stringify(after)}`);
      const phaseIndex = PHASES.indexOf(reportedPhase);
      if (phaseIndex < lastReported.phase || (phaseIndex === lastReported.phase && reportedIndex < lastReported.index)) regressions.push(`${reportedPhase}:${reportedIndex}`);
      lastReported = { phase: phaseIndex, index: reportedIndex };
      if (outcome.outcome === "complete") break;
    }
    expect(outcome.outcome).toBe("complete");
    const reportB = outcome.outcome === "complete" ? outcome.report : null;
    const triggersAtComplete = await triggerCount();
    const restoredB = await snapshot(null, false);
    await finalizeVerifiedMemoryBackupRestore(env.DB, set.manifest.runId);
    const killDiffs = diffSnapshots(restoredASnapshotWithIds, restoredB);
    console.log("K1 killed", JSON.stringify({ kills, invocationsB, maxB, triggersAtComplete, sourceTriggers: source.triggers.size, regressions, untruthful: untruthful.slice(0, 5), killDiffs, reportB }));
    expect.soft(kills, "kills exercised").toBeGreaterThan(invocationsA);
    expect.soft(killDiffs, "killed-and-rerun restore vs uninterrupted").toEqual([]);
    expect.soft(triggersAtComplete, "triggers present when complete is reported").toBe(source.triggers.size);
    expect.soft(regressions, "reported progress never moves backwards").toEqual([]);
    expect.soft(untruthful, "reported progress equals the durable progress row").toEqual([]);
    expect.soft(maxB).toBeLessThan(1_000);
    expect.soft(canonicalJson(reportB), "report after kills equals uninterrupted report").toBe(canonicalJson(reportA));
    expect.soft(restoredA.cursors.size).toBeGreaterThan(0);
  }, 3_000_000);

  it("P1 a guest call admitted under a voice grant (call_sessions.guest_grant_id) restores with the operator's 64-statement pages", async () => {
    await fresh();
    await seedOwner();
    const grant = await seedGuestGrant();
    await seedGuestCall(grant);
    // Ordinary Telegram use: turns and deliveries sit between call_sessions and voice_access_grants in the table order.
    for (let i = 0; i < 36; i += 1) await telegramTurn(`Message ${i}`, new Date(Date.now() - (80 - i) * 60_000));
    const source = await snapshot(new Date(Date.now() - 48 * 3_600_000).toISOString(), false);
    const set = await backupToVerified();
    await recreateFreshDatabaseForBackupRestoreTest();
    let outcome: MemoryBackupRestoreStep = { outcome: "pending", phase: "drop_triggers", itemIndex: 0 };
    let error: string | null = null;
    let stuckAt: unknown = null;
    for (let i = 0; i < 500 && outcome.outcome === "pending"; i += 1) {
      try {
        outcome = await continueVerifiedMemoryBackupRestore(operatorOptions(set, env.DB));
      } catch (caught) {
        error = String(caught);
        stuckAt = await progressRow();
        break;
      }
    }
    let retry: string | null = null;
    if (error !== null) {
      retry = await continueVerifiedMemoryBackupRestore(operatorOptions(set, env.DB)).then(() => "advanced", (caught: unknown) => String(caught));
    }
    const triggers = await triggerCount();
    console.log("P1", JSON.stringify({ error, stuckAt, retry, triggersWhileStuck: triggers, sourceTriggers: source.triggers.size }));
    expect(error).toBeNull();
    expect(outcome.outcome).toBe("complete");
  }, 600_000);

  it("S1 safety refusals happen before any DDL: live database, newer set schema, unknown migration, a different set mid-restore, a tampered same-id set, and a completed-unfinalized restore", async () => {
    await fresh();
    await seedOwner();
    await appendConversation("I prefer tea.");
    await appendConversation("I am studying calculus.");
    const setA = await backupToVerified(new Date(Date.now() - 86_400_000));
    await appendConversation("A later message.");
    const setB = await backupToVerified();
    expect(setB.manifest.runId).not.toBe(setA.manifest.runId);
    const results: Record<string, unknown> = {};

    const attempt = async (label: string, options: ReturnType<typeof operatorOptions>, meter: Meter) => {
      const triggersBefore = await triggerCount();
      const progressBefore = await progressRow();
      const error = await continueVerifiedMemoryBackupRestore(options).then(() => null, (caught: unknown) => String(caught));
      results[label] = { error, ddl: ddlIn(meter).map((sql) => sql.slice(0, 40)), triggersBefore, triggersAfter: await triggerCount(), progressBefore, progressAfter: await progressRow() };
      return error;
    };

    // a. The live database itself.
    let meter = newMeter();
    expect.soft(await attempt("a live database", operatorOptions(setB, meteredDatabase(env.DB, meter)), meter)).toMatch(/target_not_fresh/u);
    expect.soft(ddlIn(meter), "a").toEqual([]);

    // b. A set whose schema is newer than the target and the code.
    await recreateFreshDatabaseForBackupRestoreTest();
    const newer = { ...setA, manifest: { ...setA.manifest, databaseSchemaVersion: "0032_future.sql" } };
    meter = newMeter();
    expect.soft(await attempt("b newer set schema", operatorOptions(newer, meteredDatabase(env.DB, meter)), meter)).not.toBeNull();
    expect.soft(ddlIn(meter), "b").toEqual([]);

    // c. Target migrated with a migration this code does not contain; set claims that schema.
    await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES ('0032_future.sql')").run();
    meter = newMeter();
    expect.soft(await attempt("c unknown migration receipt", operatorOptions(newer, meteredDatabase(env.DB, meter)), meter)).not.toBeNull();
    expect.soft(ddlIn(meter), "c").toEqual([]);
    // c2. Same target, the older set: its schema is not the target's last receipt.
    meter = newMeter();
    expect.soft(await attempt("c2 target migrated past the set", operatorOptions(setA, meteredDatabase(env.DB, meter)), meter)).toMatch(/schema_mismatch/u);
    expect.soft(ddlIn(meter), "c2").toEqual([]);

    // d. Partially restore A (into insert_rows with triggers dropped), then continue with B.
    await recreateFreshDatabaseForBackupRestoreTest();
    for (let i = 0; i < 400; i += 1) {
      const step = await continueVerifiedMemoryBackupRestore({ ...operatorOptions(setA, env.DB), maxStatementsPerStep: 8 });
      if (step.outcome === "pending" && step.phase === "insert_rows" && step.itemIndex > 0) break;
    }
    const partial = await progressRow();
    expect(partial?.phase).toBe("insert_rows");
    meter = newMeter();
    expect.soft(await attempt("d different set mid-restore", operatorOptions(setB, meteredDatabase(env.DB, meter)), meter)).toMatch(/progress_mismatch/u);
    expect.soft(ddlIn(meter), "d").toEqual([]);
    // e. Same manifest run id, different rows.
    const tamperedRows = new Map(setA.rowsByTable);
    tamperedRows.set("principals", (setA.rowsByTable.get("principals") ?? []).map((row) => ({ ...row, display_name: "Mallory" })));
    const tampered = { ...setA, rowsByTable: tamperedRows };
    meter = newMeter();
    expect.soft(await attempt("e same run id, different rows", operatorOptions(tampered, meteredDatabase(env.DB, meter)), meter)).toMatch(/progress_mismatch/u);
    expect.soft(ddlIn(meter), "e").toEqual([]);

    // f. Complete A without finalizing, then point B at it.
    for (let i = 0; i < 2_000; i += 1) {
      const step = await continueVerifiedMemoryBackupRestore({ ...operatorOptions(setA, env.DB), maxStatementsPerStep: 8 });
      if (step.outcome === "complete") break;
    }
    meter = newMeter();
    expect.soft(await attempt("f completed unfinalized, different set", operatorOptions(setB, meteredDatabase(env.DB, meter)), meter)).toMatch(/progress_mismatch/u);
    expect.soft(ddlIn(meter), "f").toEqual([]);
    console.log("S1", JSON.stringify(results));
  }, 900_000);

  it("S2 the operator's named migration list: a later repository migration is ignored for an older set", async () => {
    await fresh();
    await seedOwner();
    await appendConversation("I prefer tea.");
    const set = await backupToVerified();
    await recreateFreshDatabaseForBackupRestoreTest();
    const later = Object.freeze({ name: "0032_zz_later.sql", sql: "CREATE TABLE zz_later_table (id INTEGER PRIMARY KEY);\n\nCREATE TRIGGER zz_later_table_guard\nBEFORE INSERT ON zz_later_table\nBEGIN\n  SELECT RAISE(ABORT, 'zz') WHERE NEW.id < 0;\nEND;\n" });
    let outcome: MemoryBackupRestoreStep = { outcome: "pending", phase: "drop_triggers", itemIndex: 0 };
    let error: string | null = null;
    for (let i = 0; i < 500 && outcome.outcome === "pending"; i += 1) {
      try { outcome = await continueVerifiedMemoryBackupRestore(operatorOptions(set, env.DB, [...namedMigrations, later])); } catch (caught) { error = String(caught); break; }
    }
    const laterTrigger = await env.DB.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'zz_later_table_guard'").first("count");
    console.log("S2", JSON.stringify({ error, outcome: outcome.outcome, laterTrigger }));
    expect(error).toBeNull();
    expect(outcome.outcome).toBe("complete");
    expect(laterTrigger).toBe(0);
  }, 600_000);

  it("F1 a kill after finalize committed: rerunning the runbook's finalize and step reports the restore truthfully", async () => {
    await fresh();
    await seedOwner();
    await appendConversation("I prefer tea.");
    const set = await backupToVerified();
    await recreateFreshDatabaseForBackupRestoreTest();
    let outcome: MemoryBackupRestoreStep = { outcome: "pending", phase: "drop_triggers", itemIndex: 0 };
    for (let i = 0; i < 500 && outcome.outcome === "pending"; i += 1) outcome = await continueVerifiedMemoryBackupRestore(operatorOptions(set, env.DB));
    expect(outcome.outcome).toBe("complete");
    const meter = newMeter();
    const killed = await finalizeVerifiedMemoryBackupRestore(meteredDatabase(env.DB, meter, 3), set.manifest.runId).then(() => "not killed", (error: unknown) => String(error));
    const retryFinalize = await finalizeVerifiedMemoryBackupRestore(env.DB, set.manifest.runId).then(() => "finalized", (error: unknown) => String(error));
    const retryStep = await continueVerifiedMemoryBackupRestore(operatorOptions(set, env.DB)).then((step) => step.outcome, (error: unknown) => String(error));
    console.log("F1", JSON.stringify({ killed, retryFinalize, retryStep }));
    expect.soft(retryFinalize, "finalize retried after its commit").toBe("finalized");
    expect.soft(retryStep, "step retried after finalize").toBe("complete");
  }, 300_000);

  it("P2 a topic merged into a newer topic (memory_topics.redirect_to_topic_id) restores with the operator's 64-statement pages", async () => {
    await fresh();
    await seedOwner();
    const base = Date.now() - 10 * 3_600_000;
    const at = (offset: number) => new Date(base + offset * 1_000).toISOString();
    const root = newUlid(new Date(base));
    const older = newUlid(new Date(base + 1_000));
    const between = Array.from({ length: 80 }, (_, i) => newUlid(new Date(base + (10 + i) * 1_000)));
    const newer = newUlid(new Date(base + 500_000));
    await withTriggersDropped(async () => {
      const insert = (topicId: string, parent: string | null, name: string, status: string, redirect: string | null, offset: number) =>
        env.DB.prepare(`INSERT INTO memory_topics (topic_id, principal_id, parent_topic_id, display_name, normalized_name, status, redirect_to_topic_id, last_topic_event_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(topicId, OWNER, parent, name, name.toLowerCase(), status, redirect, newUlid(new Date(base + offset * 1_000)), at(offset), at(offset + 600));
      // As a real merge: the older topic exists first, the newer one is created later, then the older one is redirected.
      const statements = [insert(root, null, "Root", "active", null, 0), insert(older, root, "School", "active", null, 1)];
      for (let i = 0; i < 80; i += 1) statements.push(insert(between[i]!, root, `Topic ${i}`, "active", null, 10 + i));
      statements.push(insert(newer, root, "School work", "active", null, 500));
      statements.push(env.DB.prepare("UPDATE memory_topics SET status = 'merged', redirect_to_topic_id = ?, updated_at = ? WHERE topic_id = ?").bind(newer, at(1_200), older));
      await env.DB.batch(statements);
    });
    const set = await backupToVerified();
    const topics = set.rowsByTable.get("memory_topics") ?? [];
    const olderIndex = topics.findIndex((row) => row.topic_id === older);
    const newerIndex = topics.findIndex((row) => row.topic_id === newer);
    await recreateFreshDatabaseForBackupRestoreTest();
    let outcome: MemoryBackupRestoreStep = { outcome: "pending", phase: "drop_triggers", itemIndex: 0 };
    let error: string | null = null;
    let stuckAt: unknown = null;
    for (let i = 0; i < 500 && outcome.outcome === "pending"; i += 1) {
      try {
        outcome = await continueVerifiedMemoryBackupRestore(operatorOptions(set, env.DB));
      } catch (caught) {
        error = String(caught);
        stuckAt = await progressRow();
        break;
      }
    }
    console.log("P2", JSON.stringify({ topics: topics.length, olderIndex, newerIndex, error, stuckAt, triggers: await triggerCount() }));
    expect(error).toBeNull();
    expect(outcome.outcome).toBe("complete");
  }, 600_000);

  it("P0 foreign keys in MEMORY_BACKUP_TABLES order point only backwards (inventory)", async () => {
    await recreateFreshDatabaseForBackupRestoreTest();
    const order = new Map<string, number>(MEMORY_BACKUP_TABLES.map((t, i) => [t, i]));
    const forward: string[] = [];
    const self: string[] = [];
    let maxColumns = 0;
    for (const table of MEMORY_BACKUP_TABLES) {
      const fks = await env.DB.prepare(`PRAGMA foreign_key_list("${table}")`).all<{ table: string; from: string; to: string }>();
      const info = await env.DB.prepare(`PRAGMA table_info("${table}")`).all();
      maxColumns = Math.max(maxColumns, info.results.length);
      for (const fk of fks.results) {
        if (fk.table === table) self.push(`${table}.${fk.from}->${fk.to}`);
        else if (order.get(fk.table)! > order.get(table)!) forward.push(`${table}.${fk.from}->${fk.table}.${fk.to}`);
      }
    }
    console.log("P0", JSON.stringify({ forward, self, maxColumns }));
    expect(forward).toEqual([]);
  }, 120_000);
});
