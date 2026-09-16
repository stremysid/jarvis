import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const tree = join(import.meta.dirname, "tree");
const src = "apps/cloud-gateway/src/";
const mutations = [
  ["M1 marker: newline no longer blocks authority", "channels/telegram/telegram-types.ts", " || /[\\r\\n]/u.test(text)) return true;", ") return true;"],
  ["M2 marker: code/expandable_blockquote entity allowed", "channels/telegram/telegram-types.ts", "\"blockquote\", \"expandable_blockquote\", \"code\", \"pre\",", "\"blockquote\", \"pre\","],
  ["M3 marker: non-array entities treated as clean", "channels/telegram/telegram-types.ts", "if (!Array.isArray(entities)) return true;", "if (!Array.isArray(entities)) return false;"],
  ["M4 repo: v2 request identity dropped", "conversation/conversation-repository.ts", "const requestIdentity = this.telegramDirectOwnerText === undefined", "const requestIdentity = true"],
  ["M5 repo: non-telegram channel may carry marker", "conversation/conversation-repository.ts", "if (this.telegramDirectOwnerText !== undefined && channel !== \"telegram\") {", "if (false) {"],
  ["M6 controls: authority text binding removed", "memory/telegram-memory-controls.ts", "&& this.authority.text === input.userText", ""],
  ["M7 controls: channel check removed", "memory/telegram-memory-controls.ts", "const authoritative = input.channel === \"telegram\"\n      &&", "const authoritative ="],
  ["M8 controls: model_claimed state check removed", "memory/telegram-memory-controls.ts", "|| row.channel !== \"telegram\" || row.state !== \"model_claimed\"", "|| row.channel !== \"telegram\""],
  ["M9 controls: ambiguity -> first candidate", "memory/telegram-memory-controls.ts", "if (candidates.length !== 1) {", "if (candidates.length < 1) {"],
  ["M10 retriever: visibility re-check removed", "memory/telegram-memory-retriever.ts", "if (stillVisible === null) continue;", "if (stillVisible === null || true) { /* mutated */ } else continue;"],
  ["M11 retriever: currentAt removed", "memory/telegram-memory-retriever.ts", "|| !currentAt(item, timestamp)) continue;", ") continue;"],
  ["M12 language: outer-quote rejection removed", "memory/telegram-memory-language.ts", "|| OUTER_QUOTE.test(value)) return null;", ") return null;"],
  ["M13 language: slash-command exclusion removed", "memory/telegram-memory-language.ts", "if (text === null || text.startsWith(\"/\")) return null;", "if (text === null) return null;"],
  ["M14 targets: lifecycle recheck removed", "memory/telegram-memory-retriever.ts", "&& states.includes(item.lifecycle.state)", ""],
  ["M15 factory: marker ignores quote/paste authority", "index.ts", "      && accepted.isDirectText\n      && accepted.isMemoryControlAuthoritative,", "      && accepted.isDirectText,"],
  ["M16 retriever: control short-circuit ignores text", "memory/telegram-memory-retriever.ts", "&& this.controlAuthority.text === captured.query) return Object.freeze([]);", ") return Object.freeze([]);"],
];
const tests = [
  "apps/cloud-gateway/test/channels/telegram-classification.test.ts",
  "apps/cloud-gateway/test/memory/telegram-memory.test.ts",
  "apps/cloud-gateway/test/persistence/conversation-repository.test.ts",
  "apps/cloud-gateway/test/memory/automatic-distillation.test.ts",
  "apps/cloud-gateway/test/channels/telegram-webhook.test.ts",
  "apps/cloud-gateway/test/http/worker-telegram-route.test.ts",
  "apps/cloud-gateway/test/memory/memory-owner-controls.test.ts",
];
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const results = [];
for (const [label, file, from, to] of mutations) {
  const id = label.split(" ")[0];
  if (only && !only.has(id)) continue;
  const path = join(tree, src, file);
  const raw = readFileSync(path, "utf8");
  const original = raw.replaceAll("\r\n", "\n");
  const count = original.split(from).length - 1;
  if (count !== 1) { results.push(`${label}: SKIPPED (matches=${count})`); continue; }
  writeFileSync(path, original.replace(from, to));
  try {
    const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "--config", "vitest.workspace.ts", "run", ...tests, "--project", "default"], { cwd: tree, encoding: "utf8", timeout: 300_000 });
    const out = `${run.stdout}\n${run.stderr}`;
    const summary = out.match(/Tests\s+[^\n]*/u)?.[0] ?? "no summary";
    const failed = [...out.matchAll(/FAIL\s+\|default\|\s+([^\n]+)/gu)].map((m) => m[1].trim()).slice(0, 4);
    results.push(`${label}: ${summary}${failed.length ? ` :: ${failed.join(" || ")}` : ""}`);
  } finally {
    writeFileSync(path, raw);
  }
  console.log(results.at(-1));
}
writeFileSync(join(import.meta.dirname, `mutations-${only ? [...only].join("_") : "all"}.txt`), results.join("\n") + "\n");
