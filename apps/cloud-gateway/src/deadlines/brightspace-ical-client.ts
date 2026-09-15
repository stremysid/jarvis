/**
 * Read-only Brightspace calendar-feed adapter.
 *
 * The configured URL is a bearer credential. It is used as the request target
 * and nowhere else: failures are fixed codes, redirects are refused, and no
 * response body or URL is copied into source health. Calendar properties are
 * untrusted source text. This parser only extracts the narrow fields deadline
 * ingestion accepts and never treats a URL, description, or extension field
 * as an instruction or a second request target.
 */

import type { RawDeadlineItem } from "./deadline-types.js";

const MAXIMUM_FEED_BYTES = 1_048_576;
const MAXIMUM_FEED_URL_CHARACTERS = 4_096;
const MAXIMUM_COMPONENTS = 2_000;
const MAXIMUM_PROPERTIES_PER_COMPONENT = 256;
const DEFAULT_TIMEOUT_MS = 10_000;
const UNSAFE_URL_CHARACTERS = /[\s\p{Cc}\p{Cf}]/u;
const CONTENT_NAME = /^[A-Z0-9-]+(?:\.[A-Z0-9-]+)?$/u;
const DATE = /^(\d{4})(\d{2})(\d{2})$/u;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u;

export type BrightspaceFeedFailureCode =
  | "brightspace_feed_url_invalid"
  | "brightspace_feed_redirected"
  | "brightspace_feed_rejected"
  | "brightspace_feed_unavailable"
  | "brightspace_feed_too_large"
  | "brightspace_feed_invalid";

/** A fixed-code failure. Neither the bearer URL nor upstream content is retained. */
export class BrightspaceFeedError extends Error {
  readonly status: number | null;
  readonly transient: boolean;

  constructor(code: BrightspaceFeedFailureCode, status: number | null, transient: boolean) {
    super(code);
    this.name = "BrightspaceFeedError";
    this.status = status;
    this.transient = transient;
  }
}

export interface BrightspaceIcalClientOptions {
  readonly feedUrl: string;
  readonly timeZone: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

interface ContentProperty {
  readonly name: string;
  readonly parameters: ReadonlyMap<string, string>;
  readonly value: string;
}

interface CalendarComponent {
  readonly kind: "VEVENT" | "VTODO";
  readonly properties: ReadonlyMap<string, readonly ContentProperty[]>;
}

function failure(
  code: BrightspaceFeedFailureCode,
  status: number | null = null,
  transient = false,
): BrightspaceFeedError {
  return new BrightspaceFeedError(code, status, transient);
}

function requireFeedUrl(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAXIMUM_FEED_URL_CHARACTERS
    || !value.isWellFormed()
    || value !== value.normalize("NFC")
    || UNSAFE_URL_CHARACTERS.test(value)
  ) {
    throw failure("brightspace_feed_url_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw failure("brightspace_feed_url_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.length === 0
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.hash.length > 0
  ) {
    throw failure("brightspace_feed_url_invalid");
  }
  return parsed.href;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    else if (character === separator && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) throw failure("brightspace_feed_invalid");
  parts.push(value.slice(start));
  return parts;
}

function contentSeparator(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') quoted = !quoted;
    else if (character === ":" && !quoted) return index;
  }
  return -1;
}

function parameterValue(value: string): string {
  if (value.startsWith('"') || value.endsWith('"')) {
    if (!(value.startsWith('"') && value.endsWith('"')) || value.length < 2) {
      throw failure("brightspace_feed_invalid");
    }
    return value.slice(1, -1);
  }
  return value;
}

function parseContentLine(line: string): ContentProperty {
  const separator = contentSeparator(line);
  if (separator <= 0) throw failure("brightspace_feed_invalid");
  const header = splitOutsideQuotes(line.slice(0, separator), ";");
  const rawName = header.shift()?.toUpperCase() ?? "";
  if (!CONTENT_NAME.test(rawName)) throw failure("brightspace_feed_invalid");
  const name = rawName.slice(rawName.lastIndexOf(".") + 1);
  const parameters = new Map<string, string>();
  for (const raw of header) {
    const equals = raw.indexOf("=");
    if (equals <= 0) throw failure("brightspace_feed_invalid");
    const key = raw.slice(0, equals).toUpperCase();
    if (!/^[A-Z0-9-]+$/u.test(key) || parameters.has(key)) throw failure("brightspace_feed_invalid");
    parameters.set(key, parameterValue(raw.slice(equals + 1)));
  }
  return Object.freeze({ name, parameters, value: line.slice(separator + 1) });
}

