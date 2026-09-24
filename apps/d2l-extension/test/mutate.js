import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import spec from "./mutations.js";

const root = new URL("../", import.meta.url);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(testFile, testName) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    `--test-name-pattern=^${escape(testName)}$`, `test/${testFile}`], {
    cwd: fileURLToPath(root), encoding: "utf8", timeout: 10000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { status: result.status, output,
    pass: Number(output.match(/^# pass (\d+)$/m)?.[1]),
    fail: Number(output.match(/^# fail (\d+)$/m)?.[1]),
    skip: Number(output.match(/^# skipped (\d+)$/m)?.[1]),
    namedFailure: new RegExp(`^not ok \\d+ - ${escape(testName)}$`, "m").test(output),
  };
}
const evidence = [];
const requested = process.argv.slice(2);
const selected = requested.length ? spec.filter((mutation) => requested.includes(mutation.name)) : spec;
assert.ok(selected.length > 0, "No mutations selected.");
for (const mutation of selected) {
  const path = new URL(mutation.file, root);
  const original = readFileSync(path);
  const source = original.toString("utf8");
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const find = mutation.find.replace(/\r?\n/g, lineEnding);
  const replacement = mutation.replace.replace(/\r?\n/g, lineEnding);
  if (source.split(find).length !== 2) {
    evidence.push({ name: mutation.name, verdict: "NOT APPLIED" });
    continue;
  }
  const baseline = run(mutation.testFile, mutation.testName);
  assert.ok(baseline.status === 0 && baseline.pass === 1 && baseline.fail === 0, baseline.output);
  const modified = source.replace(find, replacement);
  assert.notEqual(modified, source);
  let killed;
  let confirmed;
  try {
    writeFileSync(path, modified);
    assert.equal(readFileSync(path, "utf8"), modified);
    killed = run(mutation.testFile, mutation.testName);
    confirmed = run(mutation.testFile, mutation.testName);
  } finally {
    writeFileSync(path, original);
    assert.ok(readFileSync(path).equals(original), "Byte-exact restoration failed.");
  }
  const restored = run(mutation.testFile, mutation.testName);
  assert.ok(restored.status === 0 && restored.pass === 1 && restored.fail === 0, restored.output);
  const namedKill = (result) => result.status !== 0 && result.fail === 1 && result.namedFailure;
  const verdict = namedKill(killed) && namedKill(confirmed) ? "KILLED" : "NOT CONFIRMED";
  const row = { name: mutation.name, test: mutation.testName, verdict,
    baseline: `${baseline.pass}/${baseline.fail}/${baseline.skip}`,
    mutated: `${killed.pass}/${killed.fail}/${killed.skip}`,
    confirmed: `${confirmed.pass}/${confirmed.fail}/${confirmed.skip}`,
    restored: `${restored.pass}/${restored.fail}/${restored.skip}` };
  evidence.push(row);
  console.log(JSON.stringify(row));
  if (verdict !== "KILLED") console.log(killed.output);
}
const killed = evidence.filter((row) => row.verdict === "KILLED").length;
const notApplied = evidence.filter((row) => row.verdict === "NOT APPLIED").length;
console.log(JSON.stringify({ mutations: selected.length, killed, notApplied, unconfirmed: selected.length - killed - notApplied }));
if (killed !== selected.length) process.exitCode = 1;
