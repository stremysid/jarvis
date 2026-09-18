import PostalMime, { type Email } from "postal-mime";
import { sha256Hex } from "../../../../packages/contracts/src/index.js";
import { DeadlineIngestion } from "../deadlines/deadline-ingestion.js";
import { DeadlineRepository } from "../deadlines/deadline-repository.js";
import type { Env } from "../env.js";
import {
  assessAuthenticity,
  type AuthenticityEvidence,
} from "./d2l-email-authenticity.js";
import { D2lEmailRepository, type EmailAuthenticity, type D2lEmailMessageReceipt } from "./d2l-email-repository.js";
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
  readonly outcome: "ingested" | "quarantined" | "duplicate";
  readonly eventKind: D2lEmailMessageReceipt["eventKind"];
  readonly quarantineReason: string | null;
  /** What the caller may claim about this message's provenance. */
  readonly authenticity: EmailAuthenticity;
  readonly deadlineOutcome: "created" | "revised" | "unchanged" | null;
  readonly gradeCreated: boolean;
}
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

const REPEATED_FAILURE_NOTICE = "D2L notification email has repeatedly failed authenticity checks. The messages are stored unverified, and no deadline or grade was created. Check Email Routing and the configured sender-domain pins.";
// A parse failure is a statement about the templates Jarvis knows, not about
// Sid's mail configuration: telling him to check DNS while a real assignment
// quietly never appears is the failure this notice exists to avoid.
const CONTENT_FAILURE_NOTICE = "D2L notification email has repeatedly arrived in a form Jarvis could not read, so no deadline or grade was created. Nothing in Email Routing or the sender pins needs checking; the message format may have changed.";
const REFUSED_VERIFICATION_NOTICE = "A D2L email-address verification message was refused because it could not be proven to come from D2L. Jarvis did not open it and has no link to pass on. If you expected a verification mail, set the address in D2L itself.";
/**
 * Sent once when unproven mail starts arriving in a run.
 *
 * This is not an authentication failure notice and deliberately does not
 * borrow its wording. A sender nobody pinned is now the expected shape of
 * Sid's whole school inbox, so saying "check your DNS" about it would be
 * advice about a fault that is not there. What he needs to know is the one
 * consequence that is not visible from the message itself: nothing was
 * created from it.
 */
const UNVERIFIED_MAIL_NOTICE = "School mail is arriving from senders that are not pinned, or without authentication evidence Jarvis can check. The messages are read and stored, marked unverified, and no deadline or grade is created from them.";

/** Reasons that mean Sid's own mail configuration may be wrong. */
const AUTHENTICITY_REASONS = new Set([
  "authentication_failed", "authentication_unproven", "from_missing", "from_domain_unpinned",
]);
/** Reasons that describe the delivery itself, not anything Sid controls. */
const DELIVERY_REASONS = new Set(["recipient_mismatch", "message_too_large", "mime_parse_failed"]);

/**
 * Parser reasons that mean a body reached for a template and failed.
 *
 * Everything the parser reports is one of these except `ordinary_mail`, which
 * is a message that never claimed to be a notification. The distinction
 * matters because the whole school inbox now routes here: without it, every
 * forwarded note would be reported to Sid as a D2L template that changed.
 */
const TEMPLATE_FAILURE_REASONS = new Set([
  "school_item_fields_missing", "grade_value_missing", "grade_value_invalid",
  "due_date_missing", "due_date_invalid", "template_unknown",
]);

function failureNoticeText(receipt: D2lEmailMessageReceipt): string | null {
  if (receipt.eventKind === "address_verification") return REFUSED_VERIFICATION_NOTICE;
  if (receipt.quarantineReason === null || AUTHENTICITY_REASONS.has(receipt.quarantineReason)) {
    // An unproven sender is the ordinary case once every message is routed
    // here, so it gets its own line rather than being called a failure of
    // Sid's setup.
    return receipt.quarantineReason === "authentication_unproven" || receipt.quarantineReason === "from_domain_unpinned"
      ? UNVERIFIED_MAIL_NOTICE
      : REPEATED_FAILURE_NOTICE;
  }
  return DELIVERY_REASONS.has(receipt.quarantineReason) ? null : CONTENT_FAILURE_NOTICE;
}

