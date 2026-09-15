// PR #39 round-5 clause-mutation runner (reviewer-side). One vitest process at a time.
// usage: node pr39-verify5-mutate.mjs <outDir> [mutationName ...]
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = "C:/Users/Sid/jarvis-pr39-verify5";
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

const mergedBlock = "  UPDATE memory_topics SET\n    status = 'merged',\n    redirect_to_topic_id = NEW.merge_target_topic_id,\n    last_topic_event_id = NEW.topic_event_id,\n    updated_at = NEW.occurred_at\n  WHERE NEW.operation = 'merge'\n    AND principal_id = NEW.principal_id AND topic_id = NEW.topic_id;\n\n";
const newDisplayCheck = "  new_display_name TEXT CHECK (\n    new_display_name IS NULL OR (\n      length(CAST(new_display_name AS BLOB)) BETWEEN 1 AND 256\n      AND instr(new_display_name, char(0)) = 0\n      AND new_display_name NOT GLOB ('*[' || char(1) || '-' || char(31)\n        || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')\n    )\n  ),\n";

const mutations = {
  M20_f5_sibling_exclusion: [...trig("memory_topic_events_insert_guard"), (b) => rm(b, "          AND sibling.topic_id <> NEW.topic_id\n"), "merges a topic into its own parent"],
  M21_f5_apply_order: [...trig("memory_topic_events_apply"), (b) => `${rm(b, mergedBlock)}\n${mergedBlock.trimEnd()}`, "merges a topic into its own parent"],
  M22_new_display_name_check: ["CREATE TABLE memory_topic_events (\n", "\n) STRICT", (b) => rep(b, newDisplayCheck, "  new_display_name TEXT,\n"), "refuses OR IGNORE topic events"],
  M25_alias_path_length: [...trig("memory_topic_events_insert_guard"), (b) => rm(b, "      OR length(CAST(json_extract(entry.value, '$.pathAlias') AS BLOB)) NOT BETWEEN 1 AND 2048\n"), "refuses OR IGNORE topic events"],
  M23_reservation_lower_bound: [...trig("memory_cost_ledger_insert_guard"), (b) => rm(b, "  OR (NEW.entry_type = 'reservation'\n    AND NEW.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'))\n"), "rejects a backdated reservation"],
  M26_transition_future_bound: [...trig("memory_item_transitions_insert_guard"), (b) => rm(b, "  OR NEW.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')\n"), "bounds rules expiry"],
  M1_cursor_name_pin: [...trig("memory_cursors_monotonic_update"), (b) => rm(b, "  OR NEW.cursor_name <> OLD.cursor_name\n"), null],
  M2_vector_item_id_pin: [...trig("memory_vectors_update_guard"), (b) => rm(b, "  OR NEW.item_id <> OLD.item_id\n"), null],
  M4_run_key_pin: [...trig("memory_runs_update_guard"), (b) => rm(b, "  OR NEW.run_key <> OLD.run_key\n"), null],
  M5_alias_name_path_duplicate: [...trig("memory_topic_aliases_insert_guard"), (b) => rm(b, "\n      OR (alias.principal_id = NEW.principal_id\n        AND alias.normalized_alias = NEW.normalized_alias\n        AND alias.path_alias = NEW.path_alias)"), null],
  M16_topic_create_sibling: [...trig("memory_topics_insert_guard"), (b) => rm(b, "\n      OR (topic.principal_id = NEW.principal_id\n        AND topic.parent_topic_id IS NEW.parent_topic_id\n        AND topic.normalized_name = NEW.normalized_name\n        AND topic.status = 'active')"), null],
  M18_placement_one_primary: [...trig("memory_item_placement_state_insert_guard"), (b) => rep(b, "\n      AND (state.placement_id = NEW.placement_id\n        OR (state.item_id = NEW.item_id AND state.relation = 'primary'\n          AND state.status = 'active' AND NEW.relation = 'primary' AND NEW.status = 'active'))", "\n      AND state.placement_id = NEW.placement_id"), null],
};

const names = selected.length > 0 ? selected : Object.keys(mutations);
try {
  for (const name of names) {
    const [header, endMarker, edit, filter] = mutations[name];
    const start = lf.indexOf(header);
    const end = lf.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error(`block missing for ${name}`);
    const mutated = lf.slice(0, start) + edit(lf.slice(start, end)) + lf.slice(end);
    if (mutated === lf) throw new Error(`no-op mutation ${name}`);
    writeFileSync(sqlPath, mutated);
    const json = `${outDir}/mut-${name}.json`;
    const filterArg = filter === null ? "" : ` -t "${filter}"`;
    const started = Date.now();
    const run = spawnSync(`npx.cmd vitest --config vitest.workspace.ts run ${testFile}${filterArg} --reporter=json --outputFile="${json}"`,
      { cwd: root, shell: true, encoding: "utf8", timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(sqlPath, original);
    let summary;
    if (existsSync(json)) {
      const report = JSON.parse(readFileSync(json, "utf8"));
      const tests = report.testResults.flatMap((file) => file.assertionResults);
      const failed = tests.filter((test) => test.status === "failed");
      summary = {
        name, filter, exit: run.status, seconds: Math.round((Date.now() - started) / 1000),
        passed: tests.filter((test) => test.status === "passed").length, failed: failed.length,
        timeouts: failed.filter((test) => (test.failureMessages ?? []).join("\n").includes("timed out")).length,
        sweepFailed: failed.some((test) => test.title.startsWith("sweeps every 0016 table")),
        failedTitles: failed.map((test) => test.title).slice(0, 8),
        firstFailure: failed[0] ? (failed[0].failureMessages ?? []).join("\n").split("\n")[0].slice(0, 240) : null,
      };
    } else {
      summary = { name, filter, exit: run.status, error: (run.stderr || run.stdout || "").slice(-800) };
    }
    appendFileSync(`${outDir}/mutations.jsonl`, `${JSON.stringify(summary)}\n`);
    console.log(JSON.stringify(summary));
  }
} finally {
  writeFileSync(sqlPath, original);
  console.log(readFileSync(sqlPath, "utf8") === original ? "restored-ok" : "RESTORE-MISMATCH");
}
