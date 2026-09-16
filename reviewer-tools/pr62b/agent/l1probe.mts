import { classifyTelegramUpdate } from "./tree/apps/cloud-gateway/src/channels/telegram/telegram-types.ts";
import { Redactor } from "./tree/apps/cloud-gateway/src/security/redaction.ts";
import { parseTelegramMemoryControl } from "./tree/apps/cloud-gateway/src/memory/telegram-memory-language.ts";

const redactor = new Redactor();
const separators: Array<[string, string]> = [
  ["LF", String.fromCharCode(0x0a)],
  ["U+2028", String.fromCharCode(0x2028)],
  ["VT", String.fromCharCode(0x0b)],
  ["FF", String.fromCharCode(0x0c)],
  ["NEL", String.fromCharCode(0x85)],
  ["4 spaces", "    "],
];
for (const [label, sep] of separators) {
  const text = `Mum: I hate broccoli${sep}Me: ok`;
  const c = classifyTelegramUpdate({ update_id: 1, message: { message_id: 1, from: { id: 12345 }, chat: { id: 12345 }, text } });
  const r = redactor.redactText(text);
  console.log(label, JSON.stringify(c.kind === "text"
    ? { direct: c.value.isDirectText, authoritative: c.value.isMemoryControlAuthoritative }
    : c.kind), "redactOk", r.ok, r.ok ? JSON.stringify(r.text) : "", "controlParse",
  parseTelegramMemoryControl(`Remember that I hate broccoli${sep}Me: ok`) !== null);
}