/**
 * Reasons whose raw bytes are not retained.
 *
 * One reason only, and it is not about the sender: `recipient_mismatch` is
 * mail that was not addressed to the ingest address at all. Whatever it is,
 * Jarvis was not the recipient, so retaining a copy would put a stranger's
 * correspondence in the database that holds Sid's deadlines and memory. The
 * hash, the header names and the reason stay; the bytes do not.
 *
 * `from_missing` and `from_domain_unpinned` were on this list and are not any
 * more. Both describe the sender, and the owner's decision is that mail from
 * any sender is read: discarding a Google Classroom notification because
 * nobody pinned its domain is the behaviour this change removes. Their
 * verdicts now set the authenticity label instead.
 */
const RAW_WITHHELD_REASONS = new Set(["recipient_mismatch"]);

function retainsRawMime(reason: string | null): boolean {
  return reason === null || !RAW_WITHHELD_REASONS.has(reason);
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
 * one authorises a write.
 *
 * Every message is read, stored and labelled; the authenticity verdict decides
 * what may be *derived*, not whether the body survives. `verified` mail may
 * create a deadline or a grade and those records say so. Anything else is
 * retained as an unverified receipt and creates nothing. `recipient_mismatch`
 * is the one exception, and it is not a trust judgement: mail addressed to
 * somebody else was never delivered to Jarvis at all.
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
  // The label is the whole of what the authentication verdict now decides.
  // `assessAuthenticity` is unchanged; its answer just stops gating the body.
  const authenticity: EmailAuthenticity = evidence.trusted ? "verified" : "unverified";
  let quarantineReason: string | null = null;
  if (message.to.trim().toLowerCase() !== config.ingestAddress) quarantineReason = "recipient_mismatch";
  else if (raw.truncated) quarantineReason = "message_too_large";
  else if (parseFailed) quarantineReason = "mime_parse_failed";
  else if (authentication.state === "hard_fail") quarantineReason = "authentication_failed";
  // Below this line nothing is refused for being unproven. An unpinned or
  // absent `From:` domain, and a message with no positive evidence at all, are
  // read and stored as unverified receipts: no deadline or grade is derived
  // from them, and their authenticity is recorded rather than assumed.
  else if (parsed.kind === "address_verification" && parsed.linkWithheld) quarantineReason = "verification_link_unpinned";
  else if (parsed.kind === "address_verification" && parsed.verificationUrl === null && parsed.verificationCode === null) {
    quarantineReason = "verification_value_missing";
  }
  // The authenticity verdict comes before the parser's own reason: an
  // unproven sender is the ordinary case once the whole inbox routes here, and
  // a "the template changed" notice about a message Jarvis never had reason to
  // read as a template would be wrong. A proven message that reached for a
  // template and failed keeps its own reason and is reported as the fault it is.
  else if (authenticity === "unverified") quarantineReason = "authentication_unproven";
  else if (parsed.kind === "unrecognised" && TEMPLATE_FAILURE_REASONS.has(parsed.reason)) quarantineReason = parsed.reason;
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
    authenticity,
    eventKind: parsed.kind,
    structured: structured(parsed, raw.truncated),
    rawMimeBase64: retainsRawMime(quarantineReason) ? base64(raw.bytes) : "",
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
      authenticity: begun.receipt.authenticity,
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
    // Pruned here, in the same request as the write that grew the table: a
    // flood cannot outrun a bound that is enforced by the write itself.
    await repository.pruneRetainedRaw(config.principalId, quarantined.emailId, now);
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
      authenticity: quarantined.authenticity,
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
      authenticity,
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
    authenticity: completed.authenticity,
    deadlineOutcome,
    gradeCreated,
  });
}
