import { applyD1Migrations, env } from "cloudflare:test";
import { splitMigration } from "../../../../scripts/split-migration.mjs";
import foundationSql from "../../src/persistence/migrations/0001_foundation.sql?raw";
import foundationHardeningSql from "../../src/persistence/migrations/0002_foundation_hardening.sql?raw";
import callingSql from "../../src/persistence/migrations/0003_calling.sql?raw";
import callSessionsSql from "../../src/persistence/migrations/0004_call_sessions.sql?raw";
import conversationSql from "../../src/persistence/migrations/0005_conversation.sql?raw";
import voiceAccessSql from "../../src/persistence/migrations/0006_voice_access.sql?raw";
import voiceAccessBoundariesSql from "../../src/persistence/migrations/0007_voice_access_boundaries.sql?raw";
import autonomySql from "../../src/persistence/migrations/0008_autonomy.sql?raw";
import decisionsSql from "../../src/persistence/migrations/0009_decisions.sql?raw";
import projectsSql from "../../src/persistence/migrations/0010_projects.sql?raw";
import deadlinesSql from "../../src/persistence/migrations/0011_deadlines.sql?raw";
import livenessSql from "../../src/persistence/migrations/0012_liveness.sql?raw";
import scheduledRunsSql from "../../src/persistence/migrations/0013_scheduled_runs.sql?raw";
import memoryProjectionSql from "../../src/persistence/migrations/0014_memory_projection.sql?raw";
import voiceRuntimeSql from "../../src/persistence/migrations/0015_voice_runtime.sql?raw";
import cloudMemorySql from "../../src/persistence/migrations/0016_cloud_memory.sql?raw";
import ownerPassphraseSql from "../../src/persistence/migrations/0017_owner_passphrase.sql?raw";
import ownerCallStepUpSql from "../../src/persistence/migrations/0018_owner_call_step_up.sql?raw";
import memoryIngressSql from "../../src/persistence/migrations/0019_memory_ingress.sql?raw";
import schoolCatchupSql from "../../src/persistence/migrations/0020_school_catchup.sql?raw";
import voiceOwnerDeliverySql from "../../src/persistence/migrations/0021_voice_owner_delivery.sql?raw";
import universityTrackerSql from "../../src/persistence/migrations/0022_university_tracker.sql?raw";
import studyCoachSql from "../../src/persistence/migrations/0023_study_coach.sql?raw";
import universityApplicationWorkflowSql from "../../src/persistence/migrations/0024_university_application_workflow.sql?raw";
import archiveLiteralHistorySql from "../../src/persistence/migrations/0025_archive_literal_history.sql?raw";
import memoryDistillationSql from "../../src/persistence/migrations/0026_memory_distillation.sql?raw";
import schoolObservationsSql from "../../src/persistence/migrations/0027_school_observations.sql?raw";
import guestGrantNoticeDrainSql from "../../src/persistence/migrations/0028_guest_grant_notice_drain.sql?raw";
import universityApplicationDetailsSql from "../../src/persistence/migrations/0029_university_application_details.sql?raw";
import studyCoachWeakSpotsSql from "../../src/persistence/migrations/0030_study_coach_weak_spots.sql?raw";
import memoryBackupSql from "../../src/persistence/migrations/0031_memory_backup.sql?raw";
import memoryLivingNotesSql from "../../src/persistence/migrations/0032_memory_living_notes.sql?raw";
import d2lNotificationEmailSql from "../../src/persistence/migrations/0033_d2l_notification_email.sql?raw";
import scheduledRunDetailSql from "../../src/persistence/migrations/0034_scheduled_run_detail.sql?raw";
import autonomyToolCapabilitiesSql from "../../src/persistence/migrations/0035_autonomy_tool_capabilities.sql?raw";
import memoryLifetimeAndPinsSql from "../../src/persistence/migrations/0038_memory_lifetime_and_pins.sql?raw";
import toolConfirmationConsumptionsSql from "../../src/persistence/migrations/0039_tool_confirmation_consumptions.sql?raw";
import schoolCollectorSql from "../../src/persistence/migrations/0040_school_collector_keys.sql?raw";
import guidedAssignmentSql from "../../src/persistence/migrations/0043_guided_assignment.sql?raw";
import schoolCollectorHostsSql from "../../src/persistence/migrations/0045_school_collector_hosts.sql?raw";
import noteSourcesWithoutMarkdownCitationSql from "../../src/persistence/migrations/0047_note_sources_without_markdown_citation.sql?raw";

