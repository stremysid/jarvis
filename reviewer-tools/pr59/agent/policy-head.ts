const MAX_MEMORY_FACT_BYTES = 4_096;
const MAX_MEMORY_FACT_SOURCES = 8;
type MemoryFactOriginV1 = string;
type MemoryFactSensitivityV1 = "normal" | "sensitive";
function hasFactTextControls(text: string): boolean { for (const ch of text) { const c = ch.codePointAt(0)!; if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true; } return false; }
function sanitizeRedaction(t: string) { return { ok: true, text: t }; }
