import {
  newUlid,
  sha256Hex,
  validateEnvelope,
  type JsonValue,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { hasFactTextControls } from "../../../../packages/contracts/src/memory-projection.js";
import { TransactionRunner } from "../persistence/transaction.js";
import {
  MEMORY_INBOX_DISPLAY_NAME,
  MEMORY_ROOT_DISPLAY_NAME,
  MEMORY_TOPIC_REDIRECT_LIMIT,
  MemoryRepositoryError,
  type BootstrapMemoryTopicsResult,
  type CanonicalMemoryItem,
  type CanonicalMemorySource,
  type CanonicalTopicPathEntry,
  type CommitInitialMemoryInput,
  type CommitInitialMemoryResult,
  type MemoryBasis,
  type MemoryFilingSource,
  type MemoryKind,
  type MemoryLifecycleState,
  type MemoryOrigin,
  type MemorySensitivity,
  type MemorySourceChannel,
  type MemorySourceLocation,
  type ResolvedMemoryTopic,
} from "./memory-types.js";

export type MemoryRepositoryWriteOperation = "bootstrap" | "commit";

export interface MemoryRepositoryOptions {
  readonly clock?: () => Date;
  readonly idFactory?: (now: Date) => Ulid;
  readonly maximumWriteAttempts?: number;
  /** Test seam for a race or a failure immediately before the D1 boundary. */
  readonly beforeBatch?: (
    operation: MemoryRepositoryWriteOperation,
    attempt: number,
  ) => void | Promise<void>;
  /** Test seam whose statement remains inside the same production D1 batch. */
  readonly batchFault?: (
    operation: MemoryRepositoryWriteOperation,
    attempt: number,
  ) => D1PreparedStatement | null;
}

interface PrincipalRow {
  readonly principal_id: unknown;
  readonly status: unknown;
}

interface EventReceiptRow {
  readonly event_id: unknown;
  readonly sequence: unknown;
  readonly subject_id: unknown;
  readonly occurred_at: unknown;
  readonly event_type: unknown;
  readonly content_hash: unknown;
  readonly envelope_json: unknown;
}

interface ArchivedReceiptRow {
  readonly event_id: unknown;
  readonly event_sequence: unknown;
  readonly segment_id: unknown;
}

interface ItemRow {
  readonly item_id: unknown;
  readonly principal_id: unknown;
  readonly kind: unknown;
  readonly creation_event_id: unknown;
  readonly creation_event_sequence: unknown;
  readonly created_at: unknown;
}

interface VersionRow {
  readonly version_id: unknown;
  readonly principal_id: unknown;
  readonly item_id: unknown;
  readonly version_number: unknown;
  readonly text: unknown;
  readonly text_hash: unknown;
  readonly basis: unknown;
  readonly origin: unknown;
  readonly uncertain: unknown;
  readonly sensitivity: unknown;
  readonly valid_from: unknown;
  readonly valid_to: unknown;
  readonly extractor_version: unknown;
  readonly extractor_model_id: unknown;
  readonly created_at: unknown;
}

interface SourceRow {
  readonly source_id: unknown;
  readonly principal_id: unknown;
  readonly item_id: unknown;
  readonly version_id: unknown;
  readonly source_position: unknown;
  readonly event_id: unknown;
  readonly event_sequence: unknown;
  readonly source_location: unknown;
  readonly r2_segment_id: unknown;
  readonly excerpt: unknown;
  readonly excerpt_hash: unknown;
  readonly channel: unknown;
  readonly occurred_at: unknown;
  readonly created_at: unknown;
}

interface TransitionRow {
  readonly transition_id: unknown;
  readonly principal_id: unknown;
  readonly item_id: unknown;
  readonly transition_number: unknown;
  readonly version_id: unknown;
  readonly lifecycle_state: unknown;
  readonly reason: unknown;
  readonly actor: unknown;
  readonly policy_version: unknown;
  readonly owner_authorizing_event_id: unknown;
  readonly occurred_at: unknown;
}

interface PlacementEventRow {
  readonly placement_event_id: unknown;
  readonly principal_id: unknown;
  readonly placement_id: unknown;
  readonly placement_event_number: unknown;
  readonly item_id: unknown;
  readonly operation: unknown;
  readonly previous_topic_id: unknown;
  readonly new_topic_id: unknown;
  readonly relation: unknown;
  readonly filing_source: unknown;
  readonly confidence: unknown;
  readonly reason: unknown;
  readonly owner_authorizing_event_id: unknown;
  readonly occurred_at: unknown;
}

interface CanonicalRow {
  readonly item_id: unknown;
  readonly principal_id: unknown;
  readonly kind: unknown;
  readonly creation_event_id: unknown;
  readonly creation_event_sequence: unknown;
  readonly item_created_at: unknown;
  readonly version_id: unknown;
  readonly version_item_id: unknown;
  readonly version_number: unknown;
  readonly text: unknown;
  readonly text_hash: unknown;
  readonly basis: unknown;
  readonly origin: unknown;
  readonly uncertain: unknown;
  readonly sensitivity: unknown;
  readonly valid_from: unknown;
  readonly valid_to: unknown;
  readonly extractor_version: unknown;
  readonly extractor_model_id: unknown;
  readonly version_created_at: unknown;
  readonly transition_id: unknown;
  readonly transition_item_id: unknown;
  readonly transition_number: unknown;
  readonly transition_version_id: unknown;
  readonly lifecycle_state: unknown;
  readonly reason: unknown;
  readonly actor: unknown;
  readonly policy_version: unknown;
  readonly owner_authorizing_event_id: unknown;
  readonly occurred_at: unknown;
  readonly state_current_version_id: unknown;
  readonly state_lifecycle_state: unknown;
  readonly state_last_transition_id: unknown;
  readonly state_last_transition_number: unknown;
  readonly state_updated_at: unknown;
  readonly placement_id: unknown;
  readonly placement_item_id: unknown;
  readonly placement_topic_id: unknown;
  readonly placement_relation: unknown;
  readonly placement_status: unknown;
  readonly placement_last_event_kind: unknown;
  readonly placement_last_event_id: unknown;
  readonly placement_last_event_number: unknown;
  readonly placement_updated_at: unknown;
  readonly placement_event_id: unknown;
  readonly placement_event_item_id: unknown;
  readonly placement_event_number: unknown;
  readonly placement_event_operation: unknown;
  readonly placement_event_new_topic_id: unknown;
  readonly filing_source: unknown;
  readonly confidence: unknown;
  readonly placement_reason: unknown;
}

interface TopicRow {
  readonly topic_id: unknown;
  readonly principal_id: unknown;
  readonly parent_topic_id: unknown;
  readonly display_name: unknown;
  readonly normalized_name: unknown;
  readonly status: unknown;
  readonly redirect_to_topic_id: unknown;
  readonly last_topic_event_id: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface AliasRow {
  readonly alias_id: unknown;
  readonly principal_id: unknown;
  readonly topic_id: unknown;
  readonly display_alias: unknown;
  readonly normalized_alias: unknown;
  readonly path_alias: unknown;
  readonly created_by_topic_event_id: unknown;
  readonly created_at: unknown;
}

interface CapturedSource {
  readonly sourceId: Ulid;
  readonly eventId: Ulid;
  readonly eventSequence: number;
  readonly sourceLocation: MemorySourceLocation;
  readonly r2SegmentId: Sha256Hex | null;
  readonly excerpt: string;
  readonly excerptHash: Sha256Hex;
  readonly channel: MemorySourceChannel;
  readonly occurredAt: string;
}

interface SourceReceiptExpectation {
  readonly sourceLocation: MemorySourceLocation;
  readonly r2SegmentId: Sha256Hex | null;
  readonly excerpt: string;
  readonly channel: MemorySourceChannel;
  readonly occurredAt: string;
}

interface CapturedInput {
  readonly principalId: string;
  readonly itemId: Ulid;
  readonly kind: MemoryKind;
  readonly creationEventId: Ulid;
  readonly creationEventSequence: number;
  readonly version: Readonly<{
    versionId: Ulid;
    text: string;
    textHash: Sha256Hex;
    basis: MemoryBasis;
    origin: MemoryOrigin;
    uncertain: boolean;
    sensitivity: MemorySensitivity;
    validFrom: string | null;
    validTo: string | null;
    extractorVersion: string;
    extractorModelId: string | null;
  }>;
  readonly sources: readonly CapturedSource[];
  readonly transition: Readonly<{
    transitionId: Ulid;
    lifecycleState: "proposed" | "active";
    reason: string;
    policyVersion: string;
  }>;
  readonly placement: Readonly<{
    placementId: Ulid;
    placementEventId: Ulid;
    topicId: Ulid;
    filingSource: MemoryFilingSource;
    confidence: number;
    reason: string;
  }>;
}

interface ValidatedTopic {
  readonly topicId: Ulid;
  readonly principalId: string;
  readonly parentTopicId: Ulid | null;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly status: "active" | "merged";
  readonly redirectToTopicId: Ulid | null;
  readonly lastTopicEventId: Ulid;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROVIDER_MODEL = /^(?:deepseek|anthropic|openai):[^\s]{1,182}$/u;
const utf8 = new TextEncoder();
const eventReceiptFields = new Set([
  "event_id", "sequence", "subject_id", "occurred_at", "event_type", "content_hash", "envelope_json",
]);
const itemFields = new Set([
  "item_id", "principal_id", "kind", "creation_event_id",
  "creation_event_sequence", "created_at",
]);
const versionFields = new Set([
  "version_id", "principal_id", "item_id", "version_number", "text", "text_hash",
  "basis", "origin", "uncertain", "sensitivity", "valid_from", "valid_to",
  "extractor_version", "extractor_model_id", "created_at",
]);
const sourceFields = new Set([
  "source_id", "principal_id", "item_id", "version_id", "source_position", "event_id",
  "event_sequence", "source_location", "r2_segment_id", "excerpt", "excerpt_hash",
  "channel", "occurred_at", "created_at",
]);
const transitionFields = new Set([
  "transition_id", "principal_id", "item_id", "transition_number", "version_id",
  "lifecycle_state", "reason", "actor", "policy_version", "owner_authorizing_event_id",
  "occurred_at",
]);
const placementEventFields = new Set([
  "placement_event_id", "principal_id", "placement_id", "placement_event_number", "item_id",
  "operation", "previous_topic_id", "new_topic_id", "relation", "filing_source", "confidence",
  "reason", "owner_authorizing_event_id", "occurred_at",
]);
const topicFields = new Set([
  "topic_id", "principal_id", "parent_topic_id", "display_name", "normalized_name", "status",
  "redirect_to_topic_id", "last_topic_event_id", "created_at", "updated_at",
]);
const aliasFields = new Set([
  "alias_id", "principal_id", "topic_id", "display_alias", "normalized_alias", "path_alias",
  "created_by_topic_event_id", "created_at",
]);
const canonicalFields = new Set([
  "item_id", "principal_id", "kind", "creation_event_id", "creation_event_sequence",
  "item_created_at", "version_id", "version_item_id", "version_number", "text", "text_hash",
  "basis", "origin", "uncertain", "sensitivity", "valid_from", "valid_to", "extractor_version",
  "extractor_model_id", "version_created_at", "transition_id", "transition_item_id",
  "transition_number", "transition_version_id", "lifecycle_state", "reason", "actor",
  "policy_version", "owner_authorizing_event_id", "occurred_at", "state_current_version_id",
  "state_lifecycle_state", "state_last_transition_id", "state_last_transition_number",
  "state_updated_at", "placement_id", "placement_item_id", "placement_topic_id",
  "placement_relation", "placement_status", "placement_last_event_kind", "placement_last_event_id",
  "placement_last_event_number", "placement_updated_at", "placement_event_id",
  "placement_event_item_id", "placement_event_number", "placement_event_operation",
  "placement_event_new_topic_id",
  "filing_source", "confidence", "placement_reason",
]);

function refuse(): never {
  throw new MemoryRepositoryError("memory_refused");
}

function corrupt(): never {
  throw new MemoryRepositoryError("memory_corrupt");
}

function exactRow(value: unknown, fields: ReadonlySet<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) corrupt();
}

function inputUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) refuse();
  return value as Ulid;
}

function rowUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) corrupt();
  return value as Ulid;
}

function inputHash(value: unknown): Sha256Hex {
  if (typeof value !== "string" || !SHA256.test(value)) refuse();
  return value as Sha256Hex;
}

function rowHash(value: unknown): Sha256Hex {
  if (typeof value !== "string" || !SHA256.test(value)) corrupt();
  return value as Sha256Hex;
}

function safeInputText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || utf8.encode(value).byteLength > maximumBytes
    || hasFactTextControls(value)) refuse();
  return value;
}

function safeRowText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || utf8.encode(value).byteLength > maximumBytes
    || hasFactTextControls(value)) corrupt();
  return value;
}

function optionalInputText(value: unknown, maximumBytes: number): string | null {
  return value === null ? null : safeInputText(value, maximumBytes);
}

function optionalRowText(value: unknown, maximumBytes: number): string | null {
  return value === null ? null : safeRowText(value, maximumBytes);
}

function inputInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) refuse();
  return value as number;
}

function rowInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) corrupt();
  return value as number;
}

function inputTimestamp(value: unknown): string {
  if (typeof value !== "string") refuse();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) refuse();
  return value;
}

function rowTimestamp(value: unknown): string {
  if (typeof value !== "string") corrupt();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) corrupt();
  return value;
}

function inputEnum<T extends string>(value: unknown, values: ReadonlySet<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) refuse();
  return value as T;
}

function rowEnum<T extends string>(value: unknown, values: ReadonlySet<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) corrupt();
  return value as T;
}

function rowPrincipal(value: unknown, expected: string): string {
  if (typeof value !== "string" || value !== expected) corrupt();
  return value;
}

function optionalRowUlid(value: unknown): Ulid | null {
  return value === null ? null : rowUlid(value);
}

function optionalRowHash(value: unknown): Sha256Hex | null {
  return value === null ? null : rowHash(value);
}

function normalizedTopicName(displayName: string): string {
  return displayName.normalize("NFC").toLocaleLowerCase("en-US");
}

function payloadContainsExactExcerpt(payload: JsonValue, excerpt: string): boolean {
  const pending: Array<{ readonly value: JsonValue; readonly depth: number }> = [{ value: payload, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) corrupt();
    visited += 1;
    if (visited > 16_384 || current.depth > 64) corrupt();
    if (typeof current.value === "string") {
      if (current.value.includes(excerpt)) return true;
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
  return false;
}

function liveEventChannel(eventType: string, payload: JsonValue): MemorySourceChannel {
  if (eventType !== "conversation.user_committed"
    && eventType !== "conversation.assistant_delivered") return "system";
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) corrupt();
  const channelCode = payload.channelCode;
  if (channelCode === 1) return "voice";
  if (channelCode === 2) return "telegram";
  corrupt();
}

function topicComponent(value: unknown): { readonly display: string; readonly normalized: string } {
  if (typeof value !== "string") refuse();
  const display = value.normalize("NFC").trim();
  if (display.length === 0 || utf8.encode(display).byteLength > 256 || hasFactTextControls(display)) refuse();
  return { display, normalized: normalizedTopicName(display) };
}

function isConstraintRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:constraint failed|unique constraint|memory_[a-z0-9_]+_(?:invalid|requires_event|forbidden))/iu
    .test(error.message);
}