let scheduledRunDetailMigrated: Promise<void> | undefined;
let newestRuntimeMigrated: Promise<void> | undefined;
let migrated: Promise<void> | undefined;
let voiceRuntimeMigrated: Promise<void> | undefined;
let cloudMemoryMigrated: Promise<void> | undefined;
let ownerPassphraseMigrated: Promise<void> | undefined;
let ownerCallStepUpMigrated: Promise<void> | undefined;
let memoryIngressMigrated: Promise<void> | undefined;
let schoolCatchupMigrated: Promise<void> | undefined;
let voiceOwnerDeliveryMigrated: Promise<void> | undefined;
let universityTrackerMigrated: Promise<void> | undefined;
let studyCoachMigrated: Promise<void> | undefined;
let universityApplicationWorkflowMigrated: Promise<void> | undefined;
let archiveLiteralHistoryMigrated: Promise<void> | undefined;
let memoryDistillationMigrated: Promise<void> | undefined;
let schoolObservationsMigrated: Promise<void> | undefined;
let guestGrantNoticeDrainMigrated: Promise<void> | undefined;
let universityApplicationDetailsMigrated: Promise<void> | undefined;
let studyCoachWeakSpotsMigrated: Promise<void> | undefined;
let memoryBackupMigrated: Promise<void> | undefined;
let memoryLivingNotesMigrated: Promise<void> | undefined;
let d2lNotificationEmailMigrated: Promise<void> | undefined;
let memoryLifetimeAndPinsMigrated: Promise<void> | undefined;

export { splitMigration };

export const voiceAccessBaseMigrations = Object.freeze([
  { name: "0001_foundation.sql", queries: splitMigration(foundationSql) },
  { name: "0002_foundation_hardening.sql", queries: splitMigration(foundationHardeningSql) },
  { name: "0003_calling.sql", queries: splitMigration(callingSql) },
  { name: "0004_call_sessions.sql", queries: splitMigration(callSessionsSql) },
  { name: "0005_conversation.sql", queries: splitMigration(conversationSql) },
  { name: "0006_voice_access.sql", queries: splitMigration(voiceAccessSql) },
]);

export const voiceAccessBoundariesMigration = Object.freeze({
  name: "0007_voice_access_boundaries.sql",
  queries: splitMigration(voiceAccessBoundariesSql),
});

/**
 * Everything after the voice-access boundary. Kept separate from
 * `voiceAccessBaseMigrations` because those two exports name the exact point
 * the voice-access tests reconstruct, and appending here would silently
 * change what they are testing.
 */
export const assistantMigrations = Object.freeze([
  { name: "0008_autonomy.sql", queries: splitMigration(autonomySql) },
  { name: "0009_decisions.sql", queries: splitMigration(decisionsSql) },
  { name: "0010_projects.sql", queries: splitMigration(projectsSql) },
  { name: "0011_deadlines.sql", queries: splitMigration(deadlinesSql) },
  { name: "0012_liveness.sql", queries: splitMigration(livenessSql) },
  { name: "0013_scheduled_runs.sql", queries: splitMigration(scheduledRunsSql) },
  { name: "0014_memory_projection.sql", queries: splitMigration(memoryProjectionSql) },
]);

/** Applies the deployable Wrangler migration to the actual D1 test binding once. */
export function applyFoundationMigration(): Promise<void> {
  migrated ??= applyD1Migrations(env.DB, [
    ...voiceAccessBaseMigrations,
    voiceAccessBoundariesMigration,
    ...assistantMigrations,
  ]);
  return migrated;
}

/** R1 production adapter tests opt into the additive runtime migration. */
export async function applyVoiceRuntimeMigration(): Promise<void> {
  await applyFoundationMigration();
  voiceRuntimeMigrated ??= applyD1Migrations(env.DB, [
    { name: "0015_voice_runtime.sql", queries: splitMigration(voiceRuntimeSql) },
  ]);
  await voiceRuntimeMigrated;
}

/** Applies the reviewed cloud-memory schema only to the isolated D1 test binding. */
export async function applyCloudMemoryMigration(): Promise<void> {
  await applyVoiceRuntimeMigration();
  cloudMemoryMigrated ??= applyD1Migrations(env.DB, [
    { name: "0016_cloud_memory.sql", queries: splitMigration(cloudMemorySql) },
  ]);
  await cloudMemoryMigrated;
}

