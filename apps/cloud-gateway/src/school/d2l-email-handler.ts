import PostalMime, { addressParser, type Email } from "postal-mime";
import { sha256Hex } from "../../../../packages/contracts/src/index.js";
import { DeadlineIngestion } from "../deadlines/deadline-ingestion.js";
import { DeadlineRepository } from "../deadlines/deadline-repository.js";
import type { Env } from "../env.js";
import {
  assessAuthenticity,
  type AuthenticityEvidence,
} from "./d2l-email-authenticity.js";
import { D2lEmailRepository, type D2lEmailMessageReceipt } from "./d2l-email-repository.js";
import { parseD2lEmail, type ParsedD2lEmailEvent } from "./d2l-email-parser.js";
import { SchoolObservationRepository } from "./school-observation-repository.js";

export const D2L_EMAIL_SOURCE_ID = "d2l-notification-email";
// Raw receipts are base64 inside an authoritative backup row. Staying below
// 512 KiB leaves room for the measured headers and parsed fields under the
// backup service's hard 1 MiB single-row ceiling.
export const MAXIMUM_D2L_EMAIL_BYTES = 524_288;
const MINIMUM_CAPABILITY_CHARACTERS = 16;
// `school-` consumes seven of the SMTP local part's 64 characters.
const MAXIMUM_CAPABILITY_CHARACTERS = 57;
const MAXIMUM_HEADER_NAMES = 128;
const MAXIMUM_HEADER_NAME_CHARACTERS = 128;
const MAXIMUM_HEADER_NAMES_JSON_CHARACTERS = 16_000;
const MAXIMUM_AUTH_HEADER_CHARACTERS = 8_192;

export interface D2lEmailHandlerDependencies {
  readonly now?: () => Date;
  readonly sendOwnerText?: (text: string) => Promise<void>;
  readonly logHeaderNames?: (emailId: string, names: readonly string[]) => void;
}

export interface D2lEmailHandlerResult {
  /**
   * `outside_d2l_scope`: the delivery was not addressed to the D2L ingest
   * address or its visible From is not a pinned D2L domain, so it is not a
   * D2L notification at all. Nothing is written to the D2L tables and no D2L
   * failure is counted; the general inbox holds the message.
   */
  readonly outcome: "ingested" | "quarantined" | "duplicate" | "outside_d2l_scope";
  readonly eventKind: D2lEmailMessageReceipt["eventKind"];
  readonly quarantineReason: string | null;
  readonly deadlineOutcome: "created" | "revised" | "unchanged" | null;
  readonly gradeCreated: boolean;
  /** Which routing fact put the delivery outside the D2L consumer's scope. */
  readonly outsideScopeReason?: OutsideD2lScopeReason;
}

/**
 * The routing facts the D2L consumer already measured before this inbox
 * existed: the envelope recipient against the configured ingest address, and
 * the visible From domain against the configured D2L sender pin. They say only
 * whether a delivery is addressed to this consumer; they say nothing about
 * what the email means.
 */
export type OutsideD2lScopeReason = "recipient_mismatch" | "from_missing" | "from_domain_unpinned";

interface D2lEmailConfiguration {
  readonly principalId: string;
  readonly ingestAddress: string;
  readonly d2lDomains: ReadonlySet<string>;
  /** Forwarder tenants whose ARC seal can be believed; empty disables ARC. */
  readonly arcSealerDomains: ReadonlySet<string>;
  readonly timeZone: string;
}

interface RawMessage {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

interface AuthenticationRecord extends Readonly<Record<string, unknown>> {
  readonly state: "unknown" | "observed" | "hard_fail";
  readonly headerValues: Readonly<Record<string, readonly string[]>>;
  readonly dkimDomains: readonly string[];
  readonly hardFailures: readonly string[];
}

/** What is written to the receipt: the measurement plus why it was believed. */
interface StoredAuthenticationRecord extends AuthenticationRecord {
  readonly authenticity: AuthenticityEvidence;
}

function configuredDomain(value: string): string | null {
  const domain = value.trim().toLowerCase();
  if (
    domain.length < 1
    || domain.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(domain)
    || domain.includes("..")
    || !domain.includes(".")
  ) return null;
  return domain;
}

function domainSet(value: string): ReadonlySet<string> {
  const domains = value.split(",").map(configuredDomain);
  if (domains.length === 0 || domains.some((domain) => domain === null)) {
    throw new Error("school_email_configuration_invalid");
  }
  return new Set(domains as string[]);
}

/**
 * The ARC sealer pin is optional configuration: without it the ARC path is
 * simply unavailable and a message that needs it quarantines rather than
 * being trusted on a chain nobody pinned.
 */
function optionalDomainSet(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim().length === 0) return new Set();
  return domainSet(value);
}

