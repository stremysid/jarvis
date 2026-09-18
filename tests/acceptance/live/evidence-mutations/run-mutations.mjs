import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FOLLOW_UP_MUTATIONS } from "./follow-up-mutations.mjs";
import { MUTATIONS } from "./mutations.mjs";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TARGET = fileURLToPath(new URL("../voice-smoke.ts", import.meta.url));
const TEST = "tests/acceptance/live/voice-smoke.test.ts";
const ORIGINAL = readFileSync(TARGET, "utf8");
const NORMALIZED = ORIGINAL.replaceAll("\r\n", "\n");
const ALL_MUTATIONS = Object.freeze([...MUTATIONS, ...FOLLOW_UP_MUTATIONS]);

function runVitest() {
  const args = ["exec", "vitest", "run", TEST, "--no-cache"];
  const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
  const windowsCommand = `pnpm.cmd exec vitest run ${TEST} --no-cache`;
  const executableArgs = process.platform === "win32"
    ? ["/d", "/c", windowsCommand]
    : args;
  return spawnSync(executable, executableArgs, {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function occurrenceCount(source, anchor) {
  return source.split(anchor).length - 1;
}

let failed = false;
console.log(`target: ${TEST}`);
const baseline = runVitest();
console.log(`BASE: ${baseline.status === 0 ? "PASS" : "FAIL"}`);
if (baseline.status !== 0) {
  process.stdout.write(baseline.stdout);
  process.stderr.write(baseline.stderr);
  process.exitCode = 1;
} else {
  try {
    for (const mutation of ALL_MUTATIONS) {
      const matches = occurrenceCount(NORMALIZED, mutation.from);
      if (matches !== 1) {
        console.log(`${mutation.id}: INVALID_SPEC anchor_matches=${matches}`);
        failed = true;
        continue;
      }
      writeFileSync(TARGET, NORMALIZED.replace(mutation.from, mutation.to), "utf8");
      const result = runVitest();
      const output = `${result.stdout}\n${result.stderr}`;
      const killedByNamedTest = result.status !== 0 && output.includes(mutation.testName);
      const outcome = killedByNamedTest ? "KILLED" : result.status === 0 ? "SURVIVED" : "WRONG_FAILURE";
      console.log(`${mutation.id}: ${outcome} by \"${mutation.testName}\"`);
      if (!killedByNamedTest) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        failed = true;
      }
      writeFileSync(TARGET, ORIGINAL, "utf8");
    }
  } finally {
    writeFileSync(TARGET, ORIGINAL, "utf8");
  }
  console.log(`summary: ${failed ? "FAIL" : `${ALL_MUTATIONS.length}/${ALL_MUTATIONS.length} KILLED`}`);
  if (failed) process.exitCode = 1;
}