/** Applies the privileged memory-command ingress contract after 0016. */
export async function applyMemoryIngressMigration(): Promise<void> {
  await applyCloudMemoryMigration();
  await applyOwnerCallStepUpMigration();
  memoryIngressMigrated ??= applyD1Migrations(env.DB, [
    { name: "0019_memory_ingress.sql", queries: splitMigration(memoryIngressSql) },
    // 0038 belongs here and not only in `applyNewestRuntimeMigration`: it alters
    // `memory_items`, so every memory fixture needs it, and one that stopped at
    // 0019 built an item table with no `lifetime` column. That surfaced as
    // `memory_unavailable` from every commit -- which reads as a database fault
    // rather than a missing migration, the same shape as 0038 missing from the
    // other two lists.
    {
      name: "0038_memory_lifetime_and_pins.sql",
      queries: splitMigration(memoryLifetimeAndPinsSql),
    },
    { name: "0039_tool_confirmation_consumptions.sql", queries: splitMigration(toolConfirmationConsumptionsSql) },
    { name: "0043_guided_assignment.sql", queries: splitMigration(guidedAssignmentSql) },
  ]);
  await memoryIngressMigrated;
}

/** Applies the owner-passphrase verifier schema after the current R1 runtime. */
export async function applyOwnerPassphraseMigration(): Promise<void> {
  await applyFoundationMigration();
  ownerPassphraseMigrated ??= applyD1Migrations(env.DB, [
    { name: "0017_owner_passphrase.sql", queries: splitMigration(ownerPassphraseSql) },
  ]);
  await ownerPassphraseMigrated;
}

/** Applies the durable owner-call step-up schema and authority boundary. */
export async function applyOwnerCallStepUpMigration(): Promise<void> {
  await applyOwnerPassphraseMigration();
  ownerCallStepUpMigrated ??= applyD1Migrations(env.DB, [
    { name: "0018_owner_call_step_up.sql", queries: splitMigration(ownerCallStepUpSql) },
  ]);
  await ownerCallStepUpMigrated;
}

/** Applies durable refusal completion and guest-notice delivery after current main. */
export async function applyVoiceOwnerDeliveryMigration(): Promise<void> {
  // This migration depends on 0018 but not the intervening memory schema.
  // Keeping the isolated voice fixtures narrow avoids installing unrelated
  // runtime controls that those fixtures deliberately replace with fakes.
  await applyOwnerCallStepUpMigration();
  voiceOwnerDeliveryMigrated ??= applyD1Migrations(env.DB, [
    { name: "0021_voice_owner_delivery.sql", queries: splitMigration(voiceOwnerDeliverySql) },
  ]);
  await voiceOwnerDeliveryMigrated;
}

/** Applies the private school catch-up store to the isolated D1 test binding. */
export async function applySchoolCatchupMigration(): Promise<void> {
  await applyMemoryIngressMigration();
  schoolCatchupMigrated ??= applyD1Migrations(env.DB, [
    { name: "0020_school_catchup.sql", queries: splitMigration(schoolCatchupSql) },
  ]);
  await schoolCatchupMigrated;
}

/** Applies the conversational university tracker after the school catch-up store. */
export async function applyUniversityTrackerMigration(): Promise<void> {
  await applySchoolCatchupMigration();
  universityTrackerMigrated ??= applyD1Migrations(env.DB, [
    { name: "0022_university_tracker.sql", queries: splitMigration(universityTrackerSql) },
  ]);
  await universityTrackerMigrated;
}

/** Applies the operational study-coach store after the school trackers. */
export async function applyStudyCoachMigration(): Promise<void> {
  await applyUniversityTrackerMigration();
  studyCoachMigrated ??= applyD1Migrations(env.DB, [
    { name: "0023_study_coach.sql", queries: splitMigration(studyCoachSql) },
  ]);
  await studyCoachMigrated;
}

/** Applies the owner-reported application checklist after the study-coach store. */
export async function applyUniversityApplicationWorkflowMigration(): Promise<void> {
  await applyStudyCoachMigration();
  universityApplicationWorkflowMigrated ??= applyD1Migrations(env.DB, [
    { name: "0024_university_application_workflow.sql", queries: splitMigration(universityApplicationWorkflowSql) },
  ]);
  await universityApplicationWorkflowMigrated;
}

