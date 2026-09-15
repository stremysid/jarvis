// PR #39 round-6 clause-mutation runner (verifier-side). One vitest process at a time.
// usage: node pr39-reverify5-mutate.mjs <outDir> [mutationName ...]   (BASE = unmutated)
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = "C:/Users/Sid/jarvis-pr39-verify6";
const sqlPath = `${root}/apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql`;
const testFile = "apps/cloud-gateway/test/persistence/cloud-memory-migration.test.ts";
const outDir = process.argv[2];
const selected = process.argv.slice(3);
const original = readFileSync(sqlPath, "utf8");
const lf = original.replaceAll("\r\n", "\n");

const rep = (block, from, to) => {
  if (block.split(from).length !== 2) throw new Error(`anchor not unique: ${JSON.stringify(from.slice(0, 60))}`);
  return block.replace(from, to);
};
const rm = (block, from) => rep(block, from, "");
const trig = (name) => [`CREATE TRIGGER ${name}\n`, "\nEND;"];
const table = (name) => [`CREATE TABLE ${name} (\n`, "\n) STRICT"];
const lower = "  OR NEW.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')\n";
const lowerFor = (cond) => `  OR (${cond}\n    AND NEW.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'))\n`;

const mutations = {
  BASE: [null, null, null],
  // round-5 six (adapted to head)
  A1_cursor_name_pin: [...trig("memory_cursors_monotonic_update"), (b) => rm(b, "  OR NEW.cursor_name <> OLD.cursor_name\n")],
  A2_vector_item_id_pin: [...trig("memory_vectors_update_guard"), (b) => rm(b, "  OR NEW.item_id <> OLD.item_id\n")],
  A3_run_key_pin: [...trig("memory_runs_update_guard"), (b) => rm(b, "  OR NEW.run_key <> OLD.run_key\n")],
  A4_alias_id_duplicate_clause: [...trig("memory_topic_aliases_insert_guard"), (b) => rep(b, "WHEN EXISTS (\n    SELECT 1 FROM memory_topic_aliases alias\n    WHERE alias.alias_id = NEW.alias_id\n  )\n  OR NOT EXISTS (", "WHEN NOT EXISTS (")],
  A4b_restore_alias_tuple_unique: [...table("memory_topic_aliases"), (b) => rep(b, "  UNIQUE (principal_id, alias_id),\n", "  UNIQUE (principal_id, alias_id),\n  UNIQUE (principal_id, normalized_alias, path_alias),\n")],
  A4c_restore_alias_guard_tuple_clause: [...trig("memory_topic_aliases_insert_guard"), (b) => rep(b, "    WHERE alias.alias_id = NEW.alias_id\n", "    WHERE alias.alias_id = NEW.alias_id\n      OR (alias.principal_id = NEW.principal_id\n        AND alias.normalized_alias = NEW.normalized_alias\n        AND alias.path_alias = NEW.path_alias)\n")],
  A5_topic_create_sibling: [...trig("memory_topics_insert_guard"), (b) => rm(b, "\n      OR (topic.principal_id = NEW.principal_id\n        AND topic.parent_topic_id IS NEW.parent_topic_id\n        AND topic.normalized_name = NEW.normalized_name\n        AND topic.status = 'active')")],
  A6_placement_one_primary: [...trig("memory_item_placement_state_insert_guard"), (b) => rep(b, "\n      AND (state.placement_id = NEW.placement_id\n        OR (state.item_id = NEW.item_id AND state.relation = 'primary'\n          AND state.status = 'active' AND NEW.relation = 'primary' AND NEW.status = 'active'))", "\n      AND state.placement_id = NEW.placement_id")],
  B1_topic_create_one_root: [...trig("memory_topics_insert_guard"), (b) => rm(b, "\n      OR (NEW.parent_topic_id IS NULL\n        AND topic.principal_id = NEW.principal_id\n        AND topic.parent_topic_id IS NULL)")],
  // S2
  C1_ledger_lower_bound_removed: [...trig("memory_cost_ledger_insert_guard"), (b) => rm(b, lower)],
  C2_ledger_lower_bound_reservation_only: [...trig("memory_cost_ledger_insert_guard"), (b) => rep(b, lower, lowerFor("NEW.entry_type = 'reservation'"))],
  C3_ledger_lower_bound_except_overrun: [...trig("memory_cost_ledger_insert_guard"), (b) => rep(b, lower, lowerFor("NEW.entry_type <> 'overrun'"))],
  C4_ledger_lower_bound_except_release: [...trig("memory_cost_ledger_insert_guard"), (b) => rep(b, lower, lowerFor("NEW.entry_type <> 'release'"))],
  C5_ledger_lower_bound_except_settlement: [...trig("memory_cost_ledger_insert_guard"), (b) => rep(b, lower, lowerFor("NEW.entry_type <> 'settlement'"))],
  // S4
  D1_event_new_normalized_name_check: [...table("memory_topic_events"), (b) => rep(b, "  new_normalized_name TEXT CHECK (\n    new_normalized_name IS NULL\n    OR length(CAST(new_normalized_name AS BLOB)) BETWEEN 1 AND 256\n  ),\n", "  new_normalized_name TEXT,\n")],
  // other single pins on update guards
  E1_vector_item_kind_pin: [...trig("memory_vectors_update_guard"), (b) => rm(b, "  OR NEW.item_kind <> OLD.item_kind\n")],
  E2_vector_embedding_model_pin: [...trig("memory_vectors_update_guard"), (b) => rm(b, "  OR NEW.embedding_model <> OLD.embedding_model\n")],
  E3_vector_content_hash_pin: [...trig("memory_vectors_update_guard"), (b) => rm(b, "  OR NEW.content_hash <> OLD.content_hash\n")],
  E4_vector_mutation_id_pin: [...trig("memory_vectors_update_guard"), (b) => rm(b, "  OR NEW.mutation_id <> OLD.mutation_id\n")],
  E5_vector_ledger_id_pin: [...trig("memory_vectors_update_guard"), (b) => rm(b, "  OR NEW.vector_ledger_id <> OLD.vector_ledger_id\n")],
  E6_vector_principal_pin: [...trig("memory_vectors_update_guard"), (b) => rm(b, "  OR NEW.principal_id <> OLD.principal_id\n")],
  E7_run_id_pin: [...trig("memory_runs_update_guard"), (b) => rm(b, "  OR NEW.run_id <> OLD.run_id\n")],
  E8_run_principal_pin: [...trig("memory_runs_update_guard"), (b) => rm(b, "  OR NEW.principal_id <> OLD.principal_id\n")],
  E9_cursor_principal_pin: [...trig("memory_cursors_monotonic_update"), (b) => rep(b, "WHEN NEW.principal_id <> OLD.principal_id\n  OR NEW.cursor_name", "WHEN NEW.cursor_name")],
  E10_reprocess_job_id_pin: [...trig("memory_reprocess_jobs_update_guard"), (b) => rep(b, "WHEN NEW.job_id <> OLD.job_id\n  OR NEW.principal_id", "WHEN NEW.principal_id")],
  E11_reprocess_principal_pin: [...trig("memory_reprocess_jobs_update_guard"), (b) => rm(b, "  OR NEW.principal_id <> OLD.principal_id\n")],
  E12_item_state_item_id_pin: [...trig("memory_item_state_update_guard"), (b) => rm(b, "  OR NEW.item_id <> OLD.item_id\n")],
  E13_topic_id_pin: [...trig("memory_topics_update_guard"), (b) => rm(b, "  OR NEW.topic_id <> OLD.topic_id\n")],
  E14_placement_state_placement_id_pin: [...trig("memory_item_placement_state_update_guard"), (b) => rm(b, "  OR NEW.placement_id <> OLD.placement_id\n")],
};