function configuration(env: Pick<
  Env,
  "OWNER_PRINCIPAL_ID" | "SCHOOL_EMAIL_INGEST_ADDRESS" | "D2L_EMAIL_FROM_DOMAINS"
  | "D2L_EMAIL_ARC_SEALER_DOMAINS" | "DIGEST_TIMEZONE"
>): D2lEmailConfiguration {
  const address = env.SCHOOL_EMAIL_INGEST_ADDRESS?.trim().toLowerCase();
  if (
    address === undefined
    || !new RegExp(`^school-[a-z0-9][a-z0-9-]{${MINIMUM_CAPABILITY_CHARACTERS - 1},${MAXIMUM_CAPABILITY_CHARACTERS - 1}}@onesid\\.ca$`, "u").test(address)
  ) throw new Error("school_email_configuration_invalid");
  const principalId = env.OWNER_PRINCIPAL_ID?.trim();
  if (principalId === undefined || principalId.length === 0) throw new Error("school_email_configuration_invalid");
  const timeZone = env.DIGEST_TIMEZONE?.trim() || "America/Toronto";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(0);
  } catch {
    throw new Error("school_email_configuration_invalid");
  }
  return Object.freeze({
    principalId,
    ingestAddress: address,
    // Required: the sender-domain pin is the routing filter every message is
    // measured against, and it authorises nothing on its own.
    d2lDomains: domainSet(env.D2L_EMAIL_FROM_DOMAINS ?? ""),
    arcSealerDomains: optionalDomainSet(env.D2L_EMAIL_ARC_SEALER_DOMAINS),
    timeZone,
  });
}

function addressDomain(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1 || trimmed.indexOf("@") !== separator) return null;
  return configuredDomain(trimmed.slice(separator + 1));
}

function fromDomain(email: Email | null): string | null {
  const from = email?.from;
  if (from === undefined || !("address" in from)) return null;
  return addressDomain(from.address);
}

/**
 * The visible From domain when the message body was not parsed.
 *
 * An oversized or unparseable message still has its header block in the
 * runtime `Headers`, so its routing fact is read from there rather than being
 * treated as unknown. Without this an ordinary large email (a PDF attachment
 * is enough) would count as a D2L failure.
 */
function runtimeFromDomain(runtime: Headers): string | null {
  const value = runtime.get("from");
  if (value === null) return null;
  let parsed: ReturnType<typeof addressParser>;
  try {
    parsed = addressParser(value);
  } catch {
    return null;
  }
  const first = parsed[0];
  return first === undefined || !("address" in first) ? null : addressDomain(first.address);
}

async function readRaw(message: ForwardableEmailMessage): Promise<RawMessage> {
  const reader = message.raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = message.rawSize > MAXIMUM_D2L_EMAIL_BYTES;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAXIMUM_D2L_EMAIL_BYTES - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel("message_too_large");
        break;
      }
      const chunk = next.value.byteLength <= remaining ? next.value : next.value.slice(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength !== next.value.byteLength) {
        truncated = true;
        await reader.cancel("message_too_large");
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ bytes, truncated });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

function headerNames(email: Email | null, runtime: Headers): readonly string[] {
  const names = email?.headers.map((header) => header.originalKey) ?? [];
  const seen = new Set(names.map((name) => name.toLowerCase()));
  for (const name of runtime.keys()) {
    if (!seen.has(name.toLowerCase())) names.push(name);
  }
  const bounded: string[] = [];
  for (const name of names) {
    if (bounded.length >= MAXIMUM_HEADER_NAMES) break;
    const sliced = name.normalize("NFC").slice(0, MAXIMUM_HEADER_NAME_CHARACTERS);
    const candidate = sliced.isWellFormed() ? sliced : sliced.slice(0, -1);
    const next = [...bounded, candidate];
    if (JSON.stringify(next).length > MAXIMUM_HEADER_NAMES_JSON_CHARACTERS) break;
    bounded.push(candidate);
  }
  return Object.freeze(bounded);
}