/** Applies append-only application preparation and owner-reported workflow revisions. */
export async function applyUniversityApplicationDetailsMigration(): Promise<void> {
  await applyUniversityApplicationWorkflowMigration();
  universityApplicationDetailsMigrated ??= applyD1Migrations(env.DB, [
    { name: "0029_university_application_details.sql", queries: splitMigration(universityApplicationDetailsSql) },
  ]);
  await universityApplicationDetailsMigrated;
}

/** Applies durable archive-complete literal-search jobs after memory ingress. */
export async function applyArchiveLiteralHistoryMigration(): Promise<void> {
  await applyMemoryIngressMigration();
  archiveLiteralHistoryMigrated ??= applyD1Migrations(env.DB, [
    { name: "0025_archive_literal_history.sql", queries: splitMigration(archiveLiteralHistorySql) },
  ]);
  await archiveLiteralHistoryMigrated;
}

/** Applies automatic-distillation receipts and cursor guards after literal history. */
export async function applyMemoryDistillationMigration(): Promise<void> {
  await applyArchiveLiteralHistoryMigration();
  memoryDistillationMigrated ??= applyD1Migrations(env.DB, [
    { name: "0026_memory_distillation.sql", queries: splitMigration(memoryDistillationSql) },
  ]);
  await memoryDistillationMigrated;
}

/** Applies verified school observations and derived missing-work transitions. */
export async function applySchoolObservationsMigration(): Promise<void> {
  await applyStudyCoachMigration();
  await applyArchiveLiteralHistoryMigration();
  schoolObservationsMigrated ??= applyD1Migrations(env.DB, [
    { name: "0027_school_observations.sql", queries: splitMigration(schoolObservationsSql) },
  ]);
  await schoolObservationsMigrated;
}

/** Applies fair, resumable guest-notice drain state after the delivery outbox. */
export async function applyGuestGrantNoticeDrainMigration(): Promise<void> {
  await applyVoiceOwnerDeliveryMigration();
  guestGrantNoticeDrainMigrated ??= applyD1Migrations(env.DB, [
    { name: "0028_guest_grant_notice_drain.sql", queries: splitMigration(guestGrantNoticeDrainSql) },
  ]);
  await guestGrantNoticeDrainMigrated;
}

/** Applies durable daily study claims and direct-owner signal controls. */
export async function applyStudyCoachWeakSpotsMigration(): Promise<void> {
  await applySchoolObservationsMigration();
  await applyGuestGrantNoticeDrainMigration();
  studyCoachWeakSpotsMigrated ??= applyD1Migrations(env.DB, [
    { name: "0030_study_coach_weak_spots.sql", queries: splitMigration(studyCoachWeakSpotsSql) },
  ]);
  await studyCoachWeakSpotsMigrated;
}

/** Applies durable custom-backup cuts, progress, verification and alert claims. */
export async function applyMemoryBackupMigration(): Promise<void> {
  await applyStudyCoachWeakSpotsMigration();
  await applyUniversityApplicationDetailsMigration();
  await applyMemoryDistillationMigration();
  memoryBackupMigrated ??= applyD1Migrations(env.DB, [
    { name: "0031_memory_backup.sql", queries: splitMigration(memoryBackupSql) },
  ]);
  await memoryBackupMigrated;
}

/** Applies living-note history, receipts and immediate derivation redaction. */
export async function applyMemoryLivingNotesMigration(): Promise<void> {
  await applyMemoryBackupMigration();
  memoryLivingNotesMigrated ??= applyD1Migrations(env.DB, [
    { name: "0032_memory_living_notes.sql", queries: splitMigration(memoryLivingNotesSql) },
    // 0047 rewrites a trigger 0032 creates, so it belongs beside it: a fixture
    // that stops at 0032 still carries the markdown-citation clause the product
    // removed, and its notes would be refused by the database, not by any code
    // under test. It is also in every full-chain list below.
    {
      name: "0047_note_sources_without_markdown_citation.sql",
      queries: splitMigration(noteSourcesWithoutMarkdownCitationSql),
    },
  ]);
  await memoryLivingNotesMigrated;
}

/**
 * Applies the newest prefix of the runtime schema.
 *
 * Named for the migration that introduced it and extended here, so every
 * fixture that already asked for the current schema keeps getting the current
 * schema instead of silently pinning itself one migration back.
 */
