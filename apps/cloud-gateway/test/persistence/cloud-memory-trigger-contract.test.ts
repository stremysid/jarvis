import { describe, expect, it } from "vitest";
import cloudMemorySql from "../../src/persistence/migrations/0016_cloud_memory.sql?raw";

const EXPECTED_TRIGGERS = [
  "memory_items_immutable_update",
  "memory_items_immutable_delete",
  "memory_item_versions_immutable_update",
  "memory_item_versions_immutable_delete",
  "memory_item_sources_immutable_update",
  "memory_item_sources_immutable_delete",
  "memory_item_transitions_immutable_update",
  "memory_item_transitions_immutable_delete",
  "memory_event_suppressions_immutable_update",
  "memory_event_suppressions_immutable_delete",
  "memory_event_suppression_lifts_immutable_update",
  "memory_event_suppression_lifts_immutable_delete",
  "memory_item_links_immutable_update",
  "memory_item_links_immutable_delete",
  "memory_topic_events_immutable_update",
  "memory_topic_events_immutable_delete",
  "memory_topic_aliases_immutable_update",
  "memory_topic_aliases_immutable_delete",
  "memory_item_placement_events_immutable_update",
  "memory_item_placement_events_immutable_delete",
  "memory_episodes_immutable_update",
  "memory_episodes_immutable_delete",
  "memory_episode_sources_immutable_update",
  "memory_episode_sources_immutable_delete",
  "memory_history_coverage_immutable_update",
  "memory_history_coverage_immutable_delete",
  "memory_model_prices_immutable_update",
  "memory_model_prices_immutable_delete",
  "memory_cost_ledger_immutable_update",
  "memory_cost_ledger_immutable_delete",
  "memory_item_versions_insert_guard",
  "memory_item_sources_insert_guard",
  "memory_item_transitions_insert_guard",
  "memory_item_transitions_apply_state",
  "memory_item_state_insert_guard",
  "memory_item_state_update_guard",
  "memory_item_state_delete_guard",
  "memory_event_suppressions_insert_guard",
  "memory_event_suppression_lifts_insert_guard",
  "memory_item_links_insert_guard",
  "memory_topic_events_insert_guard",
  "memory_topic_events_apply",
  "memory_topics_insert_guard",
  "memory_topics_update_guard",
  "memory_topics_delete_guard",
  "memory_topic_aliases_insert_guard",
  "memory_item_placement_events_insert_guard",
  "memory_item_placement_events_apply_state",
  "memory_item_placement_state_insert_guard",
  "memory_item_placement_state_update_guard",
  "memory_item_placement_state_delete_guard",
  "memory_episode_sources_insert_guard",
  "memory_history_coverage_insert_guard",
  "memory_vectors_update_guard",
  "memory_vectors_delete_guard",
  "memory_runs_update_guard",
  "memory_runs_delete_guard",
  "memory_reprocess_jobs_insert_guard",
  "memory_reprocess_jobs_update_guard",
  "memory_reprocess_jobs_delete_guard",
  "memory_cost_ledger_insert_guard",
  "memory_cursors_monotonic_update",
  "memory_cursors_delete_guard",
  "memory_item_versions_fts_insert",
  "memory_episodes_fts_insert",
  "memory_history_chunks_fts_insert",
  "memory_history_chunks_fts_update",
  "memory_history_chunks_fts_delete",
] as const;

function triggerSql(sql: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return Array.from(sql.matchAll(
    new RegExp(`CREATE TRIGGER ${escaped}\\b[\\s\\S]*?\\nEND;`, "gu"),
  ), (match) => match[0]);
}

function assertTriggerContract(sql: string, name: string): void {
  const matches = triggerSql(sql, name);
  expect(matches, `${name} must exist exactly once`).toHaveLength(1);
  expect(matches[0]).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
}

describe("cloud memory trigger removal contracts", () => {
  const declared = Array.from(cloudMemorySql.matchAll(
    /^CREATE TRIGGER ([a-z0-9_]+)$/gmu,
  ), (match) => match[1]);

  it("has a dedicated removal contract for every 0016 trigger", () => {
    expect(declared).toEqual([...EXPECTED_TRIGGERS]);
  });

  for (const name of EXPECTED_TRIGGERS) {
    it(`rejects 0016 if ${name} is removed`, () => {
      assertTriggerContract(cloudMemorySql, name);
      const [definition] = triggerSql(cloudMemorySql, name);
      expect(definition).toBeDefined();
      const mutatedSql = cloudMemorySql.replace(definition ?? "", "");
      expect(() => assertTriggerContract(mutatedSql, name))
        .toThrowError(`${name} must exist exactly once`);
    });
  }
});