function boundedHeaderValue(value: string): string {
  const normalized = value.normalize("NFC");
  const sliced = normalized.slice(0, MAXIMUM_AUTH_HEADER_CHARACTERS);
  return sliced.isWellFormed() ? sliced : sliced.slice(0, -1);
}

function authenticationRecord(runtime: Headers): AuthenticationRecord {
  const accepted = new Set([
    "authentication-results", "arc-authentication-results", "arc-seal",
    "arc-message-signature", "dkim-signature", "received-spf",
  ]);
  const values = new Map<string, string[]>();
  for (const [name, value] of runtime.entries()) {
    const key = name.toLowerCase();
    if (!accepted.has(key)) continue;
    const existing = values.get(key) ?? [];
    if (existing.length < 16) existing.push(boundedHeaderValue(value));
    values.set(key, existing);
  }
  const hardFailures = new Set<string>();
  for (const key of ["authentication-results", "arc-authentication-results"] as const) {
    for (const value of values.get(key) ?? []) {
      for (const match of value.matchAll(/\b(dkim|dmarc)\s*=\s*(fail|permerror|temperror)\b/giu)) {
        hardFailures.add(`${match[1]!.toLowerCase()}_${match[2]!.toLowerCase()}`);
      }
    }
  }
  for (const value of values.get("arc-seal") ?? []) {
    if (/\bcv\s*=\s*fail\b/iu.test(value)) hardFailures.add("arc_fail");
  }
  const dkimDomains = new Set<string>();
  for (const value of values.get("dkim-signature") ?? []) {
    for (const match of value.matchAll(/(?:^|;)\s*d\s*=\s*([^;\s]+)/giu)) {
      const domain = configuredDomain(match[1] ?? "");
      if (domain !== null) dkimDomains.add(domain);
    }
  }
  const headerValues = Object.freeze(Object.fromEntries(
    [...values.entries()].map(([key, entries]) => [key, Object.freeze(entries)]),
  ));
  const state = hardFailures.size > 0 ? "hard_fail" : values.size > 0 ? "observed" : "unknown";
  return Object.freeze({
    state,
    headerValues,
    dkimDomains: Object.freeze([...dkimDomains].sort()),
    hardFailures: Object.freeze([...hardFailures].sort()),
  });
}

function providerMessageId(email: Email | null, runtime: Headers): string | null {
  const raw = email?.messageId ?? runtime.get("message-id");
  if (raw === null || raw === undefined) return null;
  const normalized = raw.normalize("NFC").trim().slice(0, 998);
  return normalized.length === 0 || !normalized.isWellFormed() ? null : normalized;
}

async function ingestionKey(messageId: string | null, hash: string): Promise<string> {
  return messageId === null
    ? `sha256:${hash}`
    : `message-id-sha256:${await sha256Hex(messageId.toLowerCase())}`;
}

function structured(event: ParsedD2lEmailEvent, rawTruncated: boolean): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...event, rawTruncated });
}

function verificationText(event: Extract<ParsedD2lEmailEvent, { kind: "address_verification" }>): string {
  const values = [
    event.verificationUrl === null ? null : `Link: ${event.verificationUrl}`,
    event.verificationCode === null ? null : `Code: ${event.verificationCode}`,
  ].filter((value): value is string => value !== null);
  return `D2L email address verification is waiting. Jarvis did not open the link.\n\n${values.join("\n")}`;
}

const REPEATED_FAILURE_NOTICE = "D2L notification email has repeatedly failed authenticity checks. The messages are quarantined, and no deadline, grade, or memory was created. Check Email Routing and the configured sender-domain pins.";
// A parse failure is a statement about the templates Jarvis knows, not about
// Sid's mail configuration: telling him to check DNS while a real assignment
// quietly never appears is the failure this notice exists to avoid.
const CONTENT_FAILURE_NOTICE = "D2L notification email has repeatedly arrived in a form Jarvis could not read, so no deadline or grade was created. Nothing in Email Routing or the sender pins needs checking; the message format may have changed.";
const REFUSED_VERIFICATION_NOTICE = "A D2L email-address verification message was refused because it could not be proven to come from D2L. Jarvis did not open it and has no link to pass on. If you expected a verification mail, set the address in D2L itself.";

