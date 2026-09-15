import {
  canonicalJson,
  createEnvelope,
  issueRedactedUlid,
  newUlid,
  sha256Hex,
  type JsonValue,
  type RedactedJsonValue,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { Redactor } from "../security/redaction.js";
import {
  EventRepository,
  IdempotencyConflict,
  type AppendedEvent,
} from "../persistence/event-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import {
  MemoryRepositoryError,
  type CanonicalMemoryItem,
  type ForgetMemoryItemInput,
  type LiftMemoryItemInput,
  type MemoryKind,
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

export interface RememberMemoryInput {
  readonly ownerTurn: MemoryOwnerTurnInput;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly sensitivity: MemorySensitivity;
}

export interface TargetedMemoryControlInput {
  readonly ownerTurn: MemoryOwnerTurnInput;
  readonly candidateItemIds: readonly Ulid[];
}

export interface MemoryMutationReceipt {
  readonly item: CanonicalMemoryItem;
  readonly receipt: string;
  readonly replayed: boolean;
}

export interface MemoryForgetReceipt {
  readonly itemId: Ulid;
  readonly state: "forgotten";
  readonly newlyHiddenTurnCount: number;
  readonly totalCoveredTurnCount: number;
  readonly receipt: string;
  readonly replayed: boolean;
}

export interface MemoryLiftReceipt extends MemoryMutationReceipt {
  readonly liftedSuppressionCount: number;
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

type JsonRecord = Readonly<Record<string, JsonValue>>;
type DecodedForgetCommand = Omit<ForgetMemoryItemInput, "principalId" | "ownerAuthorizingEventId">;
type DecodedLiftCommand = Omit<LiftMemoryItemInput, "principalId" | "ownerAuthorizingEventId">;
const redactor = new Redactor();

function refuse(): never {
  throw new MemoryRepositoryError("memory_refused");
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
  const flags = [
    value.explicitMemoryIntent,
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
    || flags.some((flag) => typeof flag !== "boolean")) refuse();
  return Object.freeze({
    principalId,
    eventId,
    eventSequence,
    occurredAt,
    channel,
    explicitMemoryIntent: flags[0] as boolean,
    forwarded: flags[1] as boolean,
    quoted: flags[2] as boolean,
    pasted: flags[3] as boolean,
    hasAttachment: flags[4] as boolean,
    modelGenerated: flags[5] as boolean,
    toolGenerated: flags[6] as boolean,
    guest: flags[7] as boolean,
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

function redactPayload(value: JsonValue): RedactedJsonValue {
  if (typeof value === "string") {
    if (ULID.test(value)) return issueRedactedUlid(value as Ulid);
    const result = redactor.redactText(value);
    if (!result.ok || result.text !== value) refuse();
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, redactPayload(child)]),
  );
}

function exactSingleTarget(candidateItemIds: readonly Ulid[]): Ulid {
  if (!Array.isArray(candidateItemIds)) refuse();
  if (candidateItemIds.length === 0) throw new MemoryRepositoryError("memory_not_found");
  if (candidateItemIds.length !== 1) throw new MemoryRepositoryError("memory_ambiguous");
  return inputUlid(candidateItemIds[0]);
}

function commandKey(turn: MemoryOwnerTurnInput, operation: string): string {
  return `${turn.eventId}:${operation}`;
}

function rememberPayload(value: JsonValue): Readonly<{
  transitionId: Ulid;
  itemId: Ulid;
  versionId: Ulid;
  sourceId: Ulid;
  placementId: Ulid;
  placementEventId: Ulid;
  topicId: Ulid;
}> {
  const payload = record(value);
  exactKeys(payload, [
    "operation", "targetId", "itemId", "versionId", "lifecycleState", "sourceId",
    "placementId", "placementEventId", "topicId",
  ]);
  if (payload.operation !== "item.transition" || payload.lifecycleState !== "active") refuse();
  const transitionId = inputUlid(payload.targetId);
  return Object.freeze({
    transitionId,
    itemId: inputUlid(payload.itemId),
    versionId: inputUlid(payload.versionId),
    sourceId: inputUlid(payload.sourceId),
    placementId: inputUlid(payload.placementId),
    placementEventId: inputUlid(payload.placementEventId),
    topicId: inputUlid(payload.topicId),
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
  if (payload.operation !== "item.correct" || payload.lifecycleState !== "active"
    || !Array.isArray(payload.sourceIds) || !Array.isArray(payload.lifts)) refuse();
  const transitionId = inputUlid(payload.targetId);
  return Object.freeze({
    itemId: inputUlid(payload.itemId),
    previousVersionId: inputUlid(payload.previousVersionId),
    versionId: inputUlid(payload.versionId),
    transitionId,
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
  private readonly clock: () => Date;
  private readonly idFactory: (now: Date) => Ulid;

  constructor(
    private readonly database: D1Database,
    private readonly memory: MemoryRepository = new MemoryRepository(database),
    events?: EventRepository,
    options: MemoryOwnerControlsOptions = {},
  ) {
    this.events = events ?? new EventRepository(database);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? newUlid;
  }

  async remember(input: RememberMemoryInput): Promise<MemoryMutationReceipt> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
      const text = input.text;
      const kind = input.kind;
      const sensitivity = input.sensitivity;
      if (typeof text !== "string" || text.length < 1 || text.length > 32_768
        || !MEMORY_KINDS.has(kind) || !MEMORY_SENSITIVITIES.has(sensitivity)) refuse();
      const requestHash = await this.requestHash("remember", ownerTurn, [
        text,
        kind,
        sensitivity,
      ]);
      const key = commandKey(ownerTurn, "remember");
      const existing = await this.hasCommand(key, requestHash);
      let command: AppendedEvent;
      if (existing) {
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.transition",
          targetId: this.nextId(),
        });
      } else {
        const ownerText = await this.memory.validateOwnerTurn(ownerTurn);
        if (!ownerText.includes(text)) refuse();
        const topics = await this.memory.bootstrapTopics(ownerTurn.principalId);
        const transitionId = this.nextId();
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.transition",
          targetId: transitionId,
          itemId: this.nextId(),
          versionId: this.nextId(),
          lifecycleState: "active",
          sourceId: this.nextId(),
          placementId: this.nextId(),
          placementEventId: this.nextId(),
          topicId: topics.inbox.topicId,
        });
      }
      const payload = rememberPayload(command.envelope.payload);
      const result = await this.memory.commitInitialItem({
        principalId: ownerTurn.principalId,
        itemId: payload.itemId,
        kind,
        creationEventId: ownerTurn.eventId,
        creationEventSequence: ownerTurn.eventSequence,
        version: {
          versionId: payload.versionId,
          text,
          textHash: await sha256Hex(text),
          basis: "stated",
          origin: "authenticated_first_person",
          uncertain: false,
          sensitivity,
          validFrom: null,
          validTo: null,
          extractorVersion: MEMORY_CONTROL_POLICY_VERSION,
          extractorModelId: null,
        },
        sources: [{
          sourceId: payload.sourceId,
          eventId: ownerTurn.eventId,
          eventSequence: ownerTurn.eventSequence,
          sourceLocation: "live",
          r2SegmentId: null,
          excerpt: text,
          excerptHash: await sha256Hex(text),
          channel: ownerTurn.channel,
          occurredAt: ownerTurn.occurredAt,
        }],
        transition: {
          transitionId: payload.transitionId,
          lifecycleState: "active",
          reason: "owner requested immediate memory",
          policyVersion: MEMORY_CONTROL_POLICY_VERSION,
          ownerAuthorizingEventId: command.envelope.eventId,
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
      return Object.freeze({
        item: result.item,
        receipt: "Remembered 1 memory. You can ask in ordinary language to forget it.",
        replayed: command.replayed || result.replayed,
      });
    });
  }

  async explain(input: TargetedMemoryControlInput): Promise<MemoryExplanation> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
      const itemId = exactSingleTarget(input.candidateItemIds);
      await this.memory.validateOwnerTurn(ownerTurn);
      const item = await this.memory.readCurrentItem(ownerTurn.principalId, itemId);
      const hidden = item.lifecycle.state === "forgotten";
      return Object.freeze({
        itemId,
        state: item.lifecycle.state,
        uncertain: item.version.uncertain,
        topicPath: Object.freeze(item.topicPath.map((entry) => entry.displayName)),
        text: hidden ? null : item.version.text,
        sources: Object.freeze(item.sources.map((source) => Object.freeze({
          eventId: source.eventId,
          occurredAt: source.occurredAt,
          channel: source.channel,
          excerpt: hidden ? null : source.excerpt,
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
        await this.memory.validateOwnerTurn(ownerTurn);
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
      const decoded = forgetPayload(command.envelope.payload);
      if (decoded.itemId !== itemId) refuse();
      const result = await this.memory.forgetItem({
        ...decoded,
        principalId: ownerTurn.principalId,
        ownerAuthorizingEventId: command.envelope.eventId,
      });
      return Object.freeze({
        itemId: result.item.itemId,
        state: "forgotten" as const,
        newlyHiddenTurnCount: result.newlyHiddenTurnCount,
        totalCoveredTurnCount: result.totalCoveredTurnCount,
        receipt: `Forgot 1 memory and hid ${result.newlyHiddenTurnCount} of ${result.totalCoveredTurnCount} source turns; the original conversation remains retained. You can ask in ordinary language to use it again.`,
        replayed: command.replayed || result.replayed,
      });
    });
  }

  async lift(input: TargetedMemoryControlInput): Promise<MemoryLiftReceipt> {
    return this.safely(async () => {
      const ownerTurn = captureOwnerTurn(input.ownerTurn);
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
        await this.memory.validateOwnerTurn(ownerTurn);
        const prepared = await this.memory.prepareLiftItem(ownerTurn.principalId, itemId);
        const transitionId = this.nextId();
        command = await this.appendCommand(ownerTurn, key, requestHash, {
          operation: "item.correct",
          targetId: transitionId,
          itemId,
          previousVersionId: prepared.item.version.versionId,
          versionId: this.nextId(),
          lifecycleState: "active",
          sourceIds: prepared.item.sources.map(() => this.nextId()),
          lifts: prepared.suppressionIds.map((suppressionId) => ({
            liftId: this.nextId(),
            suppressionId,
          })),
        });
      }
      const decoded = liftPayload(command.envelope.payload);
      if (decoded.itemId !== itemId) refuse();
      const result = await this.memory.liftItem({
        ...decoded,
        principalId: ownerTurn.principalId,
        ownerAuthorizingEventId: command.envelope.eventId,
      });
      return Object.freeze({
        item: result.item,
        liftedSuppressionCount: result.liftedSuppressionCount,
        receipt: `Restored 1 memory and lifted ${result.liftedSuppressionCount} suppressions. You can ask in ordinary language to forget it again.`,
        replayed: command.replayed || result.replayed,
      });
    });
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

  private async hasCommand(key: string, requestHash: Sha256Hex): Promise<boolean> {
    const row = await this.database.prepare(
      "SELECT request_hash FROM idempotency_records WHERE scope = 'memory:owner-control' AND key = ?",
    ).bind(key).first<StoredControlReceipt>();
    if (row === null) return false;
    if (Reflect.ownKeys(row).length !== 1 || row.request_hash !== requestHash) refuse();
    return true;
  }

  private async requestHash(
    operation: string,
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
      turn.explicitMemoryIntent,
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