export async function applyNewestRuntimeMigration(): Promise<void> {
  await applyMemoryLivingNotesMigration();
  newestRuntimeMigrated ??= applyD1Migrations(env.DB, [
    { name: "0033_d2l_notification_email.sql", queries: splitMigration(d2lNotificationEmailSql) },
    { name: "0034_scheduled_run_detail.sql", queries: splitMigration(scheduledRunDetailSql) },
    {
      name: "0035_autonomy_tool_capabilities.sql",
      queries: splitMigration(autonomyToolCapabilitiesSql),
    },
    {
      name: "0038_memory_lifetime_and_pins.sql",
      queries: splitMigration(memoryLifetimeAndPinsSql),
    },
    { name: "0039_tool_confirmation_consumptions.sql", queries: splitMigration(toolConfirmationConsumptionsSql) },
    { name: "0040_school_collector_keys.sql", queries: splitMigration(schoolCollectorSql) },
    { name: "0043_guided_assignment.sql", queries: splitMigration(guidedAssignmentSql) },
    { name: "0045_school_collector_hosts.sql", queries: splitMigration(schoolCollectorHostsSql) },
  ]);
  await newestRuntimeMigrated;
}

/**
 * Aliases for the newest prefix.
 *
 * The previous name described the migration that introduced it, and stopped
 * being true the moment another landed -- while every fixture that asked for
 * "the current schema" kept silently getting one migration less. Naming the
 * function after what it is fixes that, and the aliases keep existing callers
 * honest rather than rewritten.
 */
export const applyD2lNotificationEmailMigration = applyNewestRuntimeMigration;
export const applyAutonomyToolCapabilitiesMigration = applyNewestRuntimeMigration;

const allCloudGatewayMigrations = Object.freeze([
  ...voiceAccessBaseMigrations,
  voiceAccessBoundariesMigration,
  ...assistantMigrations,
  { name: "0015_voice_runtime.sql", queries: splitMigration(voiceRuntimeSql) },
  { name: "0016_cloud_memory.sql", queries: splitMigration(cloudMemorySql) },
  { name: "0017_owner_passphrase.sql", queries: splitMigration(ownerPassphraseSql) },
  { name: "0018_owner_call_step_up.sql", queries: splitMigration(ownerCallStepUpSql) },
  { name: "0019_memory_ingress.sql", queries: splitMigration(memoryIngressSql) },
  { name: "0020_school_catchup.sql", queries: splitMigration(schoolCatchupSql) },
  { name: "0021_voice_owner_delivery.sql", queries: splitMigration(voiceOwnerDeliverySql) },
  { name: "0022_university_tracker.sql", queries: splitMigration(universityTrackerSql) },
  { name: "0023_study_coach.sql", queries: splitMigration(studyCoachSql) },
  { name: "0024_university_application_workflow.sql", queries: splitMigration(universityApplicationWorkflowSql) },
  { name: "0025_archive_literal_history.sql", queries: splitMigration(archiveLiteralHistorySql) },
  { name: "0026_memory_distillation.sql", queries: splitMigration(memoryDistillationSql) },
  { name: "0027_school_observations.sql", queries: splitMigration(schoolObservationsSql) },
  { name: "0028_guest_grant_notice_drain.sql", queries: splitMigration(guestGrantNoticeDrainSql) },
  { name: "0029_university_application_details.sql", queries: splitMigration(universityApplicationDetailsSql) },
  { name: "0030_study_coach_weak_spots.sql", queries: splitMigration(studyCoachWeakSpotsSql) },
  { name: "0031_memory_backup.sql", queries: splitMigration(memoryBackupSql) },
  { name: "0032_memory_living_notes.sql", queries: splitMigration(memoryLivingNotesSql) },
  { name: "0033_d2l_notification_email.sql", queries: splitMigration(d2lNotificationEmailSql) },
  { name: "0034_scheduled_run_detail.sql", queries: splitMigration(scheduledRunDetailSql) },
  {
    name: "0035_autonomy_tool_capabilities.sql",
    queries: splitMigration(autonomyToolCapabilitiesSql),
  },
  {
    name: "0038_memory_lifetime_and_pins.sql",
    queries: splitMigration(memoryLifetimeAndPinsSql),
  },
  { name: "0039_tool_confirmation_consumptions.sql", queries: splitMigration(toolConfirmationConsumptionsSql) },
  { name: "0040_school_collector_keys.sql", queries: splitMigration(schoolCollectorSql) },
  { name: "0043_guided_assignment.sql", queries: splitMigration(guidedAssignmentSql) },
  { name: "0045_school_collector_hosts.sql", queries: splitMigration(schoolCollectorHostsSql) },
  { name: "0047_note_sources_without_markdown_citation.sql", queries: splitMigration(noteSourcesWithoutMarkdownCitationSql) },
]);

