// Generic mutation runner for reviewer checks.
// Usage: node mutrun.mjs <mutations.json> [idPrefix]
// JSON: { "root": "C:/Users/Sid/jarvis-deploy", "branch": "origin/...",
//         "mutations": [ { "id", "file", "from", "to", "also"?: {from,to},
//                          "runner"?: "vitest" | "pytest",
//                          "tests": [ "path", ... ] } ] }
// Each mutation must match exactly once. The file is restored with git after
// every run, and the tree must be clean before the next mutation starts.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [specPath, only] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const root = spec.root;
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });

if (git("status", "--porcelain").stdout.trim() !== "") throw new Error("tree dirty before start");
if (spec.branch) {
  const checkout = git("checkout", "--detach", spec.branch);
  if (checkout.status !== 0) throw new Error(`checkout failed: ${checkout.stderr}`);
  console.log(`checked out ${spec.branch} at ${git("rev-parse", "--short", "HEAD").stdout.trim()}`);
}

function run(m) {
  if ((m.runner ?? "vitest") === "pytest") {
    return spawnSync("uv", ["run", "pytest", "-q", ...m.tests], {
      cwd: `${root}/apps/local-agent`, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024,
    });
  }
  return spawnSync("npx.cmd", ["vitest", "--config", "vitest.workspace.ts", "run", ...m.tests], {
    cwd: root, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024,
  });
}

const results = [];
for (const m of spec.mutations.filter((x) => !only || x.id.startsWith(only))) {
  const path = `${root}/${m.file}`;
  const raw = fs.readFileSync(path, "utf8");
  const crlf = raw.includes("\r\n");
  let text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  let ok = true;
  for (const e of [m, ...(m.also ? [m.also] : [])]) {
    const count = text.split(e.from).length - 1;
    if (count !== 1) { console.log(`\n== ${m.id}: MATCHED ${count} TIMES, skipped`); ok = false; break; }
    text = text.replace(e.from, e.to);
  }
  if (!ok) { results.push({ id: m.id, verdict: "SKIPPED" }); continue; }
  fs.writeFileSync(path, crlf ? text.replace(/\n/g, "\r\n") : text);
  const r = run(m);
  git("checkout", "--", m.file);
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const lines = out.split(/\r?\n/);
  const failed = lines.filter((l) => /^\s*×\s|^FAILED\s|\sFAILED\s/.test(l)).slice(0, 4);
  const summary = lines.filter((l) => /^\s*(Test Files|Tests)\s|\d+ (passed|failed)/.test(l)).slice(-3);
  const clean = git("status", "--porcelain").stdout.trim() === "";
  const verdict = r.status === 0 ? "SURVIVED" : "KILLED";
  console.log(`\n== ${m.id}: ${verdict} (exit ${r.status}), tree clean=${clean}`);
  for (const l of [...summary, ...failed]) console.log("   " + l.trim());
  if (summary.length === 0) console.log("   (no test summary; check the run executed)\n" + out.slice(-600));
  results.push({ id: m.id, verdict });
  if (!clean) throw new Error("tree not clean after restore");
}

if (spec.branch) git("checkout", "--detach", "origin/main");
console.log("\n=== summary");
for (const r of results) console.log(`${r.verdict.padEnd(9)} ${r.id}`);
console.log(`back on main, tree clean=${git("status", "--porcelain").stdout.trim() === ""}`);