const names = selected.length > 0 ? selected : Object.keys(mutations);
try {
  for (const name of names) {
    const [header, endMarker, edit] = mutations[name];
    if (header !== null) {
      const start = lf.indexOf(header);
      const end = lf.indexOf(endMarker, start);
      if (start < 0 || end < 0) throw new Error(`block missing for ${name}`);
      const mutated = lf.slice(0, start) + edit(lf.slice(start, end)) + lf.slice(end);
      if (mutated === lf) throw new Error(`no-op mutation ${name}`);
      writeFileSync(sqlPath, mutated);
    }
    const json = `${outDir}/mut-${name}.json`;
    const started = Date.now();
    const run = spawnSync(`npx.cmd vitest --config vitest.workspace.ts run ${testFile} --reporter=json --outputFile="${json}"`,
      { cwd: root, shell: true, encoding: "utf8", timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(sqlPath, original);
    let summary;
    if (existsSync(json)) {
      const report = JSON.parse(readFileSync(json, "utf8"));
      const tests = report.testResults.flatMap((file) => file.assertionResults);
      const failed = tests.filter((test) => test.status === "failed");
      summary = {
        name, exit: run.status, seconds: Math.round((Date.now() - started) / 1000),
        passed: tests.filter((test) => test.status === "passed").length, failed: failed.length,
        timeouts: failed.filter((test) => (test.failureMessages ?? []).join("\n").includes("timed out")).length,
        failedTitles: failed.map((test) => test.title).slice(0, 8),
        firstFailure: failed[0] ? (failed[0].failureMessages ?? []).join("\n").split("\n")[0].slice(0, 240) : null,
      };
    } else {
      summary = { name, exit: run.status, error: (run.stderr || run.stdout || "").slice(-800) };
    }
    appendFileSync(`${outDir}/mutations.jsonl`, `${JSON.stringify(summary)}\n`);
    console.log(JSON.stringify(summary));
  }
} finally {
  writeFileSync(sqlPath, original);
  console.log(readFileSync(sqlPath, "utf8") === original ? "restored-ok" : "RESTORE-MISMATCH");
}
