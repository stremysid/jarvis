import migration0001 from "../persistence/migrations/0001_foundation.sql";
import migration0002 from "../persistence/migrations/0002_foundation_hardening.sql";
import migration0003 from "../persistence/migrations/0003_calling.sql";
import migration0004 from "../persistence/migrations/0004_call_sessions.sql";
import migration0005 from "../persistence/migrations/0005_conversation.sql";
import migration0006 from "../persistence/migrations/0006_voice_access.sql";
import migration0007 from "../persistence/migrations/0007_voice_access_boundaries.sql";
import migration0008 from "../persistence/migrations/0008_autonomy.sql";
import migration0009 from "../persistence/migrations/0009_decisions.sql";
import migration0010 from "../persistence/migrations/0010_projects.sql";
import migration0011 from "../persistence/migrations/0011_deadlines.sql";
import migration0012 from "../persistence/migrations/0012_liveness.sql";
import migration0013 from "../persistence/migrations/0013_scheduled_runs.sql";
import migration0014 from "../persistence/migrations/0014_memory_projection.sql";
import migration0015 from "../persistence/migrations/0015_voice_runtime.sql";
import migration0016 from "../persistence/migrations/0016_cloud_memory.sql";
import migration0017 from "../persistence/migrations/0017_owner_passphrase.sql";
import migration0018 from "../persistence/migrations/0018_owner_call_step_up.sql";
import migration0019 from "../persistence/migrations/0019_memory_ingress.sql";
import migration0020 from "../persistence/migrations/0020_school_catchup.sql";
import migration0021 from "../persistence/migrations/0021_voice_owner_delivery.sql";
import migration0022 from "../persistence/migrations/0022_university_tracker.sql";
import migration0023 from "../persistence/migrations/0023_study_coach.sql";
import migration0024 from "../persistence/migrations/0024_university_application_workflow.sql";
import migration0025 from "../persistence/migrations/0025_archive_literal_history.sql";
import migration0026 from "../persistence/migrations/0026_memory_distillation.sql";
import migration0027 from "../persistence/migrations/0027_school_observations.sql";
import migration0028 from "../persistence/migrations/0028_guest_grant_notice_drain.sql";
import migration0029 from "../persistence/migrations/0029_university_application_details.sql";
import migration0030 from "../persistence/migrations/0030_study_coach_weak_spots.sql";
import migration0031 from "../persistence/migrations/0031_memory_backup.sql";
import migration0032 from "../persistence/migrations/0032_memory_living_notes.sql";
import migration0033 from "../persistence/migrations/0033_d2l_notification_email.sql";
import migration0034 from "../persistence/migrations/0034_scheduled_run_detail.sql";
import migration0035 from "../persistence/migrations/0035_autonomy_tool_capabilities.sql";
import migration0038 from "../persistence/migrations/0038_memory_lifetime_and_pins.sql";
import migration0039 from "../persistence/migrations/0039_tool_confirmation_consumptions.sql";
import migration0040 from "../persistence/migrations/0040_school_collector_keys.sql";
import migration0043 from "../persistence/migrations/0043_guided_assignment.sql";
import migration0044 from "../persistence/migrations/0044_owner_channel_parity.sql";
import migration0045 from "../persistence/migrations/0045_school_collector_hosts.sql";
import migration0047 from "../persistence/migrations/0047_call_pin_and_owner_authority.sql";
import migration0048 from "../persistence/migrations/0048_note_sources_without_markdown_citation.sql";
import migration0049 from "../persistence/migrations/0049_web_tools.sql";
import migration0050 from "../persistence/migrations/0050_owner_reminders.sql";
import migration0051 from "../persistence/migrations/0051_confirm_only_five_actions.sql";
import migration0052 from "../persistence/migrations/0052_email_inbox.sql";
import migration0053 from "../persistence/migrations/0053_deadlines_store_facts.sql";
import migration0054 from "../persistence/migrations/0054_owner_reminders_scheduled.sql";
import migration0055 from "../persistence/migrations/0055_school_catchup_planned_cap.sql";