/**
 * Reasons that mean Sid's own mail configuration may be wrong.
 *
 * `from_missing`, `from_domain_unpinned` and `recipient_mismatch` are no longer
 * produced for new deliveries (they return `outside_d2l_scope`), but receipts
 * written before that change still carry them and a redelivery of one reaches
 * `sendPendingFailureNotice` through the duplicate path.
 */
const AUTHENTICITY_REASONS = new Set([
  "authentication_failed", "authentication_unproven", "from_missing", "from_domain_unpinned",
]);
/** Reasons that describe the delivery itself, not anything Sid controls. */
const DELIVERY_REASONS = new Set(["recipient_mismatch", "message_too_large", "mime_parse_failed"]);

function failureNoticeText(receipt: D2lEmailMessageReceipt): string | null {
  if (receipt.eventKind === "address_verification") return REFUSED_VERIFICATION_NOTICE;
  if (receipt.quarantineReason === null || AUTHENTICITY_REASONS.has(receipt.quarantineReason)) {
    return REPEATED_FAILURE_NOTICE;
  }
  return DELIVERY_REASONS.has(receipt.quarantineReason) ? null : CONTENT_FAILURE_NOTICE;
}

function eventFromReceipt(receipt: D2lEmailMessageReceipt): ParsedD2lEmailEvent {
  return receipt.structured as unknown as ParsedD2lEmailEvent;
}

async function sendPendingFailureNotice(
  repository: D2lEmailRepository,
  receipt: D2lEmailMessageReceipt,
  send: ((text: string) => Promise<void>) | undefined,
  now: Date,
): Promise<void> {
  if (receipt.status !== "quarantined") return;
  if (!await repository.hasPendingFailureNotice(receipt.principalId)) return;
  const text = failureNoticeText(receipt);
  // A refusal of the delivery itself is not Sid's setup to fix, and spending
  // the claim on it would silence the notice a real failure streak earns.
  if (text === null) return;
  // A quarantined receipt must stay final even if this optional adapter was
  // omitted. Production supplies the sender; a delivery error still throws
  // and leaves the durable claim pending for the next message to retry.
  if (send === undefined) return;
  await send(text);
  await repository.markFailureNoticeSent(receipt.principalId, now);
}

async function sendPendingVerification(
  repository: D2lEmailRepository,
  receipt: D2lEmailMessageReceipt,
  send: ((text: string) => Promise<void>) | undefined,
  now: Date,
): Promise<void> {
  if (
    receipt.eventKind !== "address_verification"
    || receipt.status !== "ingested"
    || receipt.verificationNotifiedAt !== null
  ) return;
  const event = eventFromReceipt(receipt);
  if (event.kind !== "address_verification") throw new Error("d2l_email_verification_receipt_invalid");
  if (send === undefined) throw new Error("school_email_owner_notice_unavailable");
  await send(verificationText(event));
  await repository.markVerificationNotified(receipt.principalId, receipt.emailId, now);
}

/**
 * Process the Email Routing delivery without granting body text any command path.
 *
 * Trust comes from positive authentication evidence and nothing else: a DKIM
 * signature naming a pinned domain, the receiving MTA's own `dkim=pass` for a
 * pinned signer, or a pinned ARC chain whose original authentication passed.
 * The configured capability recipient and the `From:` domain pin only route
 * and filter -- anyone on the internet can set a `From:` header, so neither
 * one authorises a write. Missing evidence is quarantine, never trust.
 */