/**
 * The names this fixture applies, for the parity guard in
 * `migration-list-parity.test.ts`.
 *
 * Exported because the defect that guard exists for was exactly this list
 * drifting: `0038` was added to `applyNewestRuntimeMigration` and nowhere else,
 * so the restore fixture rebuilt a target without its tables and a healthy
 * backup then failed as though it were an operational fault.
 */
export function allCloudGatewayMigrationNames(): readonly string[] {
  return allCloudGatewayMigrations.map(({ name }) => name);
}

/** Rebuilds this isolated test binding as a newly migrated restore target. */
export async function recreateFreshDatabaseForBackupRestoreTest(): Promise<void> {
  await applyD2lNotificationEmailMigration();
  const virtualTables = await env.DB.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`).all<{ name: string }>();
  const views = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'view'")
    .all<{ name: string }>();
  const triggers = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
    .all<{ name: string }>();
  // `_cf_` is D1's reserved namespace, so a DROP or CREATE inside it is refused;
  // leave those tables alone instead of reading Cloudflare's bookkeeping as schema.
  const tables = await env.DB.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_'`)
    .all<{ name: string }>();
  const virtualNames = virtualTables.results.map(({ name }) => name);
  const regularNames = tables.results.map(({ name }) => name).filter((name) =>
    !virtualNames.includes(name) && !virtualNames.some((virtual) => name.startsWith(`${virtual}_`)));
  const foreignKeys = await env.DB.batch(regularNames.map((name) => {
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error("test_schema_name_invalid");
    return env.DB.prepare(`PRAGMA foreign_key_list(${name})`);
  }));
  const dependencies = new Map(regularNames.map((name) => [name, new Set<string>()]));
  const incoming = new Map(regularNames.map((name) => [name, 0]));
  for (let index = 0; index < regularNames.length; index += 1) {
    const child = regularNames[index]!;
    for (const row of ((foreignKeys[index]?.results as Array<{ table: string }> | undefined) ?? [])) {
      if (row.table === child || !dependencies.has(row.table) || dependencies.get(child)?.has(row.table)) continue;
      dependencies.get(child)?.add(row.table);
      incoming.set(row.table, (incoming.get(row.table) ?? 0) + 1);
    }
  }
  const ready = regularNames.filter((name) => incoming.get(name) === 0);
  const dropOrder: string[] = [];
  while (ready.length > 0) {
    const child = ready.shift()!;
    dropOrder.push(child);
    for (const parent of dependencies.get(child) ?? []) {
      const next = (incoming.get(parent) ?? 0) - 1;
      incoming.set(parent, next);
      if (next === 0) ready.push(parent);
    }
  }
  dropOrder.push(...regularNames.filter((name) => !dropOrder.includes(name)).reverse());
  const dropStatements: D1PreparedStatement[] = [env.DB.prepare("PRAGMA defer_foreign_keys = ON")];
  for (const { name } of triggers.results) {
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error("test_schema_name_invalid");
    dropStatements.push(env.DB.prepare(`DROP TRIGGER ${name}`));
  }
  for (const { name } of views.results) {
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error("test_schema_name_invalid");
    dropStatements.push(env.DB.prepare(`DROP VIEW ${name}`));
  }
  for (const name of virtualNames) {
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error("test_schema_name_invalid");
    dropStatements.push(env.DB.prepare(`DROP TABLE ${name}`));
  }
  for (const name of dropOrder) {
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error("test_schema_name_invalid");
    dropStatements.push(env.DB.prepare(`DROP TABLE ${name}`));
  }
  await env.DB.batch(dropStatements);
  await applyD1Migrations(env.DB, [...allCloudGatewayMigrations]);
  await env.DB.exec("PRAGMA foreign_keys = ON");
}

/** Test-only reset that preserves and restores every production backup guard. */
export async function clearMemoryBackupDataForTest(): Promise<void> {
  // Backup's authoritative inventory must always have its newest tables. A
  // partial schema makes a healthy backup look like an operational failure.
  await applyD2lNotificationEmailMigration();
  const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name LIKE 'memory_backup_%'`)
    .all<{ name: string; sql: string }>();
  for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${guard.name}`).run();
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memory_backup_alerts"),
      env.DB.prepare("DELETE FROM memory_backup_objects"),
      env.DB.prepare("DELETE FROM memory_backup_table_cuts"),
      env.DB.prepare("DELETE FROM memory_backup_runs"),
      env.DB.prepare("DELETE FROM memory_backup_row_ordinals"),
    ]);
  } finally {
    for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
  }
}