/** RFC 5545 line unfolding. A continuation without a line to continue is malformed. */
function unfold(value: string): readonly string[] {
  const physical = value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  const lines: string[] = [];
  for (const line of physical) {
    if (/^[ \t]/u.test(line)) {
      if (lines.length === 0) throw failure("brightspace_feed_invalid");
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function addProperty(
  properties: Map<string, ContentProperty[]>,
  property: ContentProperty,
  count: number,
): number {
  const next = count + 1;
  if (next > MAXIMUM_PROPERTIES_PER_COMPONENT) throw failure("brightspace_feed_invalid");
  const existing = properties.get(property.name) ?? [];
  existing.push(property);
  properties.set(property.name, existing);
  return next;
}

function parseComponents(value: string): readonly CalendarComponent[] {
  const components: CalendarComponent[] = [];
  const stack: string[] = [];
  let sawCalendar = false;
  let currentKind: "VEVENT" | "VTODO" | null = null;
  let currentProperties = new Map<string, ContentProperty[]>();
  let propertyCount = 0;

  for (const line of unfold(value)) {
    const property = parseContentLine(line);
    if (property.name === "BEGIN") {
      const kind = property.value.toUpperCase();
      if (!/^[A-Z0-9-]+$/u.test(kind)) throw failure("brightspace_feed_invalid");
      if (stack.length === 0) {
        if (kind !== "VCALENDAR" || sawCalendar) throw failure("brightspace_feed_invalid");
        sawCalendar = true;
      } else if (stack.length === 1 && (kind === "VEVENT" || kind === "VTODO")) {
        currentKind = kind;
        currentProperties = new Map();
        propertyCount = 0;
      }
      stack.push(kind);
      continue;
    }
    if (property.name === "END") {
      const kind = property.value.toUpperCase();
      if (stack.pop() !== kind) throw failure("brightspace_feed_invalid");
      if (currentKind === kind && stack.length === 1) {
        components.push(Object.freeze({ kind: currentKind, properties: currentProperties }));
        if (components.length > MAXIMUM_COMPONENTS) throw failure("brightspace_feed_invalid");
        currentKind = null;
        currentProperties = new Map();
      }
      continue;
    }
    if (currentKind !== null && stack.length === 2 && stack[1] === currentKind) {
      propertyCount = addProperty(currentProperties, property, propertyCount);
    }
  }

  if (!sawCalendar || stack.length !== 0 || currentKind !== null) throw failure("brightspace_feed_invalid");
  return components;
}

function one(
  component: CalendarComponent,
  name: string,
  required: boolean,
): ContentProperty | null {
  const values = component.properties.get(name) ?? [];
  if (values.length > 1 || (required && values.length !== 1)) throw failure("brightspace_feed_invalid");
  return values[0] ?? null;
}

function unescapeText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) throw failure("brightspace_feed_invalid");
    if (escaped === "n" || escaped === "N") result += "\n";
    else if (escaped === "\\" || escaped === "," || escaped === ";") result += escaped;
    else throw failure("brightspace_feed_invalid");
  }
  return result;
}

function firstTextValue(value: string): string {
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") escaped = true;
    else if (character === ",") return unescapeText(value.slice(0, index));
  }
  return unescapeText(value);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw failure("brightspace_feed_invalid");
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

function formattedWall(instant: number, formatter: Intl.DateTimeFormat): Omit<WallTime, "millisecond"> {
  const parts = formatter.formatToParts(new Date(instant));
  const field = (type: string): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isSafeInteger(parsed)) throw failure("brightspace_feed_invalid");
    return parsed;
  };
  return {
    year: field("year"), month: field("month"), day: field("day"),
    hour: field("hour"), minute: field("minute"), second: field("second"),
  };
}

function zoneOffsetMilliseconds(instant: number, formatter: Intl.DateTimeFormat): number {
  const wall = formattedWall(instant, formatter);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
    - Math.floor(instant / 1_000) * 1_000;
}