export async function handleD2lNotificationEmail(
  message: ForwardableEmailMessage,
  env: Env,
  dependencies: D2lEmailHandlerDependencies = {},
): Promise<D2lEmailHandlerResult> {
  let config: D2lEmailConfiguration;
  try {
    config = configuration(env);
  } catch (error) {
    message.setReject("School email ingestion is not configured");
    throw error;
  }
  const now = new Date((dependencies.now ?? (() => new Date()))().getTime());
  const deadlines = new DeadlineRepository(env.DB);
  await deadlines.ensureSource({
    sourceId: D2L_EMAIL_SOURCE_ID,
    kind: "brightspace",
    label: "D2L notification email",
    now,
  });
  const raw = await readRaw(message);
  const rawHash = await sha256Hex(raw.bytes);
  let email: Email | null = null;
  let parseFailed = false;
  if (!raw.truncated) {
    try {
      email = await PostalMime.parse(raw.bytes, {
        rfc822Attachments: true,
        maxNestingDepth: 20,
        maxHeadersSize: 65_536,
        maxRfc822NestingDepth: 3,
      });
    } catch {
      parseFailed = true;
    }
  }
  // Scope first. A delivery that is not addressed to this consumer is not a
  // D2L notification, so it must not be counted as a D2L failure: that would
  // mark the D2L source as failing in the digest and, after three, send Sid a
  // "check Email Routing and the sender pins" notice for ordinary mail. The
  // inbox has already stored the message, so returning here loses nothing.
  // These are the same two routing facts this handler has always measured;
  // no new sender, domain or content rule is added.
  const scopeFromDomain = email === null ? runtimeFromDomain(message.headers) : fromDomain(email);
  let outsideScopeReason: OutsideD2lScopeReason | null = null;
  if (message.to.trim().toLowerCase() !== config.ingestAddress) outsideScopeReason = "recipient_mismatch";
  else if (scopeFromDomain === null) outsideScopeReason = "from_missing";
  else if (!config.d2lDomains.has(scopeFromDomain)) outsideScopeReason = "from_domain_unpinned";
  if (outsideScopeReason !== null) {
    return Object.freeze({
      outcome: "outside_d2l_scope" as const,
      // The D2L template parser never ran on it, so no D2L event was recognised.
      eventKind: "unrecognised" as const,
      quarantineReason: null,
      deadlineOutcome: null,
      gradeCreated: false,
      outsideScopeReason,
    });
  }

  const names = headerNames(email, message.headers);
  const authentication = authenticationRecord(message.headers);
  const parsed = email === null
    ? Object.freeze({ kind: "unrecognised" as const, reason: raw.truncated ? "message_too_large" : "mime_parse_failed" })
    : await parseD2lEmail({
      subject: email.subject,
      text: email.text,
      html: email.html,
      timeZone: config.timeZone,
      pinnedLinkDomains: [...config.d2lDomains],
    });
  const parsedFromDomain = fromDomain(email);
  const envelopeFromDomain = addressDomain(message.from);
  const messageId = providerMessageId(email, message.headers);
  const evidence = assessAuthenticity({
    headerValues: authentication.headerValues,
    pinnedDomains: config.d2lDomains,
    arcSealerDomains: config.arcSealerDomains,
  });
  let quarantineReason: string | null = null;
  if (raw.truncated) quarantineReason = "message_too_large";
  else if (parseFailed) quarantineReason = "mime_parse_failed";
  else if (authentication.state === "hard_fail") quarantineReason = "authentication_failed";
  else if (!evidence.trusted) quarantineReason = "authentication_unproven";
  // An authentic verification message is only refused when it has nothing
  // relayable: a link somewhere other than a pinned D2L host, or neither a
  // link nor a code. Either way Sid hears about it through a fixed notice
  // that carries no content borrowed from the message.
  else if (parsed.kind === "address_verification" && parsed.linkWithheld) quarantineReason = "verification_link_unpinned";
  else if (parsed.kind === "address_verification" && parsed.verificationUrl === null && parsed.verificationCode === null) {
    quarantineReason = "verification_value_missing";
  }
  else if (parsed.kind === "unrecognised") quarantineReason = parsed.reason;

  const storedAuthentication: StoredAuthenticationRecord = Object.freeze({
    ...authentication,
    authenticity: evidence,
  });
  const repository = new D2lEmailRepository(env.DB);
  const begun = await repository.begin({
    principalId: config.principalId,
    ingestionKey: await ingestionKey(messageId, rawHash),
    rawSha256: rawHash,
    providerMessageId: messageId,
    headerNames: names,
    authentication: storedAuthentication,
    envelopeFromDomain,
    fromDomain: parsedFromDomain,
    eventKind: parsed.kind,
    structured: structured(parsed, raw.truncated),
    rawMimeBase64: base64(raw.bytes),
    now,
  });
  (dependencies.logHeaderNames ?? ((emailId, headerNamesValue) => {
    console.log("d2l_email_header_names", { emailId, headerNames: headerNamesValue });
  }))(begun.receipt.emailId, names);

  if (!begun.created && begun.receipt.status !== "pending") {
    await sendPendingVerification(repository, begun.receipt, dependencies.sendOwnerText, now);
    await sendPendingFailureNotice(repository, begun.receipt, dependencies.sendOwnerText, now);
    return Object.freeze({
      outcome: "duplicate" as const,
      eventKind: begun.receipt.eventKind,
      quarantineReason: begun.receipt.quarantineReason,
      deadlineOutcome: null,
      gradeCreated: false,
    });
  }

  if (quarantineReason !== null) {
    const quarantined = await repository.complete(
      config.principalId,
      begun.receipt.emailId,
      { status: "quarantined", reason: quarantineReason },
      now,
    );
    // Pruned here, in the same request as the write that grew the table, so a
    // stranger flooding the address cannot outrun the cap. This only bounds the
    // legacy D2L table: the authoritative copy of every delivery is in
    // `email_inbox` and ARCHIVE, so a pruned receipt is a duplicate removed, not
    // mail lost.
    await repository.pruneQuarantined(config.principalId, quarantined.emailId, now);
    await deadlines.recordSourceFailure(D2L_EMAIL_SOURCE_ID, quarantineReason, now);
    await repository.recordFailure(
      config.principalId,
      quarantined.emailId,
      now,
      quarantined.eventKind === "address_verification",
    );
    await sendPendingFailureNotice(repository, quarantined, dependencies.sendOwnerText, now);
    return Object.freeze({
      outcome: "quarantined" as const,
      eventKind: quarantined.eventKind,
      quarantineReason,
      deadlineOutcome: null,
      gradeCreated: false,
    });
  }

  let deadlineOutcome: D2lEmailHandlerResult["deadlineOutcome"] = null;
  let gradeCreated = false;
  if (parsed.kind === "assignment_due" || parsed.kind === "assignment_updated") {
    const report = await new DeadlineIngestion({ repository: deadlines, now: () => new Date(now.getTime()) })
      .ingest(D2L_EMAIL_SOURCE_ID, { kind: "items", items: [{
        externalId: parsed.externalId,
        course: parsed.course,
        title: parsed.title,
        dueAt: parsed.dueAt,
      }] });
    deadlineOutcome = report.created.length > 0 ? "created" : report.moved.length > 0 ? "revised" : "unchanged";
  } else if (parsed.kind === "grade_released") {
    const deadline = await deadlines.readByExternalId(D2L_EMAIL_SOURCE_ID, parsed.externalId);
    gradeCreated = await new SchoolObservationRepository(env.DB).ingestD2lEmailGrade({
      principalId: config.principalId,
      emailId: begun.receipt.emailId,
      deadlineId: deadline?.deadlineId ?? null,
      externalId: parsed.externalId,
      course: parsed.course,
      title: parsed.title,
      assignedGrade: parsed.assignedGrade,
      maxPoints: parsed.maxPoints,
      now,
    });
    await deadlines.recordSourceSuccess(D2L_EMAIL_SOURCE_ID, now);
  } else if (parsed.kind !== "address_verification") {
    await deadlines.recordSourceSuccess(D2L_EMAIL_SOURCE_ID, now);
  }

  let completed = await repository.complete(config.principalId, begun.receipt.emailId, { status: "ingested" }, now);
  await repository.recordSuccess(config.principalId, now);
  await sendPendingVerification(repository, completed, dependencies.sendOwnerText, now);
  completed = await repository.read(config.principalId, completed.emailId) ?? completed;
  return Object.freeze({
    outcome: "ingested" as const,
    eventKind: completed.eventKind,
    quarantineReason: null,
    deadlineOutcome,
    gradeCreated,
  });
}