/** Test-only reset for the singleton drain checkpoint. */
export async function clearGuestGrantNoticeDrainStateForTest(): Promise<void> {
  await applyGuestGrantNoticeDrainMigration();
  const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = 'guest_grant_notice_drain_state'`)
    .all<{ name: string; sql: string }>();
  for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${guard.name}`).run();
  try {
    await env.DB.prepare("DELETE FROM guest_grant_notice_drain_state").run();
    await env.DB.prepare(`INSERT INTO guest_grant_notice_drain_state (
      singleton_id, status, cursor_created_at, cursor_mutation_id,
      run_id, lease_expires_at, updated_at, failure_code
    ) VALUES (1, 'ready', NULL, NULL, NULL, NULL, '1970-01-01T00:00:00.000Z', NULL)`).run();
  } finally {
    for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
  }
}

/** Test-only reset for immutable per-call step-up and guest-attempt records. */
export async function clearOwnerCallStepUpDataForTest(): Promise<void> {
  await applyVoiceOwnerDeliveryMigration();
  const tables = [
    "guest_grant_notices", "owner_call_step_up_rejection_deliveries",
    "owner_call_step_up_disabled_rejections",
    "owner_call_step_up_repeat_checks", "owner_call_step_up_rejections",
    "owner_call_step_up_successes", "owner_call_step_up_reprompts",
    "owner_call_step_up_attempts", "owner_call_step_up_windows",
    "owner_call_step_up_bindings", "guest_call_pin_attempts",
  ] as const;
  const guards = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN (${tables.map(() => "?").join(", ")})`,
  ).bind(...tables).all<{ name: string; sql: string }>();
  for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${guard.name}`).run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS call_session_authorities_delete_forbidden").run();
  try {
    await env.DB.prepare("DELETE FROM call_session_authorities").run();
    for (const table of tables) await env.DB.prepare(`DELETE FROM ${table}`).run();
    await env.DB.prepare("DELETE FROM owner_call_step_up_alerts").run();
  } finally {
    for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
    await env.DB.prepare(`CREATE TRIGGER call_session_authorities_delete_forbidden
      BEFORE DELETE ON call_session_authorities
      BEGIN SELECT RAISE(ABORT, 'call_session_authority_delete_forbidden'); END`).run();
  }
}

/** Test-only reset for append-only owner-passphrase history. */
export async function clearOwnerPassphraseDataForTest(): Promise<void> {
  await applyOwnerPassphraseMigration();
  const deleteGuards = [
    "owner_passphrase_heads_delete_forbidden",
    "owner_passphrase_disable_commits_delete_forbidden",
    "owner_passphrase_rotation_commits_delete_forbidden",
    "owner_passphrase_verifiers_delete_forbidden",
  ] as const;
  const installed = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'
     AND name IN (${deleteGuards.map(() => "?").join(", ")})`,
  ).bind(...deleteGuards).all<{ name: string; sql: string }>();
  for (const name of deleteGuards) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  try {
    await env.DB.prepare("DELETE FROM owner_passphrase_heads").run();
    await env.DB.prepare("DELETE FROM owner_passphrase_disable_commits").run();
    await env.DB.prepare("DELETE FROM owner_passphrase_rotation_commits").run();
    await env.DB.prepare("DELETE FROM owner_passphrase_verifiers").run();
  } finally {
    for (const guard of installed.results) await env.DB.prepare(guard.sql).run();
  }
}

const MEMORY_PROJECTION_DELETE_GUARDS = Object.freeze([
  "memory_fact_projection_abandoned_no_delete",
  "memory_fact_projection_commits_immutable_delete",
  "memory_fact_projection_heads_delete_guard",
  "memory_fact_projection_versions_delete_guard",
]);

/** Test-only reset that restores exactly the production guards present before cleanup. */
export async function clearMemoryProjectionDataForTest(): Promise<void> {
  const result = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_schema
     WHERE type = 'trigger' AND name IN (${MEMORY_PROJECTION_DELETE_GUARDS.map(() => "?").join(", ")})`,
  ).bind(...MEMORY_PROJECTION_DELETE_GUARDS).all<{ name: string; sql: string }>();
  const guards = result.results.filter((row) => typeof row.sql === "string");
  for (const name of MEMORY_PROJECTION_DELETE_GUARDS) {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  }
  try {
    await env.DB.prepare("DELETE FROM memory_fact_projection_abandoned").run();
    await env.DB.prepare("DELETE FROM memory_fact_projection_commits").run();
    await env.DB.prepare("DELETE FROM memory_fact_projection_heads").run();
    await env.DB.prepare("DELETE FROM memory_fact_projection_versions").run();
  } finally {
    for (const guard of guards) await env.DB.prepare(guard.sql).run();
  }
}