function freezePath(path: readonly CanonicalTopicPathEntry[]): readonly CanonicalTopicPathEntry[] {
  return Object.freeze(path.map((entry) => Object.freeze({ ...entry })));
}

function topicEntry(topic: ValidatedTopic): CanonicalTopicPathEntry {
  return Object.freeze({ topicId: topic.topicId, displayName: topic.displayName });
}

function sameNullable(left: unknown, right: unknown): boolean {
  return left === right;
}

function validateTopicRow(row: TopicRow, principalId: string): ValidatedTopic {
  exactRow(row, topicFields);
  const topicId = rowUlid(row.topic_id);
  const parentTopicId = optionalRowUlid(row.parent_topic_id);
  const status = rowEnum(row.status, new Set(["active", "merged"] as const));
  const redirectToTopicId = optionalRowUlid(row.redirect_to_topic_id);
  if ((status === "active" && redirectToTopicId !== null)
    || (status === "merged" && (redirectToTopicId === null || redirectToTopicId === topicId))) corrupt();
  const displayName = safeRowText(row.display_name, 256);
  const normalizedName = safeRowText(row.normalized_name, 256);
  if (normalizedName !== normalizedTopicName(displayName)) corrupt();
  const createdAt = rowTimestamp(row.created_at);
  const updatedAt = rowTimestamp(row.updated_at);
  if (updatedAt < createdAt) corrupt();
  return {
    topicId,
    principalId: rowPrincipal(row.principal_id, principalId),
    parentTopicId,
    displayName,
    normalizedName,
    status,
    redirectToTopicId,
    lastTopicEventId: rowUlid(row.last_topic_event_id),
    createdAt,
    updatedAt,
  };
}

function captureInput(input: CommitInitialMemoryInput): CapturedInput {
  const principalId = safeInputText(input.principalId, 256);
  const kind = inputEnum(input.kind, new Set([
    "fact", "preference", "plan", "decision", "relationship",
  ] as const));
  const basis = inputEnum(input.version.basis, new Set([
    "stated", "confirmed", "observed", "inferred", "third_party",
  ] as const));
  const origin = inputEnum(input.version.origin, new Set([
    "authenticated_first_person", "deterministic_observation", "model", "third_party",
  ] as const));
  const sensitivity = inputEnum(input.version.sensitivity, new Set(["normal", "sensitive"] as const));
  if (typeof input.version.uncertain !== "boolean") refuse();
  if ((origin === "model" && (!input.version.uncertain || basis !== "inferred" || input.version.extractorModelId === null))
    || (origin === "third_party" && (!input.version.uncertain || basis !== "third_party"))
    || ((basis === "inferred" || basis === "third_party") && !input.version.uncertain)) refuse();
  const validFrom = input.version.validFrom === null ? null : inputTimestamp(input.version.validFrom);
  const validTo = input.version.validTo === null ? null : inputTimestamp(input.version.validTo);
  if (validFrom !== null && validTo !== null && validTo <= validFrom) refuse();
  const extractorModelId = optionalInputText(input.version.extractorModelId, 192);
  if (extractorModelId !== null && !PROVIDER_MODEL.test(extractorModelId)) refuse();
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 8) refuse();
  const sources = input.sources.map((source) => {
    const sourceLocation = inputEnum(source.sourceLocation, new Set(["live", "archived"] as const));
    const r2SegmentId = source.r2SegmentId === null ? null : inputHash(source.r2SegmentId);
    if ((sourceLocation === "live" && r2SegmentId !== null)
      || (sourceLocation === "archived" && r2SegmentId === null)) refuse();
    return Object.freeze({
      sourceId: inputUlid(source.sourceId),
      eventId: inputUlid(source.eventId),
      eventSequence: inputInteger(source.eventSequence, 1, Number.MAX_SAFE_INTEGER),
      sourceLocation,
      r2SegmentId,
      excerpt: safeInputText(source.excerpt, 8192),
      excerptHash: inputHash(source.excerptHash),
      channel: inputEnum(source.channel, new Set(["telegram", "voice", "system"] as const)),
      occurredAt: inputTimestamp(source.occurredAt),
    });
  });
  if (new Set(sources.map((source) => source.sourceId)).size !== sources.length
    || new Set(sources.map((source) => source.eventId)).size !== sources.length) refuse();
  const filingSource = inputEnum(input.placement.filingSource, new Set(["rule", "model"] as const));
  if (!Number.isFinite(input.placement.confidence)
    || input.placement.confidence < 0 || input.placement.confidence > 1) refuse();
  return Object.freeze({
    principalId,
    itemId: inputUlid(input.itemId),
    kind,
    creationEventId: inputUlid(input.creationEventId),
    creationEventSequence: inputInteger(input.creationEventSequence, 1, Number.MAX_SAFE_INTEGER),
    version: Object.freeze({
      versionId: inputUlid(input.version.versionId),
      text: safeInputText(input.version.text, 4096),
      textHash: inputHash(input.version.textHash),
      basis,
      origin,
      uncertain: input.version.uncertain,
      sensitivity,
      validFrom,
      validTo,
      extractorVersion: safeInputText(input.version.extractorVersion, 128),
      extractorModelId,
    }),
    sources: Object.freeze(sources),
    transition: Object.freeze({
      transitionId: inputUlid(input.transition.transitionId),
      lifecycleState: inputEnum(input.transition.lifecycleState, new Set(["proposed", "active"] as const)),
      reason: safeInputText(input.transition.reason, 512),
      policyVersion: safeInputText(input.transition.policyVersion, 128),
    }),
    placement: Object.freeze({
      placementId: inputUlid(input.placement.placementId),
      placementEventId: inputUlid(input.placement.placementEventId),
      topicId: inputUlid(input.placement.topicId),
      filingSource,
      confidence: input.placement.confidence,
      reason: safeInputText(input.placement.reason, 512),
    }),
  });
}

export class MemoryRepository {
  private readonly transactions: TransactionRunner;
  private readonly clock: () => Date;
  private readonly idFactory: (now: Date) => Ulid;
  private readonly maximumWriteAttempts: number;
  private readonly beforeBatch: NonNullable<MemoryRepositoryOptions["beforeBatch"]>;
  private readonly batchFault: NonNullable<MemoryRepositoryOptions["batchFault"]>;

  constructor(
    private readonly database: D1Database,
    options: MemoryRepositoryOptions = {},
  ) {
    this.transactions = new TransactionRunner(database);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? newUlid;
    this.maximumWriteAttempts = options.maximumWriteAttempts ?? 2;
    if (!Number.isSafeInteger(this.maximumWriteAttempts)
      || this.maximumWriteAttempts < 1 || this.maximumWriteAttempts > 3) refuse();
    this.beforeBatch = options.beforeBatch ?? (() => undefined);
    this.batchFault = options.batchFault ?? (() => null);
  }

