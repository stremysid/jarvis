// Moves (or inserts) an entry to be the first "## " heading in AGENT_LOG, CRLF-safe.
import fs from "node:fs";
const [logPath, entryPath] = process.argv.slice(2);
let log = fs.readFileSync(logPath, "utf8");
const entry = fs.readFileSync(entryPath, "utf8").replace(/\r\n/g, "\n").trimEnd().split("\n").join("\r\n");
const block = entry + "\r\n\r\n---\r\n\r\n";
if (log.includes(block)) log = log.replace(block, "");
const at = log.indexOf("\r\n## ");
if (at < 0) throw new Error("no heading");
fs.writeFileSync(logPath, log.slice(0, at + 2) + block + log.slice(at + 2));
console.log("top entry:", fs.readFileSync(logPath, "utf8").match(/\r\n(## [^\r]*)/)[1]);