/** Ordered text modules; the API selects only the target's applied receipt prefix. */
export const MEMORY_BACKUP_RESTORE_MIGRATIONS = Object.freeze([
  Object.freeze({ name: "0001_foundation.sql", sql: migration0001 }),
  Object.freeze({ name: "0002_foundation_hardening.sql", sql: migration0002 }),
  Object.freeze({ name: "0003_calling.sql", sql: migration0003 }),
  Object.freeze({ name: "0004_call_sessions.sql", sql: migration0004 }),
  Object.freeze({ name: "0005_conversation.sql", sql: migration0005 }),
  Object.freeze({ name: "0006_voice_access.sql", sql: migration0006 }),
  Object.freeze({ name: "0007_voice_access_boundaries.sql", sql: migration0007 }),
  Object.freeze({ name: "0008_autonomy.sql", sql: migration0008 }),
  Object.freeze({ name: "0009_decisions.sql", sql: migration0009 }),
  Object.freeze({ name: "0010_projects.sql", sql: migration0010 }),
  Object.freeze({ name: "0011_deadlines.sql", sql: migration0011 }),
  Object.freeze({ name: "0012_liveness.sql", sql: migration0012 }),
  Object.freeze({ name: "0013_scheduled_runs.sql", sql: migration0013 }),
  Object.freeze({ name: "0014_memory_projection.sql", sql: migration0014 }),
  Object.freeze({ name: "0015_voice_runtime.sql", sql: migration0015 }),
  Object.freeze({ name: "0016_cloud_memory.sql", sql: migration0016 }),
  Object.freeze({ name: "0017_owner_passphrase.sql", sql: migration0017 }),
  Object.freeze({ name: "0018_owner_call_step_up.sql", sql: migration0018 }),
  Object.freeze({ name: "0019_memory_ingress.sql", sql: migration0019 }),
  Object.freeze({ name: "0020_school_catchup.sql", sql: migration0020 }),
  Object.freeze({ name: "0021_voice_owner_delivery.sql", sql: migration0021 }),
  Object.freeze({ name: "0022_university_tracker.sql", sql: migration0022 }),
  Object.freeze({ name: "0023_study_coach.sql", sql: migration0023 }),
  Object.freeze({ name: "0024_university_application_workflow.sql", sql: migration0024 }),
  Object.freeze({ name: "0025_archive_literal_history.sql", sql: migration0025 }),
  Object.freeze({ name: "0026_memory_distillation.sql", sql: migration0026 }),
  Object.freeze({ name: "0027_school_observations.sql", sql: migration0027 }),
  Object.freeze({ name: "0028_guest_grant_notice_drain.sql", sql: migration0028 }),
  Object.freeze({ name: "0029_university_application_details.sql", sql: migration0029 }),
  Object.freeze({ name: "0030_study_coach_weak_spots.sql", sql: migration0030 }),
  Object.freeze({ name: "0031_memory_backup.sql", sql: migration0031 }),
  Object.freeze({ name: "0032_memory_living_notes.sql", sql: migration0032 }),
  Object.freeze({ name: "0033_d2l_notification_email.sql", sql: migration0033 }),
  Object.freeze({ name: "0034_scheduled_run_detail.sql", sql: migration0034 }),
  Object.freeze({ name: "0035_autonomy_tool_capabilities.sql", sql: migration0035 }),
  Object.freeze({ name: "0038_memory_lifetime_and_pins.sql", sql: migration0038 }),
  Object.freeze({ name: "0039_tool_confirmation_consumptions.sql", sql: migration0039 }),
  Object.freeze({ name: "0040_school_collector_keys.sql", sql: migration0040 }),
  Object.freeze({ name: "0043_guided_assignment.sql", sql: migration0043 }),
  Object.freeze({ name: "0044_owner_channel_parity.sql", sql: migration0044 }),
  Object.freeze({ name: "0045_school_collector_hosts.sql", sql: migration0045 }),
  Object.freeze({ name: "0047_call_pin_and_owner_authority.sql", sql: migration0047 }),
  Object.freeze({ name: "0048_note_sources_without_markdown_citation.sql", sql: migration0048 }),
  Object.freeze({ name: "0049_web_tools.sql", sql: migration0049 }),
  Object.freeze({ name: "0050_owner_reminders.sql", sql: migration0050 }),
  Object.freeze({ name: "0051_confirm_only_five_actions.sql", sql: migration0051 }),
  Object.freeze({ name: "0052_email_inbox.sql", sql: migration0052 }),
  Object.freeze({ name: "0053_deadlines_store_facts.sql", sql: migration0053 }),
  Object.freeze({ name: "0054_owner_reminders_scheduled.sql", sql: migration0054 }),
  Object.freeze({ name: "0055_school_catchup_planned_cap.sql", sql: migration0055 }),
]);

