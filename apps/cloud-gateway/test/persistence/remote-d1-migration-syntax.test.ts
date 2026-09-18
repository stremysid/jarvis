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

describe("remote D1 migration trigger syntax", () => {
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
