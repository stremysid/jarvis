import { newUlid } from "../../../../packages/contracts/src/index.js";
import { ArchivalService } from "../archive/archival-service.js";
import { ArchiveRepository } from "../archive/archive-repository.js";
import { TieredEventReader } from "../archive/tiered-event-reader.js";
import { LiteralHistoryService } from "../memory/literal-history.js";
import { EventRepository } from "../persistence/event-repository.js";
import {
  continueVerifiedMemoryBackupRestore,
  finalizeVerifiedMemoryBackupRestore,
  readVerifiedMemoryBackupByPointer,
} from "./memory-backup-restore.js";
import { MEMORY_BACKUP_RESTORE_MIGRATIONS } from "./memory-backup-restore-migrations.js";

interface RestoreOperatorEnvironment {
  readonly DB: D1Database;
  readonly ARCHIVE: R2Bucket;
  readonly BACKUP: R2Bucket;
  readonly RESTORE_TARGET_DATABASE_NAME: string;
  readonly RESTORE_CONFIRMED_DATABASE_NAME: string;
  readonly RESTORE_OPERATOR_TOKEN: string;
  readonly RESTORE_RUN_DATE: string;
  readonly RESTORE_RUN_ID: string;
  readonly RESTORE_MANIFEST_OBJECT_KEY: string;
  readonly RESTORE_MANIFEST_SHA256: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function authorize(request: Request, env: RestoreOperatorEnvironment): Response | null {
  if (!/^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$/u.test(env.RESTORE_TARGET_DATABASE_NAME)
    || env.RESTORE_CONFIRMED_DATABASE_NAME !== env.RESTORE_TARGET_DATABASE_NAME) {
    return json({ error: "memory_backup_restore_target_not_confirmed" }, 409);
  }
  if (env.RESTORE_OPERATOR_TOKEN.length < 32
    || request.headers.get("authorization") !== `Bearer ${env.RESTORE_OPERATOR_TOKEN}`) {
    return json({ error: "memory_backup_restore_operator_unauthorized" }, 401);
  }
  return null;
}

function historyStep(env: RestoreOperatorEnvironment): () => Promise<boolean> {
  return async () => {
    const principals = await env.DB.prepare(`SELECT principal_id FROM principals
      WHERE principal_type = 'human' ORDER BY principal_id`).all<{ principal_id: string }>();
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const archiveState = new ArchiveRepository(env.DB);
    const history = new LiteralHistoryService({
      database: env.DB,
      events: new TieredEventReader({
        live: new EventRepository(env.DB),
        archive,
        state: archiveState,
      }),
      archive: archiveState,
      now: () => new Date(),
      nextId: () => newUlid(),
    });
    let complete = true;
    for (const { principal_id: principalId } of principals.results) {
      const result = await history.indexNext({
        principalId,
        maxEvents: 16,
        maxTextBytes: 128 * 1024,
      });
      complete &&= result.complete;
    }
    return complete;
  };
}

async function step(env: RestoreOperatorEnvironment): Promise<Response> {
  const set = await readVerifiedMemoryBackupByPointer(env.BACKUP, {
    schemaVersion: "1.0",
    runDate: env.RESTORE_RUN_DATE,
    runId: env.RESTORE_RUN_ID,
    manifestObjectKey: env.RESTORE_MANIFEST_OBJECT_KEY,
    manifestSha256: env.RESTORE_MANIFEST_SHA256,
  });
  const outcome = await continueVerifiedMemoryBackupRestore({
    database: env.DB,
    databaseSchemaVersion: set.manifest.databaseSchemaVersion,
    rowsByTable: set.rowsByTable,
    migrationSql: MEMORY_BACKUP_RESTORE_MIGRATIONS,
    restoreId: set.manifest.runId,
    maxStatementsPerStep: 64,
    jobs: {
      rebuildHistory: historyStep(env),
      // The repository has no Vectorize writer. Scratch rehearsal proves D1;
      // the runbook keeps promotion blocked until a reviewed writer is supplied.
      rebuildVectors: async () => true,
    },
    shortfalls: Object.fromEntries(
      set.manifest.tableCuts.map((cut) => [cut.table, cut.shortfallRowCount]),
    ),
  });
  return json({
    ...outcome,
    restoreId: set.manifest.runId,
    databaseSchemaVersion: set.manifest.databaseSchemaVersion,
    vectorRebuild: "unavailable",
  });
}

export default {
  async fetch(request: Request, env: RestoreOperatorEnvironment): Promise<Response> {
    const rejection = authorize(request, env);
    if (rejection !== null) return rejection;
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    try {
      if (path === "/step") return await step(env);
      if (path === "/finalize") {
        const restoreId = request.headers.get("x-restore-id");
        if (restoreId === null || restoreId.length === 0) {
          return json({ error: "memory_backup_restore_id_missing" }, 400);
        }
        await finalizeVerifiedMemoryBackupRestore(env.DB, restoreId);
        return json({ outcome: "finalized", restoreId });
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({
        error: error instanceof Error && /^memory_backup_restore_[a-z0-9_:.-]+$/u.test(error.message)
          ? error.message
          : "memory_backup_restore_operator_failed",
      }, 409);
    }
  },
};
