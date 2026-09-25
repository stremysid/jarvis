import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { readonly eager: true; readonly import: "default"; readonly query: "?raw" },
    ): Record<string, string>;
  }
}

const migrationModules = import.meta.glob(
  "../../src/persistence/migrations/*.sql",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const remoteD1Migrations = Object.entries(migrationModules).map(([path, sql]) => {
  const name = path.split("/").at(-1);
  if (name === undefined) throw new Error(`migration name missing: ${path}`);
  const sequence = Number.parseInt(name.slice(0, 4), 10);
  return { name, sequence, sql };
}).sort((left, right) => left.sequence - right.sequence);

const VOICE_OWNER_DELIVERY_TRIGGERS = Object.freeze([
  "owner_call_step_up_disabled_rejections_insert_guard",
  "owner_call_step_up_disabled_rejections_terminalize",
  "owner_call_step_up_disabled_rejections_immutable",
  "owner_call_step_up_disabled_rejections_delete_forbidden",
  "owner_call_step_up_rejection_deliveries_insert_guard",
  "owner_call_step_up_rejection_deliveries_immutable",
  "owner_call_step_up_rejection_deliveries_delete_forbidden",
  "guest_grant_notices_insert_guard",
  "guest_grant_notices_transition_guard",
  "guest_grant_notices_delete_forbidden",
]);

const MEMORY_DISTILLATION_TRIGGERS = Object.freeze([
  "archive_segment_events_no_update",
  "memory_distillation_event_receipts_insert_guard",
  "memory_distillation_event_receipts_immutable_update",
  "memory_distillation_event_receipts_delete_forbidden",
  "memory_distillation_item_receipts_insert_guard",
  "memory_distillation_item_receipts_immutable_update",
  "memory_distillation_item_receipts_delete_forbidden",
  "memory_distillation_runs_reconcile_guard",
  "memory_distillation_cursor_insert_guard",
  "memory_distillation_cursor_update_guard",
]);

const GUEST_GRANT_NOTICE_DRAIN_TRIGGERS = Object.freeze([
  "guest_grant_notice_drain_state_insert_guard",
  "guest_grant_notice_drain_state_transition_guard",
  "guest_grant_notice_drain_state_delete_forbidden",
]);

const STUDY_COACH_WEAK_SPOT_TRIGGERS = Object.freeze([
  "school_assignment_observations_scale_update_guard",
  "school_assignment_observation_revisions_scale_insert_guard",
  "school_study_check_in_claims_insert_guard",
  "school_study_check_in_claims_update_guard",
  "school_study_check_in_claims_delete_guard",
  "school_study_signal_controls_insert_guard",
  "school_study_signal_controls_update_guard",
  "school_study_signal_controls_delete_guard",
]);

const GUIDED_ASSIGNMENT_TRIGGERS = [
  ["guided_assignment_answers_insert_conflict", `BEFORE INSERT ON guided_assignment_answers
    WHEN EXISTS (
      SELECT 1 FROM guided_assignment_answers
      WHERE principal_id = NEW.principal_id AND assignment_id = NEW.assignment_id
        AND (answer_id = NEW.answer_id OR turn_id = NEW.turn_id)
    )
    BEGIN SELECT RAISE(ABORT, 'guided_assignment_answer_conflict'); END;`],
  ["guided_assignment_answers_reject_update", `BEFORE UPDATE ON guided_assignment_answers
    BEGIN SELECT RAISE(ABORT, 'guided_assignment_answer_update_forbidden'); END;`],
  ["guided_assignment_answers_reject_delete", `BEFORE DELETE ON guided_assignment_answers
    BEGIN SELECT RAISE(ABORT, 'guided_assignment_answer_delete_forbidden'); END;`],
] as const;

const OWNER_CHANNEL_PARITY_TRIGGERS = Object.freeze([
  "school_course_cards_require_owner_turn_insert",
  "school_course_cards_require_owner_turn_update",
  "school_course_facts_require_owner_turn",
  "school_catchup_actions_require_plan_turn",
  "school_catchup_turn_receipts_require_turn",
  "university_programs_require_owner_turn_insert",
  "university_programs_require_owner_turn_update",
  "university_program_items_require_owner_turn",
  "university_tracker_turn_receipts_require_turn",
  "school_study_preferences_require_owner_turn_insert",
  "school_study_preferences_require_owner_turn_update",
  "school_practice_items_source_guard",
  "school_practice_items_status_transition",
  "school_study_evidence_source_guard",
  "school_study_evidence_status_transition",
  "university_application_items_require_owner_turn_insert",
  "university_application_items_require_owner_turn_update",
  "university_workflow_revisions_require_owner_turn",
  "school_study_signal_controls_insert_guard",
]);

function triggerDefinition(sql: string, name: string): string | undefined {
  return new RegExp(`\\bCREATE\\s+TRIGGER\\s+${name}\\b[\\s\\S]*?\\bEND;`, "iu").exec(sql)?.[0];
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

describe("remote D1 migration trigger syntax", () => {
  it("pins all three guided assignment trigger names in migration 0043", () => {
    const migration = remoteD1Migrations.find(({ name }) => name === "0043_guided_assignment.sql");
    expect([...(migration?.sql ?? "").matchAll(/\bCREATE\s+TRIGGER\s+([a-z0-9_]+)/giu)].map((match) => match[1]))
      .toEqual(GUIDED_ASSIGNMENT_TRIGGERS.map(([name]) => name));
  });

  it.each(GUIDED_ASSIGNMENT_TRIGGERS)("keeps %s in its complete remote D1 trigger form", (name, body) => {
    const sql = remoteD1Migrations.find(({ name }) => name === "0043_guided_assignment.sql")?.sql ?? "";
    const definition = new RegExp(`\\bCREATE\\s+TRIGGER\\s+${name}\\b[\\s\\S]*?\\bEND;`, "iu").exec(sql)?.[0];
    expect(definition?.replace(/\s+/gu, " ").trim()).toBe(`CREATE TRIGGER ${name} ${body.replace(/\s+/gu, " ").trim()}`);
  });

  it("pins all nineteen widened trigger and drop names in migration 0044", () => {
    const migration = remoteD1Migrations.find(({ name }) => name === "0044_owner_channel_parity.sql");
    const sql = migration?.sql ?? "";
    expect([...sql.matchAll(/\bCREATE\s+TRIGGER\s+([a-z0-9_]+)/giu)].map((match) => match[1]))
      .toEqual(OWNER_CHANNEL_PARITY_TRIGGERS);
    expect([...sql.matchAll(/\bDROP\s+TRIGGER\s+([a-z0-9_]+)/giu)].map((match) => match[1]))
      .toEqual(OWNER_CHANNEL_PARITY_TRIGGERS);
  });

  it.each(OWNER_CHANNEL_PARITY_TRIGGERS)(
    "keeps %s in its complete prior form with only the owner channel widened",
    (name) => {
      const current = remoteD1Migrations.find(
        ({ name: migrationName }) => migrationName === "0044_owner_channel_parity.sql",
      )?.sql ?? "";
      const previous = [...remoteD1Migrations]
        .reverse()
        .find(({ sequence, sql }) => sequence < 44 && triggerDefinition(sql, name) !== undefined)?.sql ?? "";
      const previousDefinition = triggerDefinition(previous, name);
      const expected = previousDefinition?.replace(
        /channel\s*=\s*'telegram'/gu,
        "channel IN ('telegram', 'voice')",
      );
      expect(expected).not.toBe(previousDefinition);
      expect(normalizedSql(triggerDefinition(current, name) ?? "")).toBe(normalizedSql(expected ?? ""));
    },
  );

  it("discovers every migration", () => {
    expect(remoteD1Migrations.map(({ name }) => name)).toEqual([
      "0001_foundation.sql",
      "0002_foundation_hardening.sql",
      "0003_calling.sql",
      "0004_call_sessions.sql",
      "0005_conversation.sql",
      "0006_voice_access.sql",
      "0007_voice_access_boundaries.sql",
      "0008_autonomy.sql",
      "0009_decisions.sql",
      "0010_projects.sql",
      "0011_deadlines.sql",
      "0012_liveness.sql",
      "0013_scheduled_runs.sql",
      "0014_memory_projection.sql",
      "0015_voice_runtime.sql",
      "0016_cloud_memory.sql",
      "0017_owner_passphrase.sql",
      "0018_owner_call_step_up.sql",
      "0019_memory_ingress.sql",
      "0020_school_catchup.sql",
      "0021_voice_owner_delivery.sql",
      "0022_university_tracker.sql",
      "0023_study_coach.sql",
      "0024_university_application_workflow.sql",
      "0025_archive_literal_history.sql",
      "0026_memory_distillation.sql",
      "0027_school_observations.sql",
      "0028_guest_grant_notice_drain.sql",
      "0029_university_application_details.sql",
      "0030_study_coach_weak_spots.sql",
      "0031_memory_backup.sql",
      "0032_memory_living_notes.sql",
      "0033_d2l_notification_email.sql",
      "0034_scheduled_run_detail.sql",
      "0035_autonomy_tool_capabilities.sql",
      "0038_memory_lifetime_and_pins.sql",
      "0039_tool_confirmation_consumptions.sql",
      "0040_school_collector_keys.sql",
      "0043_guided_assignment.sql",
      "0044_owner_channel_parity.sql",
      "0045_school_collector_hosts.sql",
      "0047_call_pin_and_owner_authority.sql",
      "0048_note_sources_without_markdown_citation.sql",
      "0049_web_tools.sql",
      "0050_owner_reminders.sql",
      "0051_confirm_only_five_actions.sql",
      "0052_email_inbox.sql",
      "0053_deadline_effort_judgment.sql",
    ]);
  });

  it.each(remoteD1Migrations)("rejects CASE-wrapped RAISE statements in $name", ({ sql }) => {
    // Remote D1 accepts plain CASE ... END value expressions inside triggers.
    // Only the statement form SELECT CASE ... RAISE( is rejected.
    expect(sql).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
  });

  it("pins every 0021 trigger as one complete named definition", () => {
    const migration = remoteD1Migrations.find(({ name }) => name === "0021_voice_owner_delivery.sql");
    expect(migration).toBeDefined();
    const names = [...(migration?.sql ?? "").matchAll(/\bCREATE\s+TRIGGER\s+([a-z0-9_]+)/giu)]
      .map((match) => match[1]);
    expect(names).toEqual(VOICE_OWNER_DELIVERY_TRIGGERS);
  });

  it("pins every 0026 trigger as one complete remote-D1 definition", () => {
    const migration = remoteD1Migrations.find(({ name }) => name === "0026_memory_distillation.sql");
    expect(migration).toBeDefined();
    const sql = migration?.sql ?? "";
    const names = [...sql.matchAll(/\bCREATE\s+TRIGGER\s+([a-z0-9_]+)/giu)]
      .map((match) => match[1]);
    expect(names).toEqual(MEMORY_DISTILLATION_TRIGGERS);
    expect(sql.match(/\bCREATE\s+TRIGGER\b/giu)).toHaveLength(MEMORY_DISTILLATION_TRIGGERS.length);
    expect(sql.match(/\bWHEN\b[\s\S]*?\bBEGIN\s+SELECT\s+RAISE\s*\(ABORT,/giu))
      .toHaveLength(MEMORY_DISTILLATION_TRIGGERS.length);
  });

  it("marks the live archive table alteration for complete scratch rehearsal", () => {
    const migration = remoteD1Migrations.find(({ name }) => name === "0026_memory_distillation.sql");
    expect(migration?.sql).toMatch(
      /^-- This candidate alters archive_segment_events, a live table created in 0001\.\r?\n-- Scratch rehearsal must cover the column add, subject backfill, and trigger replacement against that prior schema\./u,
    );
  });

  it.each(MEMORY_DISTILLATION_TRIGGERS)(
    "keeps %s in WHEN BEGIN SELECT RAISE remote-D1 form",
    (trigger) => {
      const migration = remoteD1Migrations.find(({ name }) => name === "0026_memory_distillation.sql");
      const sql = migration?.sql ?? "";
      const definition = new RegExp(
        `\\bCREATE\\s+TRIGGER\\s+${trigger}\\b[\\s\\S]*?\\bEND;`,
        "iu",
      ).exec(sql)?.[0];
      expect(definition).toBeDefined();
      expect(definition).toMatch(/\bWHEN\b[\s\S]*?\bBEGIN\s+SELECT\s+RAISE\s*\(ABORT,[^;]+\);\s*END;$/iu);
      expect(definition).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
    },
  );

  it("pins every 0028 trigger as one complete named definition", () => {
    const migration = remoteD1Migrations.find(({ name }) => name === "0028_guest_grant_notice_drain.sql");
    expect(migration).toBeDefined();
    const names = [...(migration?.sql ?? "").matchAll(/\bCREATE\s+TRIGGER\s+([a-z0-9_]+)/giu)]
      .map((match) => match[1]);
    expect(names).toEqual(GUEST_GRANT_NOTICE_DRAIN_TRIGGERS);
  });

  it("pins every 0030 trigger in complete SELECT RAISE WHERE form", () => {
    const migration = remoteD1Migrations.find(({ name }) => name === "0030_study_coach_weak_spots.sql");
    expect(migration).toBeDefined();
    const sql = migration?.sql ?? "";
    const names = [...sql.matchAll(/\bCREATE\s+TRIGGER\s+([a-z0-9_]+)/giu)]
      .map((match) => match[1]);
    expect(names).toEqual(STUDY_COACH_WEAK_SPOT_TRIGGERS);
    for (const trigger of STUDY_COACH_WEAK_SPOT_TRIGGERS) {
      const definition = new RegExp(
        `\\bCREATE\\s+TRIGGER\\s+${trigger}\\b[\\s\\S]*?\\bEND;`,
        "iu",
      ).exec(sql)?.[0];
      expect(definition).toBeDefined();
      expect(definition).toMatch(/\bBEGIN\s+SELECT\s+RAISE\s*\(ABORT,[^;]+\)\s+WHERE\b[\s\S]*;\s*END;$/iu);
      expect(definition).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
    }
  });
});