  async bootstrapTopics(principalIdInput: string): Promise<BootstrapMemoryTopicsResult> {
    return this.safely(async () => {
      const principalId = safeInputText(principalIdInput, 256);
      await this.requireActivePrincipal(principalId);
      const existing = await this.readBootstrapTopics(principalId);
      if (existing !== null) return { ...existing, replayed: true };

      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maximumWriteAttempts; attempt += 1) {
        const partial = await this.readBootstrapState(principalId);
        const statements: D1PreparedStatement[] = [];
        let root = partial.root;
        if (root === null) {
          const now = this.freshNow();
          const topicId = inputUlid(this.idFactory(now));
          statements.push(this.createTopicStatement(
            principalId,
            topicId,
            null,
            MEMORY_ROOT_DISPLAY_NAME,
            inputUlid(this.idFactory(now)),
            now.toISOString(),
            "bootstrap canonical memory root",
          ));
          root = {
            topicId,
            principalId,
            parentTopicId: null,
            displayName: MEMORY_ROOT_DISPLAY_NAME,
            normalizedName: normalizedTopicName(MEMORY_ROOT_DISPLAY_NAME),
            status: "active",
            redirectToTopicId: null,
            lastTopicEventId: topicId,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          };
        }
        if (partial.inbox === null) {
          const now = this.freshNow();
          statements.push(this.createTopicStatement(
            principalId,
            inputUlid(this.idFactory(now)),
            root.topicId,
            MEMORY_INBOX_DISPLAY_NAME,
            inputUlid(this.idFactory(now)),
            now.toISOString(),
            "bootstrap explicit low-confidence inbox",
          ));
        }
        const fault = this.batchFault("bootstrap", attempt);
        if (fault !== null) statements.push(fault);
        try {
          await this.beforeBatch("bootstrap", attempt);
          await this.transactions.batch(statements);
          const completed = await this.readBootstrapTopics(principalId);
          if (completed === null) corrupt();
          return { ...completed, replayed: false };
        } catch (error) {
          lastError = error;
          const winner = await this.readBootstrapTopics(principalId);
          if (winner !== null) return { ...winner, replayed: true };
        }
      }
      throw new MemoryRepositoryError(isConstraintRefusal(lastError) ? "memory_refused" : "memory_unavailable");
    });
  }

  async commitInitialItem(input: CommitInitialMemoryInput): Promise<CommitInitialMemoryResult> {
    return this.safely(async () => {
      const captured = captureInput(input);
      await this.validateHashes(captured);
      await this.requireActivePrincipal(captured.principalId);
      const replay = await this.inspectReplay(captured);
      if (replay === "exact") {
        return { item: await this.readCurrentItemInternal(captured.principalId, captured.itemId), replayed: true };
      }
      if (replay === "conflict") refuse();

      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maximumWriteAttempts; attempt += 1) {
        await this.validateSourceReceipts(captured);
        await this.requireActiveTopic(captured.principalId, captured.placement.topicId);
        const createdAt = this.freshNow().toISOString();
        const transitionAt = this.freshNow().toISOString();
        const placementAt = this.freshNow().toISOString();
        const statements = this.initialItemStatements(
          captured,
          createdAt,
          transitionAt,
          placementAt,
        );
        const fault = this.batchFault("commit", attempt);
        if (fault !== null) statements.push(fault);
        try {
          await this.beforeBatch("commit", attempt);
          await this.transactions.batch(statements);
          return {
            item: await this.readCurrentItemInternal(captured.principalId, captured.itemId),
            replayed: false,
          };
        } catch (error) {
          lastError = error;
          const afterFailure = await this.inspectReplay(captured);
          if (afterFailure === "exact") {
            return {
              item: await this.readCurrentItemInternal(captured.principalId, captured.itemId),
              replayed: true,
            };
          }
          if (afterFailure === "conflict") refuse();
        }
      }
      throw new MemoryRepositoryError(isConstraintRefusal(lastError) ? "memory_refused" : "memory_unavailable");
    });
  }

  async readCurrentItem(principalIdInput: string, itemIdInput: Ulid): Promise<CanonicalMemoryItem> {
    return this.safely(async () => {
      const principalId = safeInputText(principalIdInput, 256);
      const itemId = inputUlid(itemIdInput);
      return this.readCurrentItemInternal(principalId, itemId);
    });
  }

  async resolveTopicPath(
    principalIdInput: string,
    pathInput: readonly string[],
  ): Promise<ResolvedMemoryTopic> {
    return this.safely(async () => {
      const principalId = safeInputText(principalIdInput, 256);
      if (!Array.isArray(pathInput) || pathInput.length < 1 || pathInput.length > 64) refuse();
      const components = pathInput.map(topicComponent);
      const current = await this.resolveCurrentPath(principalId, components.map((part) => part.normalized));
      if (current !== null) {
        return Object.freeze({
          topicId: current.topicId,
          path: await this.readTopicPath(principalId, current.topicId),
          matchedBy: "current" as const,
        });
      }
      const alias = await this.resolveAlias(
        principalId,
        components.at(-1)?.normalized ?? "",
        components.map((part) => part.display).join("/"),
      );
      if (alias === null) throw new MemoryRepositoryError("memory_not_found");
      const topicId = await this.followRedirects(principalId, alias);
      return Object.freeze({
        topicId,
        path: await this.readTopicPath(principalId, topicId),
        matchedBy: "alias" as const,
      });
    });
  }

  private async safely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryRepositoryError) throw error;
      throw new MemoryRepositoryError("memory_unavailable");
    }
  }

  private freshNow(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) refuse();
    return new Date(now.valueOf());
  }

  private async requireActivePrincipal(principalId: string): Promise<void> {
    const row = await this.database.prepare(
      "SELECT principal_id, status FROM principals WHERE principal_id = ?",
    ).bind(principalId).first<PrincipalRow>();
    if (row === null) refuse();
    exactRow(row, new Set(["principal_id", "status"]));
    if (row.principal_id !== principalId || row.status !== "active") refuse();
  }

  private createTopicStatement(
    principalId: string,
    topicId: Ulid,
    parentTopicId: Ulid | null,
    displayName: string,
    topicEventId: Ulid,
    occurredAt: string,
    reason: string,
  ): D1PreparedStatement {
    return this.database.prepare(`INSERT INTO memory_topic_events (
      topic_event_id, principal_id, topic_id, operation,
      previous_parent_topic_id, new_parent_topic_id,
      previous_display_name, previous_normalized_name,
      new_display_name, new_normalized_name, merge_target_topic_id,
      reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
      reason, actor, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 'create', NULL, ?, NULL, NULL, ?, ?, NULL,
      '[]', '[]', '[]', ?, 'rules', NULL, ?)`)
      .bind(
        topicEventId,
        principalId,
        topicId,
        parentTopicId,
        displayName,
        normalizedTopicName(displayName),
        reason,
        occurredAt,
      );
  }

  private async readBootstrapState(
    principalId: string,
  ): Promise<{ readonly root: ValidatedTopic | null; readonly inbox: ValidatedTopic | null }> {
    const roots = await this.database.prepare(`SELECT
      topic_id, principal_id, parent_topic_id, display_name, normalized_name,
      status, redirect_to_topic_id, last_topic_event_id, created_at, updated_at
      FROM memory_topics
      WHERE principal_id = ? AND parent_topic_id IS NULL`)
      .bind(principalId).all<TopicRow>();
    if (roots.results.length > 1) corrupt();
    const root = roots.results[0] === undefined ? null : validateTopicRow(roots.results[0], principalId);
    if (root !== null && (root.status !== "active"
      || root.displayName !== MEMORY_ROOT_DISPLAY_NAME
      || root.normalizedName !== normalizedTopicName(MEMORY_ROOT_DISPLAY_NAME))) refuse();
    if (root === null) return { root: null, inbox: null };
    const inboxes = await this.database.prepare(`SELECT
      topic_id, principal_id, parent_topic_id, display_name, normalized_name,
      status, redirect_to_topic_id, last_topic_event_id, created_at, updated_at
      FROM memory_topics
      WHERE principal_id = ? AND parent_topic_id = ? AND status = 'active'
        AND normalized_name = ?`)
      .bind(principalId, root.topicId, normalizedTopicName(MEMORY_INBOX_DISPLAY_NAME))
      .all<TopicRow>();
    if (inboxes.results.length > 1) corrupt();
    const inbox = inboxes.results[0] === undefined
      ? null
      : validateTopicRow(inboxes.results[0], principalId);
    if (inbox !== null && (inbox.parentTopicId !== root.topicId
      || inbox.displayName !== MEMORY_INBOX_DISPLAY_NAME)) refuse();
    return { root, inbox };
  }

  private async readBootstrapTopics(
    principalId: string,
  ): Promise<Omit<BootstrapMemoryTopicsResult, "replayed"> | null> {
    const state = await this.readBootstrapState(principalId);
    if (state.root === null || state.inbox === null) return null;
    return Object.freeze({ root: topicEntry(state.root), inbox: topicEntry(state.inbox) });
  }

  private async validateHashes(input: CapturedInput): Promise<void> {
    if (await sha256Hex(input.version.text) !== input.version.textHash) refuse();
    for (const source of input.sources) {
      if (await sha256Hex(source.excerpt) !== source.excerptHash) refuse();
    }
  }

  private async validateSourceReceipts(input: CapturedInput): Promise<void> {
    await this.validateReceipt(
      input.principalId,
      input.creationEventId,
      input.creationEventSequence,
      null,
    );
    for (const source of input.sources) {
      await this.validateReceipt(
        input.principalId,
        source.eventId,
        source.eventSequence,
        source,
      );
    }
  }

  private async validateReceipt(
    principalId: string,
    eventId: Ulid,
    eventSequence: number,
    source: SourceReceiptExpectation | null,
  ): Promise<void> {
    const sourceLocation = source?.sourceLocation ?? null;
    const r2SegmentId = source?.r2SegmentId ?? null;
    if (sourceLocation !== "archived") {
      const row = await this.database.prepare(`SELECT event_id, sequence, subject_id, occurred_at,
        event_type, content_hash, envelope_json
        FROM events WHERE event_id = ? AND sequence = ? AND subject_id = ?`)
        .bind(eventId, eventSequence, principalId).first<EventReceiptRow>();
      if (row !== null) {
        exactRow(row, eventReceiptFields);
        if (rowUlid(row.event_id) !== eventId
          || rowInteger(row.sequence, 1, Number.MAX_SAFE_INTEGER) !== eventSequence
          || rowPrincipal(row.subject_id, principalId) !== principalId
          || (source !== null && rowTimestamp(row.occurred_at) !== source.occurredAt)) refuse();
        await this.validateLiveEventEvidence(row, principalId, eventId, source);
        return;
      }
      if (sourceLocation === "live") refuse();
    }
    const archived = await this.database.prepare(`SELECT event_id, event_sequence, segment_id
      FROM archive_segment_events
      WHERE event_id = ? AND event_sequence = ?
        AND (? IS NULL OR segment_id = ?)`)
      .bind(eventId, eventSequence, r2SegmentId, r2SegmentId).first<ArchivedReceiptRow>();
    if (archived === null) refuse();
    exactRow(archived, new Set(["event_id", "event_sequence", "segment_id"]));
    if (rowUlid(archived.event_id) !== eventId
      || rowInteger(archived.event_sequence, 1, Number.MAX_SAFE_INTEGER) !== eventSequence
      || (r2SegmentId !== null && rowHash(archived.segment_id) !== r2SegmentId)) refuse();
  }

  private async requireActiveTopic(principalId: string, topicId: Ulid): Promise<void> {
    const row = await this.readTopic(principalId, topicId);
    if (row === null || row.status !== "active") refuse();
  }

  private initialItemStatements(
    input: CapturedInput,
    createdAt: string,
    transitionAt: string,
    placementAt: string,
  ): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`INSERT INTO memory_items (
        item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(
          input.itemId,
          input.principalId,
          input.kind,
          input.creationEventId,
          input.creationEventSequence,
          createdAt,
        ),
      this.database.prepare(`INSERT INTO memory_item_versions (
        version_id, principal_id, item_id, version_number, text, text_normalization,
        text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
        extractor_version, extractor_model_id, created_at
      ) VALUES (?, ?, ?, 1, ?, 'NFC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          input.version.versionId,
          input.principalId,
          input.itemId,
          input.version.text,
          input.version.textHash,
          input.version.basis,
          input.version.origin,
          input.version.uncertain ? 1 : 0,
          input.version.sensitivity,
          input.version.validFrom,
          input.version.validTo,
          input.version.extractorVersion,
          input.version.extractorModelId,
          createdAt,
        ),
    ];
    input.sources.forEach((source, position) => {
      statements.push(this.database.prepare(`INSERT INTO memory_item_sources (
        source_id, principal_id, item_id, version_id, source_position, event_id,
        event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
        channel, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          source.sourceId,
          input.principalId,
          input.itemId,
          input.version.versionId,
          position,
          source.eventId,
          source.eventSequence,
          source.sourceLocation,
          source.r2SegmentId,
          source.excerpt,
          source.excerptHash,
          source.channel,
          source.occurredAt,
          createdAt,
        ));
    });
    statements.push(
      this.database.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, 'rules', ?, NULL, ?)`)
        .bind(
          input.transition.transitionId,
          input.principalId,
          input.itemId,
          input.version.versionId,
          input.transition.lifecycleState,
          input.transition.reason,
          input.transition.policyVersion,
          transitionAt,
        ),
      this.database.prepare(`INSERT INTO memory_item_placement_events (
        placement_event_id, principal_id, placement_id, placement_event_number, item_id,
        operation, previous_topic_id, new_topic_id, relation, filing_source,
        confidence, reason, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 1, ?, 'place', NULL, ?, 'primary', ?, ?, ?, NULL, ?)`)
        .bind(
          input.placement.placementEventId,
          input.principalId,
          input.placement.placementId,
          input.itemId,
          input.placement.topicId,
          input.placement.filingSource,
          input.placement.confidence,
          input.placement.reason,
          placementAt,
        ),
    );
    return statements;
  }

  private async inspectReplay(input: CapturedInput): Promise<"absent" | "exact" | "conflict"> {
    const sourcePlaceholders = input.sources.map(() => "?").join(", ");
    const [items, versions, sources, transitions, placements] = await Promise.all([
      this.database.prepare(`SELECT item_id, principal_id, kind, creation_event_id,
        creation_event_sequence, created_at FROM memory_items
        WHERE principal_id = ? AND item_id = ?`)
        .bind(input.principalId, input.itemId).all<ItemRow>(),
      this.database.prepare(`SELECT version_id, principal_id, item_id, version_number, text,
        text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
        extractor_version, extractor_model_id, created_at FROM memory_item_versions
        WHERE principal_id = ? AND (version_id = ? OR (item_id = ? AND version_number = 1))`)
        .bind(input.principalId, input.version.versionId, input.itemId).all<VersionRow>(),
      this.database.prepare(`SELECT source_id, principal_id, item_id, version_id, source_position,
        event_id, event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
        channel, occurred_at, created_at FROM memory_item_sources
        WHERE principal_id = ? AND (version_id = ? OR source_id IN (${sourcePlaceholders}))`)
        .bind(
          input.principalId,
          input.version.versionId,
          ...input.sources.map((source) => source.sourceId),
        ).all<SourceRow>(),
      this.database.prepare(`SELECT transition_id, principal_id, item_id, transition_number,
        version_id, lifecycle_state, reason, actor, policy_version,
        owner_authorizing_event_id, occurred_at FROM memory_item_transitions
        WHERE principal_id = ? AND (transition_id = ? OR (item_id = ? AND transition_number = 1))`)
        .bind(input.principalId, input.transition.transitionId, input.itemId).all<TransitionRow>(),
      this.database.prepare(`SELECT placement_event_id, principal_id, placement_id,
        placement_event_number, item_id, operation, previous_topic_id, new_topic_id,
        relation, filing_source, confidence, reason, owner_authorizing_event_id, occurred_at
        FROM memory_item_placement_events
        WHERE principal_id = ? AND (placement_event_id = ? OR placement_id = ?)`)
        .bind(
          input.principalId,
          input.placement.placementEventId,
          input.placement.placementId,
        ).all<PlacementEventRow>(),
    ]);
    const count = items.results.length + versions.results.length + sources.results.length
      + transitions.results.length + placements.results.length;
    if (count === 0) return "absent";
    if (items.results.length !== 1 || versions.results.length !== 1
      || sources.results.length !== input.sources.length
      || transitions.results.length !== 1 || placements.results.length !== 1) return "conflict";
    const item = items.results[0];
    const version = versions.results[0];
    const transition = transitions.results[0];
    const placement = placements.results[0];
    if (item === undefined || version === undefined || transition === undefined || placement === undefined) corrupt();
    exactRow(item, itemFields);
    exactRow(version, versionFields);
    exactRow(transition, transitionFields);
    exactRow(placement, placementEventFields);
    rowTimestamp(item.created_at);
    rowTimestamp(version.created_at);
    rowTimestamp(transition.occurred_at);
    rowTimestamp(placement.occurred_at);
    if (item.item_id !== input.itemId || item.principal_id !== input.principalId
      || item.kind !== input.kind || item.creation_event_id !== input.creationEventId
      || item.creation_event_sequence !== input.creationEventSequence
      || version.version_id !== input.version.versionId || version.principal_id !== input.principalId
      || version.item_id !== input.itemId || version.version_number !== 1
      || version.text !== input.version.text || version.text_hash !== input.version.textHash
      || version.basis !== input.version.basis || version.origin !== input.version.origin
      || version.uncertain !== (input.version.uncertain ? 1 : 0)
      || version.sensitivity !== input.version.sensitivity
      || !sameNullable(version.valid_from, input.version.validFrom)
      || !sameNullable(version.valid_to, input.version.validTo)
      || version.extractor_version !== input.version.extractorVersion
      || !sameNullable(version.extractor_model_id, input.version.extractorModelId)
      || transition.transition_id !== input.transition.transitionId
      || transition.principal_id !== input.principalId || transition.item_id !== input.itemId
      || transition.transition_number !== 1 || transition.version_id !== input.version.versionId
      || transition.lifecycle_state !== input.transition.lifecycleState
      || transition.reason !== input.transition.reason || transition.actor !== "rules"
      || transition.policy_version !== input.transition.policyVersion
      || transition.owner_authorizing_event_id !== null
      || placement.placement_event_id !== input.placement.placementEventId
      || placement.principal_id !== input.principalId
      || placement.placement_id !== input.placement.placementId
      || placement.placement_event_number !== 1 || placement.item_id !== input.itemId
      || placement.operation !== "place" || placement.previous_topic_id !== null
      || placement.new_topic_id !== input.placement.topicId || placement.relation !== "primary"
      || placement.filing_source !== input.placement.filingSource
      || placement.confidence !== input.placement.confidence
      || placement.reason !== input.placement.reason
      || placement.owner_authorizing_event_id !== null) return "conflict";
    const sorted = [...sources.results].sort((left, right) =>
      Number(left.source_position) - Number(right.source_position));
    for (let position = 0; position < sorted.length; position += 1) {
      const row = sorted[position];
      const expected = input.sources[position];
      if (row === undefined || expected === undefined) corrupt();
      exactRow(row, sourceFields);
      rowTimestamp(row.created_at);
      if (row.source_id !== expected.sourceId || row.principal_id !== input.principalId
        || row.item_id !== input.itemId || row.version_id !== input.version.versionId
        || row.source_position !== position || row.event_id !== expected.eventId
        || row.event_sequence !== expected.eventSequence
        || row.source_location !== expected.sourceLocation
        || !sameNullable(row.r2_segment_id, expected.r2SegmentId)
        || row.excerpt !== expected.excerpt || row.excerpt_hash !== expected.excerptHash
        || row.channel !== expected.channel || row.occurred_at !== expected.occurredAt) return "conflict";
    }
    return "exact";
  }

  private async readCurrentItemInternal(principalId: string, itemId: Ulid): Promise<CanonicalMemoryItem> {
    const row = await this.database.prepare(`SELECT
      item.item_id, item.principal_id, item.kind, item.creation_event_id,
      item.creation_event_sequence, item.created_at AS item_created_at,
      version.version_id, version.item_id AS version_item_id, version.version_number, version.text,
      version.text_hash, version.basis, version.origin, version.uncertain,
      version.sensitivity, version.valid_from, version.valid_to,
      version.extractor_version, version.extractor_model_id,
      version.created_at AS version_created_at,
      transition.transition_id, transition.item_id AS transition_item_id,
      transition.transition_number, transition.version_id AS transition_version_id,
      transition.lifecycle_state, transition.reason, transition.actor,
      transition.policy_version, transition.owner_authorizing_event_id,
      transition.occurred_at,
      state.current_version_id AS state_current_version_id,
      state.lifecycle_state AS state_lifecycle_state,
      state.last_transition_id AS state_last_transition_id,
      state.last_transition_number AS state_last_transition_number,
      state.updated_at AS state_updated_at,
      placement.placement_id, placement.item_id AS placement_item_id,
      placement.topic_id AS placement_topic_id,
      placement.relation AS placement_relation, placement.status AS placement_status,
      placement.last_event_kind AS placement_last_event_kind,
      placement.last_event_id AS placement_last_event_id,
      placement.last_placement_event_number AS placement_last_event_number,
      placement.updated_at AS placement_updated_at,
      placement_event.placement_event_id AS placement_event_id,
      placement_event.item_id AS placement_event_item_id,
      placement_event.placement_event_number AS placement_event_number,
      placement_event.operation AS placement_event_operation,
      placement_event.new_topic_id AS placement_event_new_topic_id,
      placement_event.filing_source, placement_event.confidence,
      placement_event.reason AS placement_reason
      FROM memory_items item
      JOIN memory_item_state state
        ON state.principal_id = item.principal_id AND state.item_id = item.item_id
      JOIN memory_item_versions version
        ON version.principal_id = state.principal_id
        AND version.version_id = state.current_version_id
      JOIN memory_item_transitions transition
        ON transition.principal_id = state.principal_id
        AND transition.transition_id = state.last_transition_id
      JOIN memory_item_placement_state placement
        ON placement.principal_id = item.principal_id AND placement.item_id = item.item_id
        AND placement.relation = 'primary' AND placement.status = 'active'
      JOIN memory_item_placement_events placement_event
        ON placement_event.principal_id = placement.principal_id
        AND placement_event.placement_id = placement.placement_id
        AND placement_event.placement_event_number = placement.last_placement_event_number
      WHERE item.principal_id = ? AND item.item_id = ?`)
      .bind(principalId, itemId).all<CanonicalRow>();
    if (row.results.length === 0) {
      const partial = await this.database.prepare(`SELECT item_id, principal_id, kind,
        creation_event_id, creation_event_sequence, created_at FROM memory_items
        WHERE principal_id = ? AND item_id = ?`)
        .bind(principalId, itemId).all<ItemRow>();
      if (partial.results.length === 0) throw new MemoryRepositoryError("memory_not_found");
      if (partial.results.length !== 1) corrupt();
      const existing = partial.results[0];
      if (existing === undefined) corrupt();
      exactRow(existing, itemFields);
      if (rowUlid(existing.item_id) !== itemId) corrupt();
      rowPrincipal(existing.principal_id, principalId);
      rowEnum(existing.kind, new Set([
        "fact", "preference", "plan", "decision", "relationship",
      ] as const));
      rowUlid(existing.creation_event_id);
      rowInteger(existing.creation_event_sequence, 1, Number.MAX_SAFE_INTEGER);
      rowTimestamp(existing.created_at);
      corrupt();
    }
    if (row.results.length !== 1) corrupt();
    const stored = row.results[0];
    if (stored === undefined) corrupt();
    exactRow(stored, canonicalFields);
    const canonical = await this.validateCanonicalRow(stored, principalId, itemId);
    const sources = await this.readSources(principalId, itemId, canonical.version.versionId);
    const topicPath = await this.readTopicPath(principalId, canonical.primaryPlacement.topicId);
    return Object.freeze({
      ...canonical,
      sources: Object.freeze(sources),
      topicPath,
    });
  }

  private async validateCanonicalRow(
    row: CanonicalRow,
    principalId: string,
    itemId: Ulid,
  ): Promise<Omit<CanonicalMemoryItem, "sources" | "topicPath">> {
    const storedItemId = rowUlid(row.item_id);
    if (storedItemId !== itemId) corrupt();
    rowPrincipal(row.principal_id, principalId);
    const kind = rowEnum(row.kind, new Set([
      "fact", "preference", "plan", "decision", "relationship",
    ] as const));
    const creationEventId = rowUlid(row.creation_event_id);
    const creationEventSequence = rowInteger(row.creation_event_sequence, 1, Number.MAX_SAFE_INTEGER);
    const createdAt = rowTimestamp(row.item_created_at);
    await this.validateStoredCreationReceipt(principalId, creationEventId, creationEventSequence);
    const versionId = rowUlid(row.version_id);
    const text = safeRowText(row.text, 4096);
    const textHash = rowHash(row.text_hash);
    if (await sha256Hex(text) !== textHash) corrupt();
    const basis = rowEnum(row.basis, new Set([
      "stated", "confirmed", "observed", "inferred", "third_party",
    ] as const));
    const origin = rowEnum(row.origin, new Set([
      "authenticated_first_person", "deterministic_observation", "model", "third_party",
    ] as const));
    const uncertainInteger = rowInteger(row.uncertain, 0, 1);
    const sensitivity = rowEnum(row.sensitivity, new Set(["normal", "sensitive"] as const));
    const validFrom = row.valid_from === null ? null : rowTimestamp(row.valid_from);
    const validTo = row.valid_to === null ? null : rowTimestamp(row.valid_to);
    if (validFrom !== null && validTo !== null && validTo <= validFrom) corrupt();
    const extractorVersion = safeRowText(row.extractor_version, 128);
    const extractorModelId = optionalRowText(row.extractor_model_id, 192);
    if (extractorModelId !== null && !PROVIDER_MODEL.test(extractorModelId)) corrupt();
    if ((origin === "model" && (uncertainInteger !== 1 || basis !== "inferred" || extractorModelId === null))
      || (origin === "third_party" && (uncertainInteger !== 1 || basis !== "third_party"))
      || ((basis === "inferred" || basis === "third_party") && uncertainInteger !== 1)) corrupt();
    if (rowUlid(row.version_item_id) !== itemId
      || rowUlid(row.transition_item_id) !== itemId
      || rowUlid(row.transition_version_id) !== versionId) corrupt();
    const lifecycleState = rowEnum(row.lifecycle_state, new Set([
      "proposed", "active", "rejected", "superseded", "forgotten", "expired",
    ] as const));
    const actor = rowEnum(row.actor, new Set(["owner", "rules"] as const));
    const ownerAuthorizingEventId = optionalRowUlid(row.owner_authorizing_event_id);
    if ((actor === "owner") !== (ownerAuthorizingEventId !== null)) corrupt();
    const occurredAt = rowTimestamp(row.occurred_at);
    const transitionId = rowUlid(row.transition_id);
    const transitionNumber = rowInteger(row.transition_number, 1, Number.MAX_SAFE_INTEGER);
    if (rowUlid(row.state_current_version_id) !== versionId
      || rowEnum(row.state_lifecycle_state, new Set([
        "proposed", "active", "rejected", "superseded", "forgotten", "expired",
      ] as const)) !== lifecycleState
      || rowUlid(row.state_last_transition_id) !== transitionId
      || rowInteger(row.state_last_transition_number, 1, Number.MAX_SAFE_INTEGER) !== transitionNumber
      || rowTimestamp(row.state_updated_at) !== occurredAt) corrupt();
    const placementId = rowUlid(row.placement_id);
    const placementTopicId = rowUlid(row.placement_topic_id);
    const placementEventId = rowUlid(row.placement_event_id);
    const placementEventNumber = rowInteger(row.placement_event_number, 1, Number.MAX_SAFE_INTEGER);
    const placementEventTopicId = rowUlid(row.placement_event_new_topic_id);
    rowEnum(row.placement_event_operation, new Set(["place", "refile"] as const));
    const placementLastEventKind = rowEnum(row.placement_last_event_kind, new Set(["placement", "topic"] as const));
    const placementLastEventId = rowUlid(row.placement_last_event_id);
    if (rowUlid(row.placement_item_id) !== itemId
      || rowEnum(row.placement_relation, new Set(["primary", "related"] as const)) !== "primary"
      || rowEnum(row.placement_status, new Set(["active", "removed"] as const)) !== "active"
      || rowUlid(row.placement_event_item_id) !== itemId
      || rowInteger(row.placement_last_event_number, 1, Number.MAX_SAFE_INTEGER) !== placementEventNumber
      || (placementLastEventKind === "placement" && (
        placementLastEventId !== placementEventId
        || placementEventTopicId !== placementTopicId
      ))) corrupt();
    return Object.freeze({
      principalId,
      itemId,
      kind,
      creationEventId,
      creationEventSequence,
      createdAt,
      version: Object.freeze({
        versionId,
        versionNumber: rowInteger(row.version_number, 1, Number.MAX_SAFE_INTEGER),
        text,
        textHash,
        basis,
        origin,
        uncertain: uncertainInteger === 1,
        sensitivity,
        validFrom,
        validTo,
        extractorVersion,
        extractorModelId,
        createdAt: rowTimestamp(row.version_created_at),
      }),
      lifecycle: Object.freeze({
        state: lifecycleState,
        transitionId,
        transitionNumber,
        actor,
        reason: safeRowText(row.reason, 512),
        policyVersion: safeRowText(row.policy_version, 128),
        ownerAuthorizingEventId,
        occurredAt,
      }),
      primaryPlacement: Object.freeze({
        placementId,
        topicId: placementTopicId,
        filingSource: rowEnum(row.filing_source, new Set(["owner", "rule", "model"] as const)),
        confidence: this.rowConfidence(row.confidence),
        reason: safeRowText(row.placement_reason, 512),
        updatedAt: rowTimestamp(row.placement_updated_at),
      }),
    });
  }

  private rowConfidence(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) corrupt();
    return value;
  }

  private async validateStoredCreationReceipt(
    principalId: string,
    eventId: Ulid,
    eventSequence: number,
  ): Promise<void> {
    try {
      await this.validateReceipt(principalId, eventId, eventSequence, null);
    } catch (error) {
      if (error instanceof MemoryRepositoryError && error.code === "memory_refused") corrupt();
      throw error;
    }
  }

  private async validateLiveEventEvidence(
    row: EventReceiptRow,
    principalId: string,
    eventId: Ulid,
    source: SourceReceiptExpectation | null,
  ): Promise<void> {
    const eventType = safeRowText(row.event_type, 262_144);
    const contentHash = rowHash(row.content_hash);
    if (typeof row.envelope_json !== "string" || row.envelope_json.length === 0
      || !row.envelope_json.isWellFormed()
      || utf8.encode(row.envelope_json).byteLength > 262_144) corrupt();
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.envelope_json) as unknown;
    } catch {
      corrupt();
    }
    let envelope: Awaited<ReturnType<typeof validateEnvelope>>;
    try {
      envelope = await validateEnvelope(decoded);
    } catch {
      corrupt();
    }
    if (envelope.eventId !== eventId || envelope.eventType !== eventType
      || envelope.subjectId !== principalId || envelope.contentHash !== contentHash
      || envelope.occurredAt !== rowTimestamp(row.occurred_at)) corrupt();
    if (source !== null && (
      liveEventChannel(eventType, envelope.payload) !== source.channel
      || !payloadContainsExactExcerpt(envelope.payload, source.excerpt)
    )) refuse();
  }

  private async readSources(
    principalId: string,
    itemId: Ulid,
    versionId: Ulid,
  ): Promise<readonly CanonicalMemorySource[]> {
    const result = await this.database.prepare(`SELECT source_id, principal_id, item_id,
      version_id, source_position, event_id, event_sequence, source_location,
      r2_segment_id, excerpt, excerpt_hash, channel, occurred_at, created_at
      FROM memory_item_sources
      WHERE principal_id = ? AND item_id = ? AND version_id = ?
      ORDER BY source_position ASC`)
      .bind(principalId, itemId, versionId).all<SourceRow>();
    if (result.results.length < 1 || result.results.length > 8) corrupt();
    const sources: CanonicalMemorySource[] = [];
    for (let position = 0; position < result.results.length; position += 1) {
      const row = result.results[position];
      if (row === undefined) corrupt();
      exactRow(row, sourceFields);
      const sourceId = rowUlid(row.source_id);
      rowPrincipal(row.principal_id, principalId);
      if (rowUlid(row.item_id) !== itemId || rowUlid(row.version_id) !== versionId
        || rowInteger(row.source_position, 0, 7) !== position) corrupt();
      const eventId = rowUlid(row.event_id);
      const eventSequence = rowInteger(row.event_sequence, 1, Number.MAX_SAFE_INTEGER);
      const sourceLocation = rowEnum(row.source_location, new Set(["live", "archived"] as const));
      const r2SegmentId = optionalRowHash(row.r2_segment_id);
      if ((sourceLocation === "live" && r2SegmentId !== null)
        || (sourceLocation === "archived" && r2SegmentId === null)) corrupt();
      const excerpt = safeRowText(row.excerpt, 8192);
      const excerptHash = rowHash(row.excerpt_hash);
      if (await sha256Hex(excerpt) !== excerptHash) corrupt();
      const occurredAt = rowTimestamp(row.occurred_at);
      const channel = rowEnum(row.channel, new Set(["telegram", "voice", "system"] as const));
      try {
        await this.validateReceipt(
          principalId,
          eventId,
          eventSequence,
          { sourceLocation, r2SegmentId, excerpt, channel, occurredAt },
        );
      } catch (error) {
        if (error instanceof MemoryRepositoryError && error.code === "memory_refused") corrupt();
        throw error;
      }
      sources.push(Object.freeze({
        sourceId,
        position,
        eventId,
        eventSequence,
        sourceLocation,
        r2SegmentId,
        excerpt,
        excerptHash,
        channel,
        occurredAt,
        createdAt: rowTimestamp(row.created_at),
      }));
    }
    return sources;
  }

  private async readTopic(principalId: string, topicId: Ulid): Promise<ValidatedTopic | null> {
    const result = await this.database.prepare(`SELECT topic_id, principal_id, parent_topic_id,
      display_name, normalized_name, status, redirect_to_topic_id, last_topic_event_id,
      created_at, updated_at FROM memory_topics
      WHERE principal_id = ? AND topic_id = ?`)
      .bind(principalId, topicId).all<TopicRow>();
    if (result.results.length > 1) corrupt();
    const row = result.results[0];
    return row === undefined ? null : validateTopicRow(row, principalId);
  }

  private async followRedirects(principalId: string, topicId: Ulid): Promise<Ulid> {
    const visited = new Set<Ulid>();
    let currentId = topicId;
    for (let depth = 0; depth < MEMORY_TOPIC_REDIRECT_LIMIT; depth += 1) {
      if (visited.has(currentId)) corrupt();
      visited.add(currentId);
      const topic = await this.readTopic(principalId, currentId);
      if (topic === null) corrupt();
      if (topic.status === "active") return topic.topicId;
      if (topic.redirectToTopicId === null) corrupt();
      currentId = topic.redirectToTopicId;
    }
    corrupt();
  }

  private async readTopicPath(principalId: string, topicId: Ulid): Promise<readonly CanonicalTopicPathEntry[]> {
    const canonicalId = await this.followRedirects(principalId, topicId);
    const path: CanonicalTopicPathEntry[] = [];
    const visited = new Set<Ulid>();
    let currentId: Ulid | null = canonicalId;
    while (currentId !== null && path.length < MEMORY_TOPIC_REDIRECT_LIMIT) {
      if (visited.has(currentId)) corrupt();
      visited.add(currentId);
      const topic = await this.readTopic(principalId, currentId);
      if (topic === null || topic.status !== "active") corrupt();
      path.unshift(topicEntry(topic));
      currentId = topic.parentTopicId;
    }
    if (currentId !== null || path.length === 0) corrupt();
    return freezePath(path);
  }

  private async resolveCurrentPath(
    principalId: string,
    normalizedParts: readonly string[],
  ): Promise<ValidatedTopic | null> {
    let parentTopicId: Ulid | null = null;
    let current: ValidatedTopic | null = null;
    for (const normalizedName of normalizedParts) {
      const result = await this.database.prepare(`SELECT topic_id, principal_id, parent_topic_id,
        display_name, normalized_name, status, redirect_to_topic_id, last_topic_event_id,
        created_at, updated_at FROM memory_topics
        WHERE principal_id = ? AND parent_topic_id IS ?
          AND normalized_name = ? AND status = 'active'`)
        .bind(principalId, parentTopicId, normalizedName).all<TopicRow>();
      if (result.results.length > 1) corrupt();
      const row = result.results[0];
      if (row === undefined) return null;
      current = validateTopicRow(row, principalId);
      if (current.parentTopicId !== parentTopicId || current.normalizedName !== normalizedName) corrupt();
      parentTopicId = current.topicId;
    }
    return current;
  }

  private async resolveAlias(
    principalId: string,
    normalizedAlias: string,
    pathAlias: string,
  ): Promise<Ulid | null> {
    const result = await this.database.prepare(`SELECT alias_id, principal_id, topic_id,
      display_alias, normalized_alias, path_alias, created_by_topic_event_id, created_at
      FROM memory_topic_aliases
      WHERE principal_id = ? AND normalized_alias = ? AND path_alias = ?
      ORDER BY created_at DESC, created_by_topic_event_id DESC, alias_id DESC
      LIMIT 2`)
      .bind(principalId, normalizedAlias, pathAlias).all<AliasRow>();
    for (const row of result.results) {
      exactRow(row, aliasFields);
      rowUlid(row.alias_id);
      rowPrincipal(row.principal_id, principalId);
      rowUlid(row.topic_id);
      safeRowText(row.display_alias, 256);
      if (safeRowText(row.normalized_alias, 256) !== normalizedAlias
        || safeRowText(row.path_alias, 2048) !== pathAlias) corrupt();
      rowUlid(row.created_by_topic_event_id);
      rowTimestamp(row.created_at);
    }
    const newest = result.results[0];
    return newest === undefined ? null : rowUlid(newest.topic_id);
  }
}
