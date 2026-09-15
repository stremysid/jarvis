import fs from "node:fs";
// Classify trigger-removal results: a kill is "named" when a failing test line mentions the trigger (or its table),
// "other" when tests failed but none names it (possible load timeout), "invalid" when nothing ran.
const files = process.argv.slice(2);
const out = { named: [], other: [], survived: [], invalid: [] };
for (const f of files) {
  const blocks = fs.readFileSync(f, "utf8").split(/\n== /).slice(1);
  for (const b of blocks) {
    const id = b.split(":")[0];
    if (!id.startsWith("T-")) continue;
    const trig = id.slice(2);
    if (/SURVIVED/.test(b.split("\n")[0])) { out.survived.push(id); continue; }
    if (!/Tests\s+\d+ failed/.test(b)) { out.invalid.push(id); continue; }
    const fails = b.split("\n").filter((l) => l.includes("×")).join(" ");
    const table = trig.replace(/_(immutable_update|immutable_delete|insert_guard|update_guard|delete_guard|apply_state|apply|monotonic_update|fts_insert|fts_update|fts_delete|transition_guard|publish_[a-z_]+|terminalize|delete_forbidden|immutable)$/u, "");
    (fails.includes(trig) || fails.includes(table) ? out.named : out.other).push(id);
  }
}
console.log(`named kills ${out.named.length} | other kills ${out.other.length} | survived ${out.survived.length} | invalid ${out.invalid.length}`);
if (out.other.length) console.log("OTHER:", out.other.join(" "));
if (out.survived.length) console.log("SURVIVED:", out.survived.join(" "));
if (out.invalid.length) console.log("INVALID:", out.invalid.join(" "));