function localInstant(wall: WallTime, timeZone: string): string {
  const formatter = zoneFormatter(timeZone);
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  const first = naive - zoneOffsetMilliseconds(naive, formatter);
  const instant = naive - zoneOffsetMilliseconds(first, formatter);
  const roundTrip = formattedWall(instant, formatter);
  if (
    roundTrip.year !== wall.year || roundTrip.month !== wall.month || roundTrip.day !== wall.day
    || roundTrip.hour !== wall.hour || roundTrip.minute !== wall.minute || roundTrip.second !== wall.second
  ) {
    throw failure("brightspace_feed_invalid");
  }
  return new Date(instant).toISOString();
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

function numberAt(match: RegExpMatchArray, index: number): number {
  const value = Number(match[index]);
  if (!Number.isSafeInteger(value)) throw failure("brightspace_feed_invalid");
  return value;
}

function calendarInstant(property: ContentProperty, defaultTimeZone: string): string {
  const valueType = property.parameters.get("VALUE")?.toUpperCase() ?? "DATE-TIME";
  const timeZone = property.parameters.get("TZID");
  if (valueType === "DATE") {
    const match = property.value.match(DATE);
    if (match === null || timeZone !== undefined) throw failure("brightspace_feed_invalid");
    const year = numberAt(match, 1);
    const month = numberAt(match, 2);
    const day = numberAt(match, 3);
    if (!validCalendarDate(year, month, day)) throw failure("brightspace_feed_invalid");
    return localInstant({ year, month, day, hour: 23, minute: 59, second: 59, millisecond: 999 }, defaultTimeZone);
  }
  if (valueType !== "DATE-TIME") throw failure("brightspace_feed_invalid");
  const match = property.value.match(DATE_TIME);
  if (match === null) throw failure("brightspace_feed_invalid");
  const year = numberAt(match, 1);
  const month = numberAt(match, 2);
  const day = numberAt(match, 3);
  const hour = numberAt(match, 4);
  const minute = numberAt(match, 5);
  const second = numberAt(match, 6);
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    throw failure("brightspace_feed_invalid");
  }
  if (match[7] === "Z") {
    if (timeZone !== undefined) throw failure("brightspace_feed_invalid");
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
  }
  return localInstant(
    { year, month, day, hour, minute, second, millisecond: 0 },
    timeZone ?? defaultTimeZone,
  );
}

function externalId(component: CalendarComponent, uid: ContentProperty): string {
  const base = unescapeText(uid.value);
  const recurrence = one(component, "RECURRENCE-ID", false);
  return recurrence === null ? base : `${base}:${recurrence.value}`;
}

function toDeadline(component: CalendarComponent, defaultTimeZone: string): RawDeadlineItem | null {
  const status = one(component, "STATUS", false);
  const normalizedStatus = status === null ? "" : unescapeText(status.value).trim().toUpperCase();
  if (normalizedStatus === "CANCELLED" || normalizedStatus === "COMPLETED") return null;

  const due = one(component, component.kind === "VEVENT" ? "DTSTART" : "DUE", false);
  if (due === null) return null;
  const uid = one(component, "UID", true);
  const summary = one(component, "SUMMARY", true);
  const category = one(component, "CATEGORIES", false);
  if (uid === null || summary === null) throw failure("brightspace_feed_invalid");
  const course = category === null ? "Brightspace" : firstTextValue(category.value).trim() || "Brightspace";
  return Object.freeze({
    externalId: externalId(component, uid),
    course,
    title: unescapeText(summary.value),
    dueAt: calendarInstant(due, defaultTimeZone),
  });
}

/** Parse the one calendar object a Brightspace subscription returns. */
export function parseBrightspaceCalendar(value: string, defaultTimeZone: string): readonly RawDeadlineItem[] {
  const items: RawDeadlineItem[] = [];
  const identifiers = new Set<string>();
  for (const component of parseComponents(value)) {
    const item = toDeadline(component, defaultTimeZone);
    if (item === null) continue;
    const identifier = item.externalId.normalize("NFC");
    if (identifiers.has(identifier)) throw failure("brightspace_feed_invalid");
    identifiers.add(identifier);
    items.push(item);
  }
  return Object.freeze(items);
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAXIMUM_FEED_BYTES) {
    throw failure("brightspace_feed_too_large", response.status);
  }
  if (response.body === null) throw failure("brightspace_feed_invalid", response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAXIMUM_FEED_BYTES) throw failure("brightspace_feed_too_large", response.status);
      chunks.push(chunk.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw failure("brightspace_feed_invalid", response.status);
  }
}

export class BrightspaceIcalClient {
  readonly #feedUrl: string;
  readonly #timeZone: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: BrightspaceIcalClientOptions) {
    this.#feedUrl = requireFeedUrl(options.feedUrl);
    this.#timeZone = options.timeZone;
    // Validate the owner's configured zone before making the bearer request.
    zoneFormatter(this.#timeZone);
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw failure("brightspace_feed_url_invalid");
    }
  }

  async collectDeadlines(): Promise<readonly RawDeadlineItem[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(failure("brightspace_feed_unavailable", null, true));
        }, this.#timeoutMs);
      });
      const requestAndRead = (async () => {
        const response = await this.#fetch(this.#feedUrl, {
          method: "GET",
          headers: { accept: "text/calendar" },
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          void response.body?.cancel().catch(() => undefined);
          throw failure("brightspace_feed_redirected", response.status);
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const transient = response.status === 429 || response.status >= 500;
          throw failure(transient ? "brightspace_feed_unavailable" : "brightspace_feed_rejected", response.status, transient);
        }
        return parseBrightspaceCalendar(await readBounded(response), this.#timeZone);
      })();
      return await Promise.race([requestAndRead, timedOut]);
    } catch (error) {
      if (error instanceof BrightspaceFeedError) throw error;
      throw failure("brightspace_feed_unavailable", null, true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
}
