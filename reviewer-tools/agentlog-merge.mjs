// Resolve an AGENT_LOG conflict: main's file, with the branch's entries that main lacks
// prepended in the branch's own order. Nothing is reordered or deleted. CRLF output.
// Usage: node agentlog-merge.mjs <branch-file> <main-file> <out>
import fs from "node:fs";
const [branchPath, mainPath, outPath] = process.argv.slice(2);
const norm = (t) => t.replace(/\r\n/g, "\n");
const split = (t) => {
  const first = t.indexOf("\n## ");
  const preamble = t.slice(0, first + 1);
  const blocks = t.slice(first + 1).split(/\n(?=## )/u).map((b) => b.replace(/\s*(---\s*)?$/u, "").trimEnd());
  return { preamble, blocks };
};
const branch = split(norm(fs.readFileSync(branchPath, "utf8")));
const main = split(norm(fs.readFileSync(mainPath, "utf8")));
const mainSet = new Set(main.blocks);
const extra = branch.blocks.filter((b) => !mainSet.has(b));
const blocks = [...extra, ...main.blocks];
const out = main.preamble + blocks.join("\n\n---\n\n") + "\n";
for (const m of ["<<<<<<<", ">>>>>>>"]) if (out.split("\n").some((l) => l.startsWith(m))) throw new Error("marker left");
const missing = [...branch.blocks, ...main.blocks].filter((b) => !out.includes(b));
if (missing.length) throw new Error(`missing ${missing.length}`);
fs.writeFileSync(outPath, out.replace(/\n/g, "\r\n"));
console.log(`prepended ${extra.length} branch entries onto ${main.blocks.length} main entries`);
extra.forEach((b) => console.log("  + " + b.split("\n")[0].slice(0, 110)));
