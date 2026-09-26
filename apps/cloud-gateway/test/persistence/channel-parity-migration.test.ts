import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import school from "../../src/persistence/migrations/0020_school_catchup.sql?raw";
import university from "../../src/persistence/migrations/0022_university_tracker.sql?raw";
import study from "../../src/persistence/migrations/0023_study_coach.sql?raw";
import applications from "../../src/persistence/migrations/0024_university_application_workflow.sql?raw";
import workflow from "../../src/persistence/migrations/0029_university_application_details.sql?raw";
import weakSpots from "../../src/persistence/migrations/0030_study_coach_weak_spots.sql?raw";
import { applyMemoryLivingNotesMigration, applyNewestRuntimeMigration } from "./migration.js";

// Derive the population from the old schema, so omitting a replacement does not
// silently omit its test as well. Compare SQLite's installed triggers, not source text.
const names = [school, university, study, applications, workflow, weakSpots].flatMap(sql =>
  [...sql.matchAll(/CREATE TRIGGER ([a-z_]+)\b[\s\S]*?\nEND;/g)]
    .filter(match => match[0].includes("channel = 'telegram'"))
    .map(match => match[1]!));
const original = new Map<string, string>();
const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();

beforeAll(async () => {
  await applyMemoryLivingNotesMigration();
  const rows = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all<{ name: string; sql: string }>();
  for (const row of rows.results) original.set(row.name, row.sql);
  await applyNewestRuntimeMigration();
}, 120_000);

it.each(names)("preserves every source and owner check while admitting voice in %s", async name => {
  const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .bind(name).first<{ sql: string }>();
  expect(original.has(name)).toBe(true);
  expect(row).not.toBeNull();
  expect(normalized(row!.sql)).toBe(normalized(original.get(name)!
    .replaceAll("channel = 'telegram'", "channel IN ('telegram', 'voice')")));
});

it.each(["telegram", "voice"] as const)("keeps source-turn ownership enforced for inserts and updates on %s", async channel => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const principalId = `principal:parity:${channel}`;
  const other = `${principalId}:other`;
  const repository = new ConversationRepository(env.DB, new EventRepository(env.DB));
  const turns = [];
  for (const principal of [principalId, other]) {
    await env.DB.prepare(`INSERT INTO principals
      (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'Parity fixture', ?, ?)`)
      .bind(principal, now.toISOString(), now.toISOString()).run();
    const turnId = newUlid();
    const userText = new Redactor().redactText("Save this school plan.");
    if (!userText.ok) throw new Error("fixture_redaction_failed");
    await repository.getOrCreateTurn({ turnId, principalId: principal, sessionId: principal, channel, userText, now });
    turns.push(turnId);
  }
  const entries = [
    { table: "school_course_cards", field: "owner_source_turn_id", error: "school_course_card_owner_turn_invalid",
      sql: `INSERT INTO school_course_cards (principal_id, owner_source_turn_id, created_at, updated_at,
        course_id, course_key, course_name, course_name_source) VALUES (?1, ?2, ?3, ?3, ?4, 'parity', 'Chemistry', 'owner_reported')` },
    { table: "university_programs", field: "owner_source_turn_id", error: "university_program_owner_turn_invalid",
      sql: `INSERT INTO university_programs (principal_id, owner_source_turn_id, created_at, updated_at,
        program_id, program_key, university_name, program_name, verification_state)
        VALUES (?1, ?2, ?3, ?3, ?4, 'parity', 'Example University', 'Chemistry', 'unverified')` },
    { table: "school_study_preferences", field: "source_turn_id", error: "school_study_preference_owner_turn_invalid",
      sql: `INSERT INTO school_study_preferences (principal_id, source_turn_id, created_at, updated_at,
        enabled, allowed_days_mask, quiet_start_minute, quiet_end_minute)
        VALUES (?1, ?2, ?3, ?3, 1, 127, 1200, 480)` },
  ];
  for (const entry of entries) {
    const make = (source: string) => env.DB.prepare(entry.sql)
      .bind(principalId, source, now.toISOString(), ...(entry.table === "school_study_preferences" ? [] : [newUlid()]));
    await expect(make(turns[1]!).run()).rejects.toThrow(entry.error);
    await expect(make(turns[0]!).run()).resolves.toMatchObject({ success: true });
    await expect(env.DB.prepare(`UPDATE ${entry.table} SET ${entry.field} = ? WHERE principal_id = ?`)
      .bind(turns[1]!, principalId).run()).rejects.toThrow(entry.error);
  }
});
