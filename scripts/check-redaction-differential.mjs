import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This runner needs no Worker, credentials or test-pool subprocess. Vitest and
// pytest also consume the same expectations, so parity cannot bless two leaks.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const sourceRoot = resolve(argument("--source-root") ?? root);
const pythonPath = argument("--python-results");
assert.ok(pythonPath, "Supply --python-results from tests/memory/redaction_differential.py.");
const readSource = (path) => readFileSync(resolve(sourceRoot, path), "utf8");
const modules = new Map();
function moduleUrl(path) {
  if (modules.has(path)) return modules.get(path);
  const javascript = stripTypeScriptTypes(readSource(path), { mode: "transform" })
    .replace(/from ["'](\.[^"']+\.js)["']/g, (_match, specifier) => {
    const dependency = resolve(root, dirname(path), specifier).slice(root.length + 1)
      .replaceAll("\\", "/").replace(/\.js$/, ".ts");
    return `from "${moduleUrl(dependency)}"`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  modules.set(path, url);
  return url;
}

const gaps = JSON.parse(readFileSync(resolve(root, "tests/fixtures/redaction-gaps.json"), "utf8"));
const legacy = JSON.parse(readFileSync(resolve(root, "tests/fixtures/memory-projection-policy.json"), "utf8"));
const expand = (text) => text.replaceAll("<six>", "6".repeat(6)).replaceAll("<eight>", "7".repeat(8))
  .replaceAll("<four>", "4".repeat(4)).replaceAll("<bearer>", "a".repeat(15) + "1");
const cases = [
  ...gaps.map((item) => ({ ...item, refuse: item.text !== item.expected })),
  ...legacy.redactionCases.map((item) => ({ ...item, text: expand(item.text) })),
  ...legacy.jsWhitespaceCodePoints.flatMap((point) => legacy.spaceTemplates.map((template, index) => ({
    name: `ECMAScript whitespace ${point}, template ${index}`,
    text: expand(template.replace("<space>", String.fromCodePoint(point))), refuse: true,
  }))),
];
const python = JSON.parse(readFileSync(pythonPath, "utf8"));
assert.deepEqual(python.map((item) => item.name), cases.map((item) => item.name));
const { Redactor } = await import(moduleUrl("apps/cloud-gateway/src/security/redaction.ts"));
const { StreamingOutputRedactor } = await import(moduleUrl("apps/cloud-gateway/src/security/streaming-output-redactor.ts"));
const redactor = new Redactor();
const failures = [];
let differences = 0;
for (const [index, item] of cases.entries()) {
  try {
    const result = redactor.redactText(item.text);
    assert.equal(result.ok, true);
    // NFC can change a whitespace code point without redacting anything.
    // Python's refusal policy compares secrets, not normalization bytes.
    const changed = result.text !== item.text.normalize("NFC");
    assert.equal(result.markers.length > 0, changed, "incorrect redaction metadata");
    if (changed !== python[index].refuse) differences += 1;
    assert.equal(changed, python[index].refuse, "runtimes disagree");
    assert.equal(changed, item.refuse, "incorrect redaction decision");
    if (item.expected !== undefined) {
      assert.equal(result.text, item.expected, "incorrect redacted text");
      for (const channel of ["voice", "telegram"]) {
        assert.deepEqual(redactor.redact({ text: item.text, channel, field: "conversation.turn.text" }), result);
      }
    }
  } catch { failures.push(item.name); }
}
console.log(`${gaps.length} gap cases, ${cases.length} total decisions, ${differences} runtime differences, ${failures.length} expectation failures.`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exitCode = 1;
} else {
  let streams = 0;
  for (const item of gaps) {
    for (const sentences of [false, true]) {
      const partitions = [Array.from(item.text), ...Array.from({ length: item.text.length + 1 }, (_, split) =>
        [item.text.slice(0, split), item.text.slice(split)].filter(Boolean))];
      for (const chunks of partitions) {
        try {
          const stream = new StreamingOutputRedactor(redactor, undefined, sentences);
          let emitted = "";
          for (const [index, text] of chunks.entries()) {
            emitted += stream.push({ index, text }).map((part) => part.text).join("");
            assert.ok(item.expected.startsWith(emitted), `${item.name}: unsafe streamed prefix`);
          }
          assert.equal(stream.complete().text, item.expected, item.name);
          emitted += stream.drain().map((part) => part.text).join("");
          assert.equal(emitted, item.expected, item.name);
          streams += 1;
        } catch {
          console.error(`${item.name}: streaming mismatch with sentence release ${sentences}.`);
          process.exit(1);
        }
      }
    }
  }
  console.log(`${streams} streams match exact expectations at every two-part split and character-by-character in both release modes.`);
}
