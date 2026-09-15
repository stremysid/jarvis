// One mutation per run against the exact 407af7d validator, scored by the PR's own named tests.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { MUTATIONS } from "./mutations.mjs";

const TARGET = new URL("./voice-smoke.ts", import.meta.url);
const ORIGINAL = readFileSync(new URL("./voice-smoke.orig.ts", import.meta.url), "utf8");

const summary = [];
try {
  for (const mutation of MUTATIONS) {
    const occurrences = ORIGINAL.split(mutation.from).length - 1;
    if (occurrences !== 1) {
      console.log(`== ${mutation.id}: SKIPPED (anchor occurs ${occurrences} times)`);
      summary.push(`SKIPPED  ${mutation.id}`);
      continue;
    }
    writeFileSync(TARGET, ORIGINAL.replace(mutation.from, mutation.to), "utf8");
    const run = spawnSync(process.execPath, ["run-tests.mjs", "./voice-smoke.test.ts"], {
      cwd: new URL("./", import.meta.url), encoding: "utf8",
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const killed = run.status !== 0;
    const named = output.split("\n").filter((line) => line.includes("FAIL ["));
    console.log(`== ${mutation.id}: ${killed ? "KILLED" : "SURVIVED"} (exit ${run.status})`);
    console.log(`   ${output.split("\n").find((line) => line.startsWith("total=")) ?? output.slice(0, 200)}`);
    for (const line of named) console.log(`   ${line.trim()}`);
    summary.push(`${killed ? "KILLED " : "SURVIVED"} ${mutation.id}${killed && named.length > 0 ? `  <- ${named.length} named test(s)` : ""}`);
  }
} finally {
  writeFileSync(TARGET, ORIGINAL, "utf8");
  console.log("\n(validator copy restored)");
}

console.log("\n=== summary ===");
for (const line of summary) console.log(line);
