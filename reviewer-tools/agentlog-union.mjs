// Resolves a docs/AGENT_LOG.md merge conflict the way the file's rules require:
// keep every entry from both sides, newest first, delete nothing.
// Usage: node agentlog-union.mjs <ours> <theirs> <output> <crlf|lf>
// Each entry's raw text is kept byte-for-byte (after LF normalization); only the
// order of whole entries changes. Exact duplicates (same text) appear once.
import fs from "node:fs";

const [oursPath, theirsPath, outPath, eol] = process.argv.slice(2);
const norm = (text) => text.replace(/\r\n/g, "\n");
const ours = norm(fs.readFileSync(oursPath, "utf8"));
const theirs = norm(fs.readFileSync(theirsPath, "utf8"));

const HEADING = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\b/m;
const HEADING_ALL = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\b.*$/gm;

function parse(text, label) {
  const first = text.search(HEADING);
  if (first < 0) throw new Error(`${label}: no dated entry found`);
  const preamble = text.slice(0, first);
  const starts = [...text.matchAll(HEADING_ALL)].map((m) => m.index);
  const entries = starts.map((start, i) => {
    const raw = text.slice(start, i + 1 < starts.length ? starts[i + 1] : text.length);
    const key = raw.replace(/\s*(---\s*)?$/u, "").trimEnd();
    const stamp = HEADING.exec(raw)[1];
    return { raw, key, stamp };
  });
  return { preamble, entries };
}

const a = parse(ours, "ours");
const b = parse(theirs, "theirs");
if (a.preamble !== b.preamble) {
  console.log("NOTE: preambles differ; using main's (theirs) preamble");
}

// Union by content key. Prefer main's copy when both sides hold the same entry.
const byKey = new Map();
for (const entry of b.entries) byKey.set(entry.key, entry);
for (const entry of a.entries) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);

// Newest first by heading timestamp; the sort is stable for equal minutes.
const merged = [...byKey.values()].sort((x, y) => (x.stamp < y.stamp ? 1 : x.stamp > y.stamp ? -1 : 0));

// Every entry must end with a separator before the next one.
const body = merged.map((entry, i) => {
  const trimmed = entry.key;
  return i + 1 < merged.length ? `${trimmed}\n\n---\n\n` : `${trimmed}\n`;
}).join("");
let result = b.preamble + body;

for (const marker of ["<<<<<<<", "=======", ">>>>>>>"]) {
  if (result.split("\n").some((line) => line.startsWith(marker))) throw new Error(`conflict marker left: ${marker}`);
}
const missing = [...a.entries, ...b.entries].filter((entry) => !result.includes(entry.key));
if (missing.length > 0) throw new Error(`missing ${missing.length} entries after union`);

if (eol === "crlf") result = result.replace(/\n/g, "\r\n");
fs.writeFileSync(outPath, result);
console.log(`ours entries=${a.entries.length} theirs entries=${b.entries.length} merged=${merged.length} (duplicates=${a.entries.length + b.entries.length - merged.length})`);
console.log(`newest: ${merged[0].stamp} | oldest: ${merged[merged.length - 1].stamp}`);
