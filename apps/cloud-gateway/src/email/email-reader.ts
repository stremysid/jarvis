import PostalMime from "postal-mime";
import type { ArchiveBucket } from "../archive/archival-service.js";
import { boundedEmailText, INBOX_EVIDENCE_BYTES, type EmailInbox } from "./email-inbox.js";
import { emailHtmlText } from "./html-text.js";

const encoder = new TextEncoder();
/**
 * The most text bytes one read page carries. A page carries fewer when its
 * JSON-escaped form would not fit INBOX_EVIDENCE_BYTES; `next_offset` is then
 * the first byte not delivered. The model pages until `next_offset` is null.
 */
export const INBOX_READ_PAGE_BYTES = 4_096;
const MAXIMUM_PART_CHARACTERS = 16;

export type InboxReadPart = "body" | "source" | "raw";

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/**
 * The longest prefix of `candidate` whose JSON-escaped form fits `budget` bytes.
 *
 * A page is at most INBOX_READ_PAGE_BYTES of text, but JSON escaping can
 * multiply that (a quote becomes two bytes, a control character six), and the
 * evidence cap applies to the escaped form. Measuring each code point's escaped
 * size keeps the page whole, so `next_offset` always points at the first byte
 * the model has not been given.
 */
function fittingPrefix(candidate: string, budget: number): string {
  let used = 0;
  let end = 0;
  for (const character of candidate) {
    const escaped = jsonBytes(character) - 2;
    if (used + escaped > budget) break;
    used += escaped;
    end += character.length;
  }
  return candidate.slice(0, end);
}

function readPart(value: unknown): InboxReadPart {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_PART_CHARACTERS
    || !["body", "source", "raw"].includes(value)) throw new Error("email_inbox_read_page_invalid");
  return value as InboxReadPart;
}

/**
 * One bounded page of an archived message.
 *
 * `offset` is a UTF-8 byte offset and the page never ends mid-character, so
 * concatenating pages reproduces the stored text exactly. `next_offset` is null
 * on the last page; a caller that stops early has read a prefix, not the message.
 */
export async function readInboxPage(
  inbox: EmailInbox,
  archive: Pick<ArchiveBucket, "get">,
  principalId: string,
  emailId: string,
  part: unknown = "body",
  offset: unknown = 0,
): Promise<Record<string, unknown> | null> {
  const requested = readPart(part);
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error("email_inbox_read_page_invalid");
  const start = offset as number;
  const row = await inbox.read(principalId, emailId);
  const legacy = row === null ? await inbox.readLegacy(principalId, emailId) : null;
  if (row === null && legacy === null) return null;
  let raw: ArrayBuffer;
  let source: string;
  if (row !== null) {
    const archived = await archive.get(row.raw_key);
    const facts = await archive.get(row.facts_key);
    // A missing object is an operational failure, not an empty message: an
    // empty page would read as "the email had no content".
    if (archived === null || facts === null) throw new Error("email_inbox_read_archive_unavailable");
    raw = await archived.arrayBuffer();
    source = await facts.text();
  } else {
    raw = Uint8Array.from(atob(legacy!.raw_mime_base64), (character) => character.charCodeAt(0)).buffer;
    source = JSON.stringify({
      source: "Legacy D2L quarantine, kept before the inbox existed",
      envelope: "Full envelope was not retained",
      authentication: JSON.parse(legacy!.authentication_json),
      quarantineReason: legacy!.quarantine_reason,
      legacyStructuredFacts: JSON.parse(legacy!.structured_json),
      retainedRawBytes: raw.byteLength,
      limitation: "Only the bytes that were retained at the time are available; mail the old code discarded cannot be recovered",
    });
  }
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>> | null = null;
  try {
    parsed = await PostalMime.parse(raw, {
      rfc822Attachments: true, maxNestingDepth: 20, maxHeadersSize: 65_536, maxRfc822NestingDepth: 3,
    });
  } catch {
    // Raw pages stay readable even when MIME extraction fails, and the page
    // reports the failure rather than presenting an empty body.
  }
  const text = requested === "raw"
    ? new TextDecoder().decode(raw)
    : requested === "source"
      ? source
      : parsed?.text ?? emailHtmlText(parsed?.html ?? "");
  const bytes = encoder.encode(text);
  const candidate = new TextDecoder().decode(bytes.slice(start, start + INBOX_READ_PAGE_BYTES), { stream: true });
  const page = {
    email_id: emailId,
    source: row === null ? "legacy_quarantine" : "inbox",
    received_at: row?.received_at ?? legacy!.received_at,
    from: boundedEmailText(parsed?.headers.find(({ key }) => key === "from")?.value ?? "", 256),
    subject: boundedEmailText(parsed?.subject ?? "", 512),
    part: requested,
    offset: start,
    // The widest value either field can take, so the measured envelope is
    // never smaller than the one finally serialized.
    next_offset: bytes.byteLength as number | null,
    total_text_bytes: bytes.byteLength,
    parse_status: parsed === null ? "failed" : "parsed",
    content: "",
  };
  const content = fittingPrefix(candidate, INBOX_EVIDENCE_BYTES - jsonBytes(page));
  const end = start + encoder.encode(content).byteLength;
  page.next_offset = end < bytes.byteLength ? end : null;
  page.content = content;
  return page;
}
