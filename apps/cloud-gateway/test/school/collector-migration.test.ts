import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { sha256Hex } from "../../../../packages/contracts/src/index.js";
import { MEMORY_BACKUP_RESTORE_MIGRATIONS } from "../../src/backup/memory-backup-restore-migrations.js";
import { splitMigration } from "../persistence/migration.js";
import { collectorFixture, observedBatch, bytes } from "./collector-fixtures.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { DeadlineIngestion } from "../../src/deadlines/deadline-ingestion.js";
import { mapSchoolCourse } from "../../src/school/collector-mapping.js";
import { SchoolCollectorRepository } from "../../src/school/collector-repository.js";

const migrationName = "0045_school_collector_hosts.sql";
beforeAll(async () => {
  await applyD1Migrations(env.DB, MEMORY_BACKUP_RESTORE_MIGRATIONS.filter((row) => row.name < migrationName)
    .map((row) => ({ name: row.name, queries: splitMigration(row.sql) })));
});

it("migrates existing LDSB projections without changing deadline identities, revisions, reminders or status", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  const oldSource = `d2l-api:${f.courseId}`;
  const newSource = `d2l-api:ldsb.elearningontario.ca:${f.courseId}`;
  const deadlines = new DeadlineRepository(env.DB);
  await deadlines.ensureSource({ sourceId: oldSource, kind: "brightspace", label: "Brightspace session API", now: f.clock() });
  await new DeadlineIngestion({ repository: deadlines, now: f.clock }).ingest(oldSource, { kind: "items", items: mapSchoolCourse(batch).deadlines });
  await env.DB.prepare("UPDATE deadlines SET status = 'submitted', reminded_at = ? WHERE source_id = ?").bind(f.clock().toISOString(), oldSource).run();
  const before = await env.DB.prepare("SELECT * FROM deadlines WHERE source_id = ?").bind(oldSource).first<Record<string, unknown>>();
  const revisions = await env.DB.prepare("SELECT * FROM deadline_revisions WHERE deadline_id = ? ORDER BY revision_id").bind(before!.deadline_id).all();
  await env.DB.prepare(`INSERT INTO school_collector_reads (collector_id, read_id, principal_id, started_at, course_ids_json, enrollment_complete, received_at)
    VALUES (?, 'legacy-read', ?, ?, ?, 1, ?)`)
    .bind(f.key.collector_id, f.owner, batch.startedAt, JSON.stringify(batch.courseIds), batch.startedAt).run();
  const migration = MEMORY_BACKUP_RESTORE_MIGRATIONS.find((row) => row.name === migrationName)!;
  await applyD1Migrations(env.DB, [{ name: migration.name, queries: splitMigration(migration.sql) }]);
  expect(await env.DB.prepare("SELECT * FROM deadlines WHERE source_id = ?").bind(newSource).first()).toEqual({ ...before, source_id: newSource });
  expect((await deadlines.readSource(oldSource))?.active).toBe(false);
  expect((await deadlines.readSource(newSource))?.active).toBe(true);
  expect(await env.DB.prepare("SELECT host FROM school_collector_reads WHERE read_id = 'legacy-read'").first()).toEqual({ host: "ldsb.elearningontario.ca" });
  await new SchoolCollectorRepository(env.DB, f.owner, f.clock).ingest(f.key.collector_id, batch, await sha256Hex(bytes(batch)));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deadlines WHERE source_id IN (?, ?)").bind(oldSource, newSource).first()).toEqual({ n: 1 });
  expect((await env.DB.prepare("SELECT * FROM deadline_revisions WHERE deadline_id = ? ORDER BY revision_id").bind(before!.deadline_id).all()).results).toEqual(revisions.results);
  expect((await env.DB.prepare("SELECT deadline_id, status, reminded_at FROM deadlines WHERE source_id = ?").bind(newSource).first()))
    .toEqual({ deadline_id: before!.deadline_id, status: "submitted", reminded_at: before!.reminded_at });
});
