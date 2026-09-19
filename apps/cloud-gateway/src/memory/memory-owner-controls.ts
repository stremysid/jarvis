import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  validateEnvelope,
  type JsonValue,
  type RedactedJsonValue,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { encodeDecisionCallbackData } from "../decisions/telegram-keyboard.js";
import { Redactor } from "../security/redaction.js";
import {
  EventRepository,
  IdempotencyConflict,
  type AppendedEvent,
} from "../persistence/event-repository.js";
import { ArchivalService, type ArchiveBucket } from "../archive/archival-service.js";
import { MemoryRepository } from "./memory-repository.js";
import {
  MemoryRepositoryError,
  MEMORY_CONTROL_INTENTS,
  type CanonicalMemoryItem,
  type CommitInitialMemoryInput,
  type ConfirmMemoryItemInput,
  type ForgetMemoryItemInput,
  type LiftMemoryItemInput,
  type MemoryControlIntent,
  type MemoryKind,
  type MemoryLifetime,
  type MemoryOwnerTurnInput,
  type MemorySensitivity,
} from "./memory-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MEMORY_CONTROL_POLICY_VERSION = "memory-owner-control-v1";
const MEMORY_CONTROL_SOURCE = "memory-control";
const MEMORY_CONTROL_EVENT_TYPE = "memory.owner_command";
const MEMORY_CONTROL_PRODUCER = "memory-control-v1";
const MEMORY_KINDS = new Set<MemoryKind>(["fact", "preference", "plan", "decision", "relationship"]);
const MEMORY_SENSITIVITIES = new Set<MemorySensitivity>(["normal", "sensitive"]);
const REMEMBER_CONTROL_PREFIXES = [
  /^(?:please[ \t]+)?remember(?:[ \t]*,[ \t]*|[ \t]+)that:[ \t]*/iu,
  /^(?:please[ \t]+)?remember(?:[ \t]*,[ \t]*|[ \t]+)that[ \t]+/iu,
  /^(?:please[ \t]+)?remember:[ \t]*/iu,
  /^(?:please[ \t]+)?remember(?:[ \t]*,[ \t]*|[ \t]+)/iu,
] as const;
const APOSTROPHE_LOOKALIKES = /[\u02bc\u2018\u2019\u2032\uff07`]/gu;
const ZERO_WIDTH_CHARACTERS = /[\u200b-\u200d\u2060\ufeff]/gu;

export interface RememberMemoryInput {
  readonly ownerTurn: MemoryOwnerTurnInput;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly sensitivity: MemorySensitivity;
  readonly sourceExcerpt?: string;
  readonly basis?: "stated" | "confirmed" | "inferred";
  readonly normalizedFromSource?: boolean;
  /**
   * Whether this stops being true on its own, and when.
   *
   * Optional so every existing caller keeps its behaviour -- absent means
   * durable, which is what the store did before the column existed. The two are
   * validated as a pair: durable with an end, or temporary without one, is
   * refused rather than stored and then rejected by the coupling trigger.
   */
  readonly lifetime?: MemoryLifetime;
  readonly validTo?: string | null;
}

export interface ConfirmedForgetDecisionInput {
  readonly principalId: string;
  readonly callbackEventId: Ulid;
  readonly decisionId: Ulid;
  readonly itemIds: readonly Ulid[];
}

export interface ConfirmedMemoryDecisionInput {
  readonly principalId: string;
  readonly callbackEventId: Ulid;
  readonly decisionId: Ulid;
  readonly itemId: Ulid;
  readonly previousVersionId: Ulid;
}

export interface TargetedMemoryControlInput {
  readonly ownerTurn: MemoryOwnerTurnInput;
  readonly candidateItemIds: readonly Ulid[];
}

export interface MemoryMutationReceipt {
  readonly item: CanonicalMemoryItem | MemoryTextSuppressedItem;
  readonly receipt: string;
  readonly replayed: boolean;
}

export interface MemoryForgetReceipt {
  readonly itemId: Ulid;
  readonly state: "forgotten";
  readonly newlyHiddenTurnCount: number;
  readonly totalCoveredTurnCount: number;
  readonly hiddenSiblingItemCount: number;
  readonly receipt: string;
  readonly replayed: boolean;
}

export interface MemoryLiftReceipt {
  readonly item: CanonicalMemoryItem | MemoryTextSuppressedItem;
  readonly liftedSuppressionCount: number;
  readonly retrievable: boolean;
  readonly receipt: string;
  readonly replayed: boolean;
}

export interface ConfirmMemoryInput extends TargetedMemoryControlInput {
  readonly sourceExcerpt: string;
}

export interface CorrectMemoryInput extends TargetedMemoryControlInput {
  readonly text: string;
  readonly kind: MemoryKind;
  readonly sensitivity: MemorySensitivity;
  readonly sourceExcerpt?: string;
  /** True only when the caller proved the new wording is drawn from Sid's own words. */
  readonly normalizedFromSource?: boolean;
}

export interface MemoryCorrectionReceipt {
  readonly item: CanonicalMemoryItem | MemoryTextSuppressedItem;
  readonly supersededItemId: Ulid;
  /** Null when an active suppression hides the earlier wording from this reply. */
  readonly supersededText: string | null;
  readonly receipt: string;
  readonly replayed: boolean;
}

export interface MemoryConfirmReceipt {
  readonly item: CanonicalMemoryItem;
  readonly receipt: string;
  readonly replayed: boolean;
}

export interface MemoryExplanation {
  readonly itemId: Ulid;
  readonly state: CanonicalMemoryItem["lifecycle"]["state"];
  readonly uncertain: boolean;
  readonly topicPath: readonly string[];
  readonly text: string | null;
  readonly sources: readonly Readonly<{
    eventId: Ulid;
    occurredAt: string;
    channel: CanonicalMemoryItem["sources"][number]["channel"];
    excerpt: string | null;
  }>[];
  readonly receipt: string;
}

export interface MemoryOwnerControlsOptions {
  readonly clock?: () => Date;
  readonly idFactory?: (now: Date) => Ulid;
}

interface StoredControlReceipt {
  readonly request_hash: unknown;
}

type MemoryTextSuppressedItem = Omit<CanonicalMemoryItem, "version" | "sources" | "topicPath"> & Readonly<{
  version: Omit<CanonicalMemoryItem["version"], "text" | "textHash">
    & Readonly<{ text: null; textHash: null }>;
  sources: readonly (Omit<CanonicalMemoryItem["sources"][number], "excerpt" | "excerptHash">
    & Readonly<{ excerpt: null; excerptHash: null }>)[];
  topicPath: CanonicalMemoryItem["topicPath"];
}>;

type JsonRecord = Readonly<Record<string, JsonValue>>;
type DecodedForgetCommand = Omit<ForgetMemoryItemInput, "principalId" | "ownerAuthorizingEventId">;
type DecodedLiftCommand = Omit<LiftMemoryItemInput, "principalId" | "ownerAuthorizingEventId">;
const redactor = new Redactor();

function refuse(): never {
  throw new MemoryRepositoryError("memory_refused");
}

function corrupt(): never {
  throw new MemoryRepositoryError("memory_corrupt");
}

function unavailable(): never {
  throw new MemoryRepositoryError("memory_unavailable");
}

function inputUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) refuse();
  return value as Ulid;
}

function isCanonicalTimestamp(value: string): boolean {
  if (!UTC_MILLISECONDS.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function captureOwnerTurn(value: MemoryOwnerTurnInput): MemoryOwnerTurnInput {
  const principalId = value.principalId;
  const eventId = inputUlid(value.eventId);
  const eventSequence = value.eventSequence;
  const occurredAt = value.occurredAt;
  const channel = value.channel;
  const memoryIntent = value.memoryIntent;
  const flags = [
    value.forwarded,
    value.quoted,
    value.pasted,
    value.hasAttachment,
    value.modelGenerated,
    value.toolGenerated,
    value.guest,
  ];
  if (typeof principalId !== "string" || principalId.length < 1 || principalId.length > 256
    || !principalId.isWellFormed()
    || !Number.isSafeInteger(eventSequence) || eventSequence < 1
    || typeof occurredAt !== "string" || !isCanonicalTimestamp(occurredAt)
    || channel !== "telegram" && channel !== "voice" && channel !== "system"
    || memoryIntent !== null && !MEMORY_CONTROL_INTENTS.has(memoryIntent)
    || flags.some((flag) => typeof flag !== "boolean")) refuse();
  return Object.freeze({
    principalId,
    eventId,
    eventSequence,
    occurredAt,
    channel,
    memoryIntent,
    forwarded: flags[0] as boolean,
    quoted: flags[1] as boolean,
    pasted: flags[2] as boolean,
    hasAttachment: flags[3] as boolean,
    modelGenerated: flags[4] as boolean,
    toolGenerated: flags[5] as boolean,
    guest: flags[6] as boolean,
  });
}

function record(value: JsonValue): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
  return value;
}

function exactKeys(value: JsonRecord, fields: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))) refuse();
}

function redactPayload(value: JsonValue, field?: string): RedactedJsonValue {
  if (typeof value === "string") {
    const result = field === undefined
      ? redactor.redactText(value)
      : redactor.redact({ text: value, channel: "telegram", field });
    if (!result.ok || result.text !== value) refuse();
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((child) => redactPayload(child, field));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, redactPayload(child, key)]),
  );
}

function exactSingleTarget(candidateItemIds: readonly Ulid[]): Ulid {
  if (!Array.isArray(candidateItemIds)) refuse();
  if (candidateItemIds.length === 0) throw new MemoryRepositoryError("memory_not_found");
  if (candidateItemIds.length !== 1) throw new MemoryRepositoryError("memory_ambiguous");
  return inputUlid(candidateItemIds[0]);
}

function commandKey(turn: MemoryOwnerTurnInput, operation: MemoryControlIntent): string {
  return `${turn.eventId}:${operation === "explain" ? operation : "mutation"}`;
}

function requireMemoryIntent(turn: MemoryOwnerTurnInput, operation: MemoryControlIntent): void {
  if (turn.memoryIntent !== operation) refuse();
}

function suppressMemoryText(item: CanonicalMemoryItem): MemoryTextSuppressedItem {
  return Object.freeze({
    ...item,
    version: Object.freeze({ ...item.version, text: null, textHash: null }),
    sources: Object.freeze(item.sources.map((source) => Object.freeze({
      ...source,
      excerpt: null,
      excerptHash: null,
    }))),
    topicPath: Object.freeze([]),
  });
}

function redactUnretrievableItem(
  item: CanonicalMemoryItem,
  visibility: Readonly<{ retrievable: boolean }>,
): CanonicalMemoryItem | MemoryTextSuppressedItem {
  return visibility.retrievable ? item : suppressMemoryText(item);
}

/**
 * Whether a reply may repeat an item's wording. Retrievability is the wrong
 * test here: retiring the earlier wording makes it unretrievable by design, and
 * that is not a reason to refuse to say what Sid just replaced.
 */
function suppressionHides(visibility: Readonly<{
  creationEventSuppressed: boolean;
  suppressedSourceIds: readonly Ulid[];
}>): boolean {
  return visibility.creationEventSuppressed || visibility.suppressedSourceIds.length > 0;
}

function decodeStoredCommand<T>(value: JsonValue, decode: (payload: JsonValue) => T): T {
  try {
    return decode(value);
  } catch (error) {
    if (error instanceof MemoryRepositoryError && error.code === "memory_refused") corrupt();
    throw error;
  }
}

function rememberRemainder(ownerText: string): string {
  const source = ownerText.trim();
  for (const prefix of REMEMBER_CONTROL_PREFIXES) {
    const match = prefix.exec(source);
    if (match !== null) return source.slice(match[0].length).trim();
  }
  return source;
}

function normalizeRememberComparison(value: string): string {
  return value
    .normalize("NFC")
    .replace(APOSTROPHE_LOOKALIKES, "'")
    .replace(ZERO_WIDTH_CHARACTERS, "")
    .toLocaleLowerCase("en-CA")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isAuthorizedRememberText(
  text: string,
  excerpt: string,
  ownerText: string,
  normalizedFromSource: boolean,
  modelInferred: boolean,
): boolean {
  return excerpt.length > 0
    && text === text.trim()
    && ownerText.includes(excerpt)
    && (modelInferred || normalizedFromSource
      || normalizeRememberComparison(text) === normalizeRememberComparison(excerpt));
}

type DecodedRememberPayload = Readonly<{
  transitionId: Ulid;
  itemId: Ulid;
  versionId: Ulid;
  sourceId: Ulid;
  placementId: Ulid;
  placementEventId: Ulid;
  topicId: Ulid;
  lifetime: MemoryLifetime;
  validTo: string | null;
}>;

function rememberPayload(value: JsonValue): DecodedRememberPayload {
  const payload = record(value);
  exactKeys(payload, [
    "operation", "targetId", "itemId", "versionId", "lifecycleState", "sourceId",
    "placementId", "placementEventId", "topicId", "lifetime", "validTo",
  ]);
  if (payload.operation !== "item.transition"
    || payload.lifecycleState !== "active" && payload.lifecycleState !== "proposed") refuse();
  const transitionId = inputUlid(payload.targetId);
  // Re-decoded on replay, so the coupling is checked here too: a stored command
  // that says durable while carrying an end would otherwise be replayed into an
  // item the trigger then refuses, and the failure would look like a data fault
  // rather than a bad command.
  const lifetime = payload.lifetime;
  if (lifetime !== "durable" && lifetime !== "temporary") refuse();
  const rawValidTo = payload.validTo;
  // Canonical RFC 3339, compared the way the rest of this ledger compares a
  // timestamp: round-tripping through Date is the check, so a value that parses
  // but does not round-trip is refused rather than stored in a shape the recall
  // filters would compare as text.
  if (rawValidTo !== null
    && (typeof rawValidTo !== "string" || new Date(rawValidTo).toISOString() !== rawValidTo)) refuse();
  const validTo = rawValidTo === null ? null : rawValidTo;
  if ((lifetime === "durable") !== (validTo === null)) refuse();
  return Object.freeze({
    transitionId,
    itemId: inputUlid(payload.itemId),
    versionId: inputUlid(payload.versionId),
    sourceId: inputUlid(payload.sourceId),
    placementId: inputUlid(payload.placementId),
    placementEventId: inputUlid(payload.placementEventId),
    topicId: inputUlid(payload.topicId),
    lifetime,
    validTo,
  });
}

function confirmPayload(value: JsonValue): Readonly<{
  transitionId: Ulid;
  itemId: Ulid;
  previousVersionId: Ulid;
  versionId: Ulid;
  sourceId: Ulid;
  copiedSourceIds: readonly Ulid[];
}> {
  const payload = record(value);
  exactKeys(payload, [
    "operation", "targetId", "itemId", "previousVersionId", "versionId",
    "lifecycleState", "sourceId", "copiedSourceIds",
  ]);
  if (payload.operation !== "item.transition" || payload.lifecycleState !== "active"
    || !Array.isArray(payload.copiedSourceIds)) refuse();
  return Object.freeze({
    transitionId: inputUlid(payload.targetId),
    itemId: inputUlid(payload.itemId),
    previousVersionId: inputUlid(payload.previousVersionId),
    versionId: inputUlid(payload.versionId),
    sourceId: inputUlid(payload.sourceId),
    copiedSourceIds: Object.freeze(payload.copiedSourceIds.map(inputUlid)),
  });
}

function confirmedDecisionPayload(value: JsonValue): ReturnType<typeof confirmPayload>
  & Readonly<{ confirmationExcerpt: string }> {
  const payload = record(value);
  exactKeys(payload, [
    "operation", "targetId", "itemId", "previousVersionId", "versionId",
    "lifecycleState", "sourceId", "copiedSourceIds", "confirmationExcerpt",
  ]);
  if (payload.operation !== "item.transition" || payload.lifecycleState !== "active"
    || !Array.isArray(payload.copiedSourceIds) || typeof payload.confirmationExcerpt !== "string") refuse();
  return Object.freeze({
    transitionId: inputUlid(payload.targetId),
    itemId: inputUlid(payload.itemId),
    previousVersionId: inputUlid(payload.previousVersionId),
    versionId: inputUlid(payload.versionId),
    sourceId: inputUlid(payload.sourceId),
    copiedSourceIds: Object.freeze(payload.copiedSourceIds.map(inputUlid)),
    confirmationExcerpt: payload.confirmationExcerpt,
  });
}

type DecodedSupersession = Readonly<{
  supersededItemId: Ulid;
  supersededVersionId: Ulid;
  supersedeTransitionId: Ulid;
  linkId: Ulid;
}>;

function supersessionPayload(value: JsonValue): DecodedSupersession {
  const payload = record(value);
  exactKeys(payload, ["operation", "targetId", "itemId", "versionId", "lifecycleState", "linkId"]);
  // The owner-command trigger binds this exact shape to the retirement
  // transition, so a payload that drifts from it can never authorize one.
  if (payload.operation !== "item.transition" || payload.lifecycleState !== "superseded") refuse();
  const supersededItemId = inputUlid(payload.itemId);
  const linkId = inputUlid(payload.linkId);
  const supersedeTransitionId = inputUlid(payload.targetId);
  if (new Set([supersededItemId, linkId, supersedeTransitionId]).size !== 3) refuse();
  return Object.freeze({
    supersededItemId,
    supersededVersionId: inputUlid(payload.versionId),
    supersedeTransitionId,
    linkId,
  });
}

function forgetPayload(value: JsonValue): DecodedForgetCommand {
  const payload = record(value);
  exactKeys(payload, [
    "operation", "targetId", "itemId", "versionId", "lifecycleState", "suppressions",
  ]);
  if (payload.operation !== "item.forget" || payload.lifecycleState !== "forgotten"
    || !Array.isArray(payload.suppressions)) refuse();
  const transitionId = inputUlid(payload.targetId);
  const suppressions = payload.suppressions.map((value) => {
    const entry = record(value);
    exactKeys(entry, [
      "suppressionId", "sourceId", "targetEventId", "startEventSequence", "endEventSequence",
      "newlyHiddenTurnCount", "totalCoveredTurnCount",
    ]);
    if (entry.startEventSequence !== null || entry.endEventSequence !== null
      || entry.newlyHiddenTurnCount !== 0 && entry.newlyHiddenTurnCount !== 1
      || entry.totalCoveredTurnCount !== 1) refuse();
    return Object.freeze({
      suppressionId: inputUlid(entry.suppressionId),
      sourceId: inputUlid(entry.sourceId),
      targetEventId: inputUlid(entry.targetEventId),
      newlyHiddenTurnCount: entry.newlyHiddenTurnCount,
      totalCoveredTurnCount: 1 as const,
    });
  });
  return Object.freeze({
    itemId: inputUlid(payload.itemId),
    versionId: inputUlid(payload.versionId),
    transitionId,
    suppressions: Object.freeze(suppressions),
    reason: "owner requested memory forget",
    policyVersion: MEMORY_CONTROL_POLICY_VERSION,
  });
}

function liftPayload(value: JsonValue): DecodedLiftCommand {
  const payload = record(value);
  exactKeys(payload, [
    "operation", "targetId", "itemId", "previousVersionId", "versionId", "lifecycleState",
    "sourceIds", "lifts",
  ]);
  if (payload.operation !== "item.correct"
    || payload.lifecycleState !== "active" && payload.lifecycleState !== "proposed"
    || !Array.isArray(payload.sourceIds) || !Array.isArray(payload.lifts)) refuse();
  const transitionId = inputUlid(payload.targetId);
  return Object.freeze({
    itemId: inputUlid(payload.itemId),
    previousVersionId: inputUlid(payload.previousVersionId),
    versionId: inputUlid(payload.versionId),
    transitionId,
    lifecycleState: payload.lifecycleState,
    sourceIds: Object.freeze(payload.sourceIds.map(inputUlid)),
    lifts: Object.freeze(payload.lifts.map((value) => {
      const entry = record(value);
      exactKeys(entry, ["liftId", "suppressionId"]);
      return Object.freeze({
        liftId: inputUlid(entry.liftId),
        suppressionId: inputUlid(entry.suppressionId),
      });
    })),
    reason: "owner requested memory restore",
    policyVersion: MEMORY_CONTROL_POLICY_VERSION,
  });
}

export class MemoryOwnerControlsService {
  private readonly events: EventRepository;
  private readonly memory: MemoryRepository;
  private readonly clock: () => Date;
  private readonly idFactory: (now: Date) => Ulid;

  constructor(
    private readonly database: D1Database,
    archive: ArchiveBucket,
    memory?: MemoryRepository,
    events?: EventRepository,
    options: MemoryOwnerControlsOptions = {},
  ) {
    this.events = events ?? new EventRepository(database);
    this.memory = memory ?? new MemoryRepository(database, {
      archivedEventReader: new ArchivalService({ database, bucket: archive }),
    });
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? newUlid;
  }

  async remember(input: RememberMemoryInput): Promise<MemoryMutationReceipt> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
      requireMemoryIntent(ownerTurn, "remember");
      const text = this.memory.validateItemText(input.text);
      const kind = input.kind;
      const sensitivity = input.sensitivity;
      const basis = input.basis ?? "stated";
      const normalizedFromSource = input.normalizedFromSource ?? false;
      const modelInferred = basis === "inferred";
      if (basis !== "stated" && basis !== "confirmed" && basis !== "inferred"
        || typeof normalizedFromSource !== "boolean" || modelInferred && normalizedFromSource) refuse();
      const requestedExcerpt = input.sourceExcerpt === undefined
        ? null
        : this.memory.validateItemText(input.sourceExcerpt);
      if (!MEMORY_KINDS.has(kind) || !MEMORY_SENSITIVITIES.has(sensitivity)) refuse();
      const requestHash = await this.requestHash("remember", ownerTurn, [
        text,
        kind,
        sensitivity,
        basis,
        requestedExcerpt,
        normalizedFromSource,
      ]);
      const key = commandKey(ownerTurn, "remember");
      const existing = await this.hasCommand(key, requestHash);
      let acceptedTurn: Readonly<{ text: string; suppressed: boolean }>;
      let sourceExcerpt: string;
      let command: AppendedEvent;
      if (existing) {
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.transition",
          targetId: this.nextId(),
        });
        acceptedTurn = await this.memory.readAcceptedOwnerTurn(
          ownerTurn,
          command.envelope.eventId,
        );
        sourceExcerpt = requestedExcerpt
          ?? this.memory.validateItemText(rememberRemainder(acceptedTurn.text));
        if (!isAuthorizedRememberText(
          text, sourceExcerpt, acceptedTurn.text, normalizedFromSource, modelInferred,
        )) refuse();
      } else {
        acceptedTurn = Object.freeze({
          text: await this.memory.validateOwnerTurn(ownerTurn, "remember"),
          suppressed: false,
        });
        sourceExcerpt = requestedExcerpt
          ?? this.memory.validateItemText(rememberRemainder(acceptedTurn.text));
        if (!isAuthorizedRememberText(
          text, sourceExcerpt, acceptedTurn.text, normalizedFromSource, modelInferred,
        )) refuse();
        const duplicate = modelInferred
          ? null
          : await this.memory.findActiveItemByNormalizedText(ownerTurn.principalId, text);
        if (duplicate !== null) {
          const item = await this.memory.appendSourceToActiveItem({
            principalId: ownerTurn.principalId,
            itemId: duplicate.itemId,
            source: {
              sourceId: this.nextId(),
              eventId: ownerTurn.eventId,
              eventSequence: ownerTurn.eventSequence,
              sourceLocation: "live",
              r2SegmentId: null,
              excerpt: sourceExcerpt,
              excerptHash: await sha256Hex(sourceExcerpt),
              channel: ownerTurn.channel,
              occurredAt: ownerTurn.occurredAt,
            },
          });
          return Object.freeze({
            item,
            receipt: "That memory was already active, so I did not add a duplicate; I added Sid's new wording as evidence.",
            replayed: true,
          });
        } else {
          const topics = await this.memory.bootstrapTopics(ownerTurn.principalId);
          const transitionId = this.nextId();
          command = await this.appendCommand(ownerTurn, key, requestHash, {
            operation: "item.transition",
            targetId: transitionId,
            itemId: this.nextId(),
            versionId: this.nextId(),
            lifecycleState: modelInferred ? "proposed" : "active",
            sourceId: this.nextId(),
            placementId: this.nextId(),
            placementEventId: this.nextId(),
            topicId: topics.inbox.topicId,
            lifetime: input.lifetime ?? "durable",
            validTo: input.validTo ?? null,
          });
        }
      }
      const payload = decodeStoredCommand(command.envelope.payload, rememberPayload);
      const commitInput = Object.freeze<CommitInitialMemoryInput>({
        principalId: ownerTurn.principalId,
        itemId: payload.itemId,
        kind,
        lifetime: payload.lifetime,
        creationEventId: ownerTurn.eventId,
        creationEventSequence: ownerTurn.eventSequence,
        version: {
          versionId: payload.versionId,
          text,
          textHash: await sha256Hex(text),
          basis,
          origin: modelInferred ? "model" : "authenticated_first_person",
          uncertain: modelInferred,
          sensitivity,
          validFrom: null,
          validTo: payload.validTo,
          extractorVersion: MEMORY_CONTROL_POLICY_VERSION,
          extractorModelId: modelInferred ? "deepseek:owner-telegram-agent" : null,
        },
        sources: [{
          sourceId: payload.sourceId,
          eventId: ownerTurn.eventId,
          eventSequence: ownerTurn.eventSequence,
          sourceLocation: "live",
          r2SegmentId: null,
          excerpt: sourceExcerpt,
          excerptHash: await sha256Hex(sourceExcerpt),
          channel: ownerTurn.channel,
          occurredAt: ownerTurn.occurredAt,
        }],
        transition: {
          transitionId: payload.transitionId,
          lifecycleState: modelInferred ? "proposed" : "active",
          reason: modelInferred
            ? "model inference kept uncertain because its wording exceeded owner evidence"
            : basis === "confirmed"
            ? "owner confirmed immediate memory"
            : "owner requested immediate memory",
          policyVersion: MEMORY_CONTROL_POLICY_VERSION,
          ...(modelInferred ? {} : { ownerAuthorizingEventId: command.envelope.eventId }),
        },
        placement: {
          placementId: payload.placementId,
          placementEventId: payload.placementEventId,
          topicId: payload.topicId,
          filingSource: "rule",
          confidence: 0.4,
          reason: "owner memory starts in the explicit inbox",
        },
      });
      const result = existing && acceptedTurn.suppressed
        ? await this.memory.readInitialItemReplay(commitInput)
        : await this.memory.commitInitialItem(commitInput);
      if (result === null) refuse();
      const replayed = command.replayed || result.replayed;
      const transitionIsCurrent = result.item.lifecycle.transitionId === payload.transitionId;
      const visibility = await this.memory.readItemVisibility(ownerTurn.principalId, payload.itemId);
      const visibleItem = redactUnretrievableItem(result.item, visibility);
      const returnedItem = replayed && !transitionIsCurrent
        ? suppressMemoryText(result.item)
        : visibleItem;
      return Object.freeze({
        item: returnedItem,
        receipt: modelInferred && transitionIsCurrent
          ? "Saved 1 uncertain memory for confirmation; I recall it as an unconfirmed possibility, never as a fact."
          : replayed && !transitionIsCurrent
          ? result.item.lifecycle.state === "forgotten"
            ? "That remember request was already handled; the memory is currently hidden."
            : "That remember request was already handled; the memory has changed since then."
          : !visibility.retrievable
            ? replayed
              ? "That remember request was already handled; the memory is currently hidden."
              : "Remembered 1 memory, but it is currently hidden by another forgotten memory from the same conversation turn."
          : "Remembered 1 memory. You can ask in ordinary language to forget it.",
        replayed,
      });
    });
  }

  /**
   * Replaces one current memory with the wording Sid just stated. The earlier
   * item keeps its versions, sources and transitions and gains a retirement
   * transition plus a `supersedes` link, so the ledger stays append-only and
   * only the new wording stays recallable.
   */
  async correct(input: CorrectMemoryInput): Promise<MemoryCorrectionReceipt> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
      requireMemoryIntent(ownerTurn, "correct");
      const supersededItemId = exactSingleTarget(input.candidateItemIds);
      const text = this.memory.validateItemText(input.text);
      const kind = input.kind;
      const sensitivity = input.sensitivity;
      const normalizedFromSource = input.normalizedFromSource ?? false;
      if (typeof normalizedFromSource !== "boolean" || !MEMORY_KINDS.has(kind)
        || !MEMORY_SENSITIVITIES.has(sensitivity)) refuse();
      const requestedExcerpt = input.sourceExcerpt === undefined
        ? null
        : this.memory.validateItemText(input.sourceExcerpt);
      const replacementHash = await this.requestHash("correct", ownerTurn, [
        "replacement",
        supersededItemId,
        text,
        kind,
        sensitivity,
        requestedExcerpt,
        normalizedFromSource,
      ]);
      const supersessionHash = await this.requestHash("correct", ownerTurn, [
        "supersession",
        supersededItemId,
      ]);
      // The replacement transition and the retirement transition each need
      // their own authorizing command: the trigger binds one command to one
      // transition. They are separate appends so either can be replayed alone.
      const replacementKey = commandKey(ownerTurn, "correct");
      const supersessionKey = `${replacementKey}:supersede`;
      const replacementExisting = await this.hasCommand(replacementKey, replacementHash);
      const supersessionExisting = await this.hasCommand(supersessionKey, supersessionHash);
      const replaying = replacementExisting && supersessionExisting;

      const supersededBefore = await this.memory.readCurrentItem(ownerTurn.principalId, supersededItemId);
      const supersededVisibility = await this.memory.readItemVisibility(
        ownerTurn.principalId,
        supersededItemId,
      );
      // Only an active wording can be retired, but a replay must not re-check a
      // state the first attempt already moved. A replacement may never quietly
      // downgrade the sensitivity Sid already had on this memory.
      if (supersededBefore.lifecycle.state !== "active" && !replaying
        || supersededBefore.version.sensitivity === "sensitive" && sensitivity === "normal") refuse();

      let acceptedTurn: Readonly<{ text: string; suppressed: boolean }>;
      let sourceExcerpt: string;
      let replacementCommand: AppendedEvent;
      let supersessionCommand: AppendedEvent;
      if (replaying) {
        replacementCommand = await this.appendCommand(ownerTurn, replacementKey, replacementHash, {
          operation: "item.transition",
          targetId: this.nextId(),
        });
        supersessionCommand = await this.appendCommand(ownerTurn, supersessionKey, supersessionHash, {
          operation: "item.transition",
          targetId: this.nextId(),
        });
        acceptedTurn = await this.memory.readAcceptedOwnerTurn(
          ownerTurn,
          replacementCommand.envelope.eventId,
        );
        sourceExcerpt = requestedExcerpt
          ?? this.memory.validateItemText(acceptedTurn.text);
        if (!isAuthorizedRememberText(
          text, sourceExcerpt, acceptedTurn.text, normalizedFromSource, false,
        )) refuse();
      } else {
        acceptedTurn = Object.freeze({
          text: await this.memory.validateOwnerTurn(ownerTurn, "correct"),
          suppressed: false,
        });
        sourceExcerpt = requestedExcerpt
          ?? this.memory.validateItemText(acceptedTurn.text);
        // Sid's own words are the only authority for the new wording. Model
        // paraphrase that his sentence does not support is refused rather than
        // promoted, because a correction carries no confirmation step.
        if (!isAuthorizedRememberText(
          text, sourceExcerpt, acceptedTurn.text, normalizedFromSource, false,
        )) refuse();
        const topics = await this.memory.bootstrapTopics(ownerTurn.principalId);
        const supersedeTransitionId = this.nextId();
        replacementCommand = await this.appendCommand(ownerTurn, replacementKey, replacementHash, {
          operation: "item.transition",
          targetId: this.nextId(),
          itemId: this.nextId(),
          versionId: this.nextId(),
          lifecycleState: "active",
          sourceId: this.nextId(),
          placementId: this.nextId(),
          placementEventId: this.nextId(),
          topicId: topics.inbox.topicId,
          lifetime: supersededBefore.version.validTo === null ? "durable" : "temporary",
          validTo: supersededBefore.version.validTo,
        });
        supersessionCommand = await this.appendCommand(ownerTurn, supersessionKey, supersessionHash, {
          operation: "item.transition",
          targetId: supersedeTransitionId,
          itemId: supersededItemId,
          versionId: supersededBefore.version.versionId,
          lifecycleState: "superseded",
          linkId: this.nextId(),
        });
      }
      const replacementPayload = decodeStoredCommand(replacementCommand.envelope.payload, rememberPayload);
      const supersession = decodeStoredCommand(
        supersessionCommand.envelope.payload,
        supersessionPayload,
      );
      if (supersession.supersededItemId !== supersededItemId
        || supersession.supersededVersionId !== supersededBefore.version.versionId) corrupt();
      const replacementInput = Object.freeze<CommitInitialMemoryInput>({
        principalId: ownerTurn.principalId,
        itemId: replacementPayload.itemId,
        kind,
        // The replacement inherits the lifetime being replaced, derived from the
        // end the old wording carried rather than defaulted: defaulting to
        // durable would silently turn a fact Sid said would lapse into one that
        // never does, which is the kind of quiet promotion this redesign exists
        // to remove.
        lifetime: supersededBefore.version.validTo === null ? "durable" : "temporary",
        creationEventId: ownerTurn.eventId,
        creationEventSequence: ownerTurn.eventSequence,
        version: {
          versionId: replacementPayload.versionId,
          text,
          textHash: await sha256Hex(text),
          basis: "stated",
          origin: "authenticated_first_person",
          uncertain: false,
          sensitivity,
          validFrom: null,
          validTo: supersededBefore.version.validTo,
          extractorVersion: MEMORY_CONTROL_POLICY_VERSION,
          extractorModelId: null,
        },
        sources: [{
          sourceId: replacementPayload.sourceId,
          eventId: ownerTurn.eventId,
          eventSequence: ownerTurn.eventSequence,
          sourceLocation: "live",
          r2SegmentId: null,
          excerpt: sourceExcerpt,
          excerptHash: await sha256Hex(sourceExcerpt),
          channel: ownerTurn.channel,
          occurredAt: ownerTurn.occurredAt,
        }],
        transition: {
          transitionId: replacementPayload.transitionId,
          lifecycleState: "active",
          reason: "owner replaced an earlier memory wording",
          policyVersion: MEMORY_CONTROL_POLICY_VERSION,
          ownerAuthorizingEventId: replacementCommand.envelope.eventId,
        },
        placement: {
          placementId: replacementPayload.placementId,
          placementEventId: replacementPayload.placementEventId,
          topicId: replacementPayload.topicId,
          filingSource: "rule",
          confidence: 0.4,
          reason: "owner memory starts in the explicit inbox",
        },
      });
      const result = replaying && acceptedTurn.suppressed
        ? await this.memory.readInitialItemReplay(replacementInput)
        : await this.memory.commitInitialItem(
          replacementInput,
          undefined,
          Object.freeze({
            supersededItemId,
            linkId: supersession.linkId,
            supersedeTransitionId: supersession.supersedeTransitionId,
            ownerAuthorizingEventId: supersessionCommand.envelope.eventId,
            reason: "owner replaced this wording",
            policyVersion: MEMORY_CONTROL_POLICY_VERSION,
          }),
        );
      if (result === null) refuse();
      const visibility = await this.memory.readItemVisibility(
        ownerTurn.principalId,
        replacementPayload.itemId,
      );
      const replacementItem = redactUnretrievableItem(result.item, visibility);
      // A suppressed source keeps that side's wording out of the reply, the same
      // way forget, lift and explain already withhold text an owner cannot see.
      const earlierWording = suppressionHides(supersededVisibility)
        ? null
        : supersededBefore.version.text;
      const currentWording = replacementItem.version.text;
      const hidden = "(hidden by an active suppression)";
      return Object.freeze({
        item: replacementItem,
        supersededItemId,
        supersededText: earlierWording,
        receipt: `${earlierWording === null ? hidden : JSON.stringify(earlierWording)} is no longer current; the current wording is ${currentWording === null ? hidden : JSON.stringify(currentWording)}. Both wordings stay in the ledger.`,
        replayed: replacementCommand.replayed || supersessionCommand.replayed || result.replayed,
      });
    });
  }

  async confirm(input: ConfirmMemoryInput): Promise<MemoryConfirmReceipt> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
      requireMemoryIntent(ownerTurn, "confirm");
      const itemId = exactSingleTarget(input.candidateItemIds);
      const sourceExcerpt = this.memory.validateItemText(input.sourceExcerpt);
      const requestHash = await this.requestHash("confirm", ownerTurn, [itemId, sourceExcerpt]);
      const key = commandKey(ownerTurn, "confirm");
      const existing = await this.hasCommand(key, requestHash);
      let command: AppendedEvent;
      if (existing) {
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.transition",
          targetId: this.nextId(),
        });
      } else {
        const ownerText = await this.memory.validateOwnerTurn(ownerTurn, "confirm");
        if (!ownerText.includes(sourceExcerpt)) refuse();
        const item = await this.memory.readCurrentItem(ownerTurn.principalId, itemId);
        // A model-inferred proposal is promotable here, like any other uncertain
        // proposal: the owner's own turn has to quote the stored wording, which
        // is the authority. Refusing it left the remember receipt promising a
        // confirmation that no caller could perform.
        if (item.lifecycle.state !== "proposed" || !item.version.uncertain
          || item.sources.length < 1 || item.sources.length > 7) refuse();
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.transition",
          targetId: this.nextId(),
          itemId,
          previousVersionId: item.version.versionId,
          versionId: this.nextId(),
          lifecycleState: "active",
          sourceId: this.nextId(),
          copiedSourceIds: item.sources.map(() => this.nextId()),
        });
      }
      const acceptedTurn = await this.memory.readAcceptedOwnerTurn(ownerTurn, command.envelope.eventId);
      if (!acceptedTurn.text.includes(sourceExcerpt) || acceptedTurn.suppressed) refuse();
      const decoded = decodeStoredCommand(command.envelope.payload, confirmPayload);
      if (decoded.itemId !== itemId) corrupt();
      const confirmationInput: ConfirmMemoryItemInput = Object.freeze({
        principalId: ownerTurn.principalId,
        itemId,
        previousVersionId: decoded.previousVersionId,
        versionId: decoded.versionId,
        transitionId: decoded.transitionId,
        ownerAuthorizingEventId: command.envelope.eventId,
        confirmationSource: Object.freeze({
          sourceId: decoded.sourceId,
          eventId: ownerTurn.eventId,
          eventSequence: ownerTurn.eventSequence,
          sourceLocation: "live",
          r2SegmentId: null,
          excerpt: sourceExcerpt,
          excerptHash: await sha256Hex(sourceExcerpt),
          channel: ownerTurn.channel,
          occurredAt: ownerTurn.occurredAt,
        }),
        copiedSourceIds: decoded.copiedSourceIds,
        reason: "owner confirmed proposed memory",
        policyVersion: MEMORY_CONTROL_POLICY_VERSION,
      });
      const result = await this.memory.confirmItem(confirmationInput);
      return Object.freeze({
        item: result.item,
        receipt: "Confirmed 1 proposed memory for recall. You can ask in ordinary language to forget it.",
        replayed: command.replayed || result.replayed,
      });
    });
  }

  async confirmInferredFromDecision(input: ConfirmedMemoryDecisionInput): Promise<MemoryConfirmReceipt> {
    return this.safely(async () => {
      const principalId = this.validPrincipalId(input.principalId);
      const callbackEventId = inputUlid(input.callbackEventId);
      const decisionId = inputUlid(input.decisionId);
      const itemId = inputUlid(input.itemId);
      const previousVersionId = inputUlid(input.previousVersionId);
      await this.readConfirmedDecisionCallback(principalId, callbackEventId, decisionId);
      await this.requireConfirmedMemoryDecision(
        principalId,
        decisionId,
        `${itemId}:${previousVersionId}`,
      );

      const requestHash = await sha256Hex(canonicalJson([
        MEMORY_CONTROL_POLICY_VERSION,
        "confirmed-memory",
        principalId,
        decisionId,
        itemId,
        previousVersionId,
      ]));
      const key = `${decisionId}:confirm:${itemId}`;
      const existing = await this.hasCommand(key, requestHash);
      let command: AppendedEvent;
      if (existing) {
        command = await this.appendDecisionCommand({
          principalId,
          callbackEventId,
          key,
          requestHash,
          payload: { operation: "item.transition", targetId: this.nextId() },
        });
      } else {
        const item = await this.memory.readCurrentItem(principalId, itemId);
        if (item.lifecycle.state !== "proposed" || !item.version.uncertain
          || item.version.origin !== "model" || item.version.basis !== "inferred"
          || item.version.versionId !== previousVersionId
          || item.sources.length < 1 || item.sources.length > 7) refuse();
        const confirmationExcerpt = this.memory.validateItemText(
          `Confirmed exact stored memory by tap: ${JSON.stringify(item.version.text)}`,
        );
        command = await this.appendDecisionCommand({
          principalId,
          callbackEventId,
          key,
          requestHash,
          payload: {
            operation: "item.transition",
            targetId: this.nextId(),
            itemId,
            previousVersionId,
            versionId: this.nextId(),
            lifecycleState: "active",
            sourceId: this.nextId(),
            copiedSourceIds: item.sources.map(() => this.nextId()),
            confirmationExcerpt,
          },
        });
      }

      const decoded = decodeStoredCommand(command.envelope.payload, confirmedDecisionPayload);
      if (decoded.itemId !== itemId || decoded.previousVersionId !== previousVersionId) corrupt();
      const authorizingCallbackId = inputUlid(command.envelope.causationId);
      await this.readConfirmedDecisionCallback(
        principalId,
        authorizingCallbackId,
        decisionId,
      );
      const confirmationExcerpt = this.memory.validateItemText(decoded.confirmationExcerpt);
      const result = await this.memory.confirmItem(Object.freeze({
        principalId,
        itemId,
        previousVersionId: decoded.previousVersionId,
        versionId: decoded.versionId,
        transitionId: decoded.transitionId,
        ownerAuthorizingEventId: command.envelope.eventId,
        confirmationSource: Object.freeze({
          sourceId: decoded.sourceId,
          eventId: command.envelope.eventId,
          eventSequence: command.eventSequence,
          sourceLocation: "live",
          r2SegmentId: null,
          excerpt: confirmationExcerpt,
          excerptHash: await sha256Hex(confirmationExcerpt),
          channel: "system",
          occurredAt: command.envelope.occurredAt,
        }),
        copiedSourceIds: decoded.copiedSourceIds,
        reason: "owner confirmed model-inferred memory by bound decision tap",
        policyVersion: MEMORY_CONTROL_POLICY_VERSION,
      }));
      return Object.freeze({
        item: result.item,
        receipt: "Confirmed 1 proposed memory for recall. You can ask in ordinary language to forget it.",
        replayed: command.replayed || result.replayed,
      });
    });
  }

  async explain(input: TargetedMemoryControlInput): Promise<MemoryExplanation> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
      requireMemoryIntent(ownerTurn, "explain");
      const itemId = exactSingleTarget(input.candidateItemIds);
      await this.memory.validateOwnerTurn(ownerTurn, "explain");
      const item = await this.memory.readCurrentItem(ownerTurn.principalId, itemId);
      const visibility = await this.memory.readItemVisibility(ownerTurn.principalId, itemId);
      const visibleItem = redactUnretrievableItem(item, visibility);
      const hidden = !visibility.retrievable;
      return Object.freeze({
        itemId,
        state: item.lifecycle.state,
        uncertain: item.version.uncertain,
        topicPath: Object.freeze(visibleItem.topicPath.map((entry) => entry.displayName)),
        text: visibleItem.version.text,
        sources: Object.freeze(visibleItem.sources.map((source) => Object.freeze({
          eventId: source.eventId,
          occurredAt: source.occurredAt,
          channel: source.channel,
          excerpt: source.excerpt,
        }))),
        receipt: hidden
          ? "Explained 1 hidden memory without revealing its text; nothing changed."
          : "Explained 1 memory from verified evidence; nothing changed.",
      });
    });
  }

  async forget(input: TargetedMemoryControlInput): Promise<MemoryForgetReceipt> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
      requireMemoryIntent(ownerTurn, "forget");
      const itemId = exactSingleTarget(input.candidateItemIds);
      const requestHash = await this.requestHash("forget", ownerTurn, [itemId]);
      const key = commandKey(ownerTurn, "forget");
      const existing = await this.hasCommand(key, requestHash);
      let command: AppendedEvent;
      if (existing) {
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.forget",
          targetId: this.nextId(),
        });
      } else {
        await this.memory.validateOwnerTurn(ownerTurn, "forget");
        const prepared = await this.memory.prepareForgetItem(ownerTurn.principalId, itemId);
        const transitionId = this.nextId();
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.forget",
          targetId: transitionId,
          itemId,
          versionId: prepared.item.version.versionId,
          lifecycleState: "forgotten",
          suppressions: prepared.sources.map((source) => ({
            suppressionId: this.nextId(),
            sourceId: source.sourceId,
            targetEventId: source.eventId,
            startEventSequence: null,
            endEventSequence: null,
            newlyHiddenTurnCount: source.newlyHiddenTurnCount,
            totalCoveredTurnCount: source.totalCoveredTurnCount,
          })),
        });
      }
      const decoded = decodeStoredCommand(command.envelope.payload, forgetPayload);
      if (decoded.itemId !== itemId) corrupt();
      const result = await this.memory.forgetItem({
        ...decoded,
        principalId: ownerTurn.principalId,
        ownerAuthorizingEventId: command.envelope.eventId,
      });
      const hiddenSiblingItemCount = await this.memory.countSiblingItemsHiddenByForget(
        ownerTurn.principalId,
        itemId,
        decoded.transitionId,
      );
      return Object.freeze({
        itemId: result.item.itemId,
        state: "forgotten" as const,
        newlyHiddenTurnCount: result.newlyHiddenTurnCount,
        totalCoveredTurnCount: result.totalCoveredTurnCount,
        hiddenSiblingItemCount,
        receipt: `Forgot 1 memory and hid ${result.newlyHiddenTurnCount} of ${result.totalCoveredTurnCount} source turns${hiddenSiblingItemCount === 0
          ? ""
          : `, which also hid ${hiddenSiblingItemCount} other active ${hiddenSiblingItemCount === 1 ? "memory" : "memories"}`}; the original conversation remains retained. You can ask in ordinary language to use it again.`,
        replayed: command.replayed || result.replayed,
      });
    });
  }

  async forgetConfirmedDecision(
    input: ConfirmedForgetDecisionInput,
  ): Promise<readonly MemoryForgetReceipt[]> {
    return this.safely(async () => {
      const principalId = input.principalId;
      if (typeof principalId !== "string" || principalId.length < 1 || principalId.length > 256
        || !principalId.isWellFormed() || principalId !== principalId.normalize("NFC")) refuse();
      const callbackEventId = inputUlid(input.callbackEventId);
      const decisionId = inputUlid(input.decisionId);
      if (!Array.isArray(input.itemIds) || input.itemIds.length < 2 || input.itemIds.length > 8) refuse();
      const itemIds = input.itemIds.map(inputUlid);
      if (new Set(itemIds).size !== itemIds.length) refuse();
      const callback = await this.database.prepare(`SELECT event.event_id, event.envelope_json
        FROM events event
        JOIN channel_identities identity
          ON identity.principal_id = ?1 AND identity.channel = 'telegram'
          AND identity.status = 'active' AND identity.verified_at IS NOT NULL
          AND event.subject_id = 'telegram:user:' || identity.provider_subject
        WHERE event.event_id = ?2 AND event.event_type = 'telegram.callback.received'
          AND event.source = 'channel:telegram'
        LIMIT 1`).bind(principalId, callbackEventId).first<{
          event_id: unknown;
          envelope_json: unknown;
        }>();
      if (callback?.event_id !== callbackEventId || typeof callback.envelope_json !== "string"
        || Reflect.ownKeys(callback).length !== 2) refuse();
      let callbackEnvelope: Awaited<ReturnType<typeof validateEnvelope>>;
      try {
        callbackEnvelope = await validateEnvelope(JSON.parse(callback.envelope_json) as unknown);
      } catch {
        refuse();
      }
      if (callbackEnvelope.eventId !== callbackEventId || callbackEnvelope.subjectId.length === 0
        || callbackEnvelope.payload === null || typeof callbackEnvelope.payload !== "object"
        || Array.isArray(callbackEnvelope.payload)
        || (callbackEnvelope.payload as Record<string, unknown>).data
          !== encodeDecisionCallbackData(decisionId, "confirm")) refuse();
      const decision = await this.database.prepare(`SELECT item.decision_id, item.principal_id,
          item.origin, item.origin_reference, item.status, response.option_key,
          identity.principal_id AS identity_principal_id
        FROM decision_items item
        JOIN decision_responses response ON response.decision_id = item.decision_id
        JOIN channel_identities identity
          ON identity.identity_id = response.answered_by_identity_id
          AND identity.channel = 'telegram' AND identity.status = 'active'
          AND identity.verified_at IS NOT NULL
        WHERE item.decision_id = ?1
        LIMIT 1`).bind(decisionId).first<{
          decision_id: unknown;
          principal_id: unknown;
          origin: unknown;
          origin_reference: unknown;
          status: unknown;
          option_key: unknown;
          identity_principal_id: unknown;
        }>();
      if (decision === null || Reflect.ownKeys(decision).length !== 7
        || decision.decision_id !== decisionId || decision.principal_id !== principalId
        || decision.identity_principal_id !== principalId || decision.origin !== "telegram-memory-forget"
        || decision.origin_reference !== itemIds.join(",") || decision.status !== "answered"
        || decision.option_key !== "confirm") refuse();
      const preparedCommands: Array<Readonly<{
        itemId: Ulid;
        command: AppendedEvent;
        decoded: DecodedForgetCommand;
      }>> = [];
      const receipts: MemoryForgetReceipt[] = [];
      for (const itemId of itemIds) {
        const current = await this.memory.readCurrentItem(principalId, itemId);
        if (current.lifecycle.state === "forgotten") {
          receipts.push(Object.freeze({
            itemId,
            state: "forgotten" as const,
            newlyHiddenTurnCount: 0,
            totalCoveredTurnCount: current.sources.length,
            hiddenSiblingItemCount: 0,
            receipt: "That memory was already forgotten; nothing else changed.",
            replayed: true,
          }));
          continue;
        }
        const requestHash = await sha256Hex(canonicalJson([
          MEMORY_CONTROL_POLICY_VERSION,
          "confirmed-forget",
          principalId,
          decisionId,
          itemId,
        ]));
        const key = `${decisionId}:forget:${itemId}`;
        const existing = await this.hasCommand(key, requestHash);
        let command: AppendedEvent;
        if (existing) {
          command = await this.appendDecisionCommand({
            principalId,
            callbackEventId,
            key,
            requestHash,
            payload: { operation: "item.forget", targetId: this.nextId() },
          });
        } else {
          const prepared = await this.memory.prepareForgetItem(principalId, itemId);
          command = await this.appendDecisionCommand({
            principalId,
            callbackEventId,
            key,
            requestHash,
            payload: {
              operation: "item.forget",
              targetId: this.nextId(),
              itemId,
              versionId: prepared.item.version.versionId,
              lifecycleState: "forgotten",
              suppressions: prepared.sources.map((source) => ({
                suppressionId: this.nextId(),
                sourceId: source.sourceId,
                targetEventId: source.eventId,
                startEventSequence: null,
                endEventSequence: null,
                newlyHiddenTurnCount: source.newlyHiddenTurnCount,
                totalCoveredTurnCount: source.totalCoveredTurnCount,
              })),
            },
          });
        }
        const decoded = decodeStoredCommand(command.envelope.payload, forgetPayload);
        if (decoded.itemId !== itemId) corrupt();
        preparedCommands.push(Object.freeze({ itemId, command, decoded }));
      }
      for (const { itemId, command, decoded } of preparedCommands) {
        const result = await this.memory.forgetItem({
          ...decoded,
          principalId,
          ownerAuthorizingEventId: command.envelope.eventId,
        });
        const hiddenSiblingItemCount = await this.memory.countSiblingItemsHiddenByForget(
          principalId,
          itemId,
          decoded.transitionId,
        );
        receipts.push(Object.freeze({
          itemId,
          state: "forgotten" as const,
          newlyHiddenTurnCount: result.newlyHiddenTurnCount,
          totalCoveredTurnCount: result.totalCoveredTurnCount,
          hiddenSiblingItemCount,
          receipt: `Forgot 1 memory and hid ${result.newlyHiddenTurnCount} of ${result.totalCoveredTurnCount} source turns${hiddenSiblingItemCount === 0
            ? ""
            : `, which also hid ${hiddenSiblingItemCount} other active ${hiddenSiblingItemCount === 1 ? "memory" : "memories"}`}; the original conversation remains retained. You can ask in ordinary language to use it again.`,
          replayed: command.replayed || result.replayed,
        }));
      }
      return Object.freeze(receipts);
    });
  }

  async lift(input: TargetedMemoryControlInput): Promise<MemoryLiftReceipt> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
      requireMemoryIntent(ownerTurn, "lift");
      const itemId = exactSingleTarget(input.candidateItemIds);
      const requestHash = await this.requestHash("lift", ownerTurn, [itemId]);
      const key = commandKey(ownerTurn, "lift");
      const existing = await this.hasCommand(key, requestHash);
      let command: AppendedEvent;
      if (existing) {
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.correct",
          targetId: this.nextId(),
        });
      } else {
        await this.memory.validateOwnerTurn(ownerTurn, "lift");
        const prepared = await this.memory.prepareLiftItem(ownerTurn.principalId, itemId);
        const transitionId = this.nextId();
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.correct",
          targetId: transitionId,
          itemId,
          previousVersionId: prepared.item.version.versionId,
          versionId: this.nextId(),
          lifecycleState: prepared.restoredLifecycleState,
          sourceIds: prepared.item.sources.map(() => this.nextId()),
          lifts: prepared.suppressionIds.map((suppressionId) => ({
            liftId: this.nextId(),
            suppressionId,
          })),
        });
      }
      const decoded = decodeStoredCommand(command.envelope.payload, liftPayload);
      if (decoded.itemId !== itemId) corrupt();
      const result = await this.memory.liftItem({
        ...decoded,
        principalId: ownerTurn.principalId,
        ownerAuthorizingEventId: command.envelope.eventId,
      });
      const visibility = await this.memory.readItemVisibility(ownerTurn.principalId, itemId);
      return Object.freeze({
        item: redactUnretrievableItem(result.item, visibility),
        liftedSuppressionCount: result.liftedSuppressionCount,
        retrievable: visibility.retrievable,
        receipt: result.item.lifecycle.state === "proposed"
          ? `Restored 1 memory to proposed and lifted ${result.liftedSuppressionCount} suppressions; it still needs confirmation before recall.`
          : visibility.retrievable
            ? `Restored 1 memory and lifted ${result.liftedSuppressionCount} suppressions. You can ask in ordinary language to forget it again.`
            : `Restored 1 memory and lifted ${result.liftedSuppressionCount} suppressions, but it is still hidden because another forgotten memory covers the same conversation turn.`,
        replayed: command.replayed || result.replayed,
      });
    });
  }

  private validPrincipalId(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 256
      || !value.isWellFormed() || value !== value.normalize("NFC")) refuse();
    return value;
  }

  private async readConfirmedDecisionCallback(
    principalId: string,
    callbackEventId: Ulid,
    decisionId: Ulid,
  ): Promise<void> {
    const callback = await this.database.prepare(`SELECT event.event_id, event.envelope_json
      FROM events event
      JOIN channel_identities identity
        ON identity.principal_id = ?1 AND identity.channel = 'telegram'
        AND identity.status = 'active' AND identity.verified_at IS NOT NULL
        AND event.subject_id = 'telegram:user:' || identity.provider_subject
      WHERE event.event_id = ?2 AND event.event_type = 'telegram.callback.received'
        AND event.source = 'channel:telegram'
      LIMIT 1`).bind(principalId, callbackEventId).first<{
        event_id: unknown;
        envelope_json: unknown;
      }>();
    if (callback?.event_id !== callbackEventId || typeof callback.envelope_json !== "string"
      || Reflect.ownKeys(callback).length !== 2) refuse();
    let envelope: Awaited<ReturnType<typeof validateEnvelope>>;
    try {
      envelope = await validateEnvelope(JSON.parse(callback.envelope_json) as unknown);
    } catch {
      refuse();
    }
    if (envelope.eventId !== callbackEventId || envelope.subjectId.length === 0
      || envelope.eventType !== "telegram.callback.received" || envelope.source !== "channel:telegram"
      || envelope.payload === null || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)
      || (envelope.payload as Record<string, unknown>).data
        !== encodeDecisionCallbackData(decisionId, "confirm")) refuse();
  }

  private async requireConfirmedMemoryDecision(
    principalId: string,
    decisionId: Ulid,
    originReference: string,
  ): Promise<void> {
    const decision = await this.database.prepare(`SELECT item.decision_id, item.principal_id,
        item.origin, item.origin_reference, item.status, response.option_key,
        identity.principal_id AS identity_principal_id
      FROM decision_items item
      JOIN decision_responses response ON response.decision_id = item.decision_id
      JOIN channel_identities identity
        ON identity.identity_id = response.answered_by_identity_id
        AND identity.channel = 'telegram' AND identity.status = 'active'
        AND identity.verified_at IS NOT NULL
      WHERE item.decision_id = ?1
      LIMIT 1`).bind(decisionId).first<{
        decision_id: unknown;
        principal_id: unknown;
        origin: unknown;
        origin_reference: unknown;
        status: unknown;
        option_key: unknown;
        identity_principal_id: unknown;
      }>();
    if (decision === null || Reflect.ownKeys(decision).length !== 7
      || decision.decision_id !== decisionId || decision.principal_id !== principalId
      || decision.identity_principal_id !== principalId || decision.origin !== "telegram-memory-confirm"
      || decision.origin_reference !== originReference || decision.status !== "answered"
      || decision.option_key !== "confirm") refuse();
  }

  private async appendCommand(
    turn: MemoryOwnerTurnInput,
    key: string,
    requestHash: Sha256Hex,
    payload: JsonRecord,
  ): Promise<AppendedEvent> {
    const eventId = this.nextId();
    const now = this.freshNow().toISOString();
    const envelope = await createEnvelope({
      schemaVersion: "1.0",
      eventId,
      correlationId: eventId,
      causationId: turn.eventId,
      eventType: MEMORY_CONTROL_EVENT_TYPE,
      source: MEMORY_CONTROL_SOURCE,
      subjectId: turn.principalId,
      occurredAt: now,
      receivedAt: now,
      contentType: "application/json",
      producerVersion: MEMORY_CONTROL_PRODUCER,
      payload: redactPayload(payload),
    });
    return this.events.append({
      envelope,
      scope: "memory:owner-control",
      key,
      requestHash,
    });
  }

  private async appendDecisionCommand(input: {
    readonly principalId: string;
    readonly callbackEventId: Ulid;
    readonly key: string;
    readonly requestHash: Sha256Hex;
    readonly payload: JsonRecord;
  }): Promise<AppendedEvent> {
    const eventId = this.nextId();
    const now = this.freshNow().toISOString();
    const envelope = await createEnvelope({
      schemaVersion: "1.0",
      eventId,
      correlationId: eventId,
      causationId: input.callbackEventId,
      eventType: MEMORY_CONTROL_EVENT_TYPE,
      source: MEMORY_CONTROL_SOURCE,
      subjectId: input.principalId,
      occurredAt: now,
      receivedAt: now,
      contentType: "application/json",
      producerVersion: MEMORY_CONTROL_PRODUCER,
      payload: redactPayload(input.payload),
    });
    return this.events.append({
      envelope,
      scope: "memory:owner-control",
      key: input.key,
      requestHash: input.requestHash,
    });
  }

  private async hasCommand(key: string, requestHash: Sha256Hex): Promise<boolean> {
    const row = await this.database.prepare(
      "SELECT request_hash FROM idempotency_records WHERE scope = 'memory:owner-control' AND key = ?",
    ).bind(key).first<StoredControlReceipt>();
    if (row === null) return false;
    if (Reflect.ownKeys(row).length !== 1 || row.request_hash !== requestHash) refuse();
    return true;
  }

  private async requestHash(
    operation: MemoryControlIntent,
    turn: MemoryOwnerTurnInput,
    operands: readonly JsonValue[],
  ): Promise<Sha256Hex> {
    return sha256Hex(canonicalJson([
      MEMORY_CONTROL_POLICY_VERSION,
      operation,
      turn.principalId,
      turn.eventId,
      turn.eventSequence,
      turn.occurredAt,
      turn.channel,
      turn.memoryIntent,
      turn.forwarded,
      turn.quoted,
      turn.pasted,
      turn.hasAttachment,
      turn.modelGenerated,
      turn.toolGenerated,
      turn.guest,
      ...operands,
    ]));
  }

  private nextId(): Ulid {
    return inputUlid(this.idFactory(this.freshNow()));
  }

  private freshNow(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) refuse();
    return new Date(value.valueOf());
  }

  private async safely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryRepositoryError) throw error;
      if (error instanceof IdempotencyConflict) refuse();
      unavailable();
    }
  }
}
