// Prepends a mailbox entry directly below the rules' closing "---",
// keeping the file's CRLF line endings.
import fs from "node:fs";

const [logPath, entryPath] = process.argv.slice(2);
const log = fs.readFileSync(logPath, "utf8");
const entry = fs.readFileSync(entryPath, "utf8").replace(/\r\n/g, "\n").trimEnd();

const marker = "\r\n---\r\n\r\n## ";
const at = log.indexOf(marker);
if (at < 0 || log.indexOf(marker, at + 1) >= 0 && log.indexOf(marker) !== at) throw new Error("marker not found");
const insertAt = at + "\r\n---\r\n\r\n".length;
const block = entry.split("\n").join("\r\n") + "\r\n\r\n---\r\n\r\n";
fs.writeFileSync(logPath, log.slice(0, insertAt) + block + log.slice(insertAt));
console.log(`inserted at byte ${insertAt}`);