/** Test-only reset that restores the production delete guard immediately after clearing isolated D1 state. */
export async function clearOutboundCallAttemptsForTest(): Promise<void> {
  await clearCallSessionsForTest();
  await env.DB.prepare("DROP TRIGGER IF EXISTS outbound_call_attempts_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM outbound_call_attempts").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER outbound_call_attempts_reject_delete
      BEFORE DELETE ON outbound_call_attempts
      BEGIN
        SELECT RAISE(ABORT, 'outbound_attempt_delete_forbidden');
      END`).run();
  }
}

/** Test-only reset for immutable session tombstones. */
export async function clearCallSessionsForTest(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS call_session_authorities_delete_forbidden").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS call_sessions_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM call_session_authorities").run();
    await env.DB.prepare("DELETE FROM call_sessions").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER call_sessions_reject_delete
      BEFORE DELETE ON call_sessions
      BEGIN
        SELECT RAISE(ABORT, 'call_session_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER call_session_authorities_delete_forbidden
      BEFORE DELETE ON call_session_authorities
      BEGIN
        SELECT RAISE(ABORT, 'call_session_authority_delete_forbidden');
      END`).run();
  }
}

/** Test-only reset for append-only owner, grant, event, and call-authority state. */
export async function clearVoiceAccessDataForTest(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS call_session_authorities_delete_forbidden").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS voice_access_grant_events_delete_forbidden").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS voice_access_grants_delete_forbidden").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS voice_owner_identity_delete_forbidden").run();
  try {
    await env.DB.prepare("DELETE FROM call_session_authorities").run();
    await env.DB.prepare("DELETE FROM voice_access_grant_events").run();
    await env.DB.prepare("DELETE FROM voice_access_grants").run();
    await env.DB.prepare("DELETE FROM voice_owner_identity").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER call_session_authorities_delete_forbidden
      BEFORE DELETE ON call_session_authorities
      BEGIN
        SELECT RAISE(ABORT, 'call_session_authority_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER voice_access_grant_events_delete_forbidden
      BEFORE DELETE ON voice_access_grant_events
      BEGIN
        SELECT RAISE(ABORT, 'voice_access_grant_event_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER voice_access_grants_delete_forbidden
      BEFORE DELETE ON voice_access_grants
      BEGIN
        SELECT RAISE(ABORT, 'voice_access_grant_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER voice_owner_identity_delete_forbidden
      BEFORE DELETE ON voice_owner_identity
      BEGIN
        SELECT RAISE(ABORT, 'voice_owner_identity_delete_forbidden');
      END`).run();
  }
}

/** Test-only reset for append-only transient authentication reservations. */
export async function clearAuthenticationAttemptReservationsForTest(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS authentication_attempt_reservations_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM authentication_attempt_reservations").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER authentication_attempt_reservations_reject_delete
      BEFORE DELETE ON authentication_attempt_reservations
      BEGIN
        SELECT RAISE(ABORT, 'authentication_reservation_delete_forbidden');
      END`).run();
  }
}

/** Test-only reset for immutable conversation turn and delivery replay authority. */
export async function clearConversationDataForTest(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS conversation_deliveries_reject_delete").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS conversation_turns_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM conversation_deliveries").run();
    await env.DB.prepare("DELETE FROM conversation_turns").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER conversation_turns_reject_delete
      BEFORE DELETE ON conversation_turns
      BEGIN
        SELECT RAISE(ABORT, 'conversation_turn_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER conversation_deliveries_reject_delete
      BEFORE DELETE ON conversation_deliveries
      BEGIN
        SELECT RAISE(ABORT, 'conversation_delivery_delete_forbidden');
      END`).run();
  }
}
