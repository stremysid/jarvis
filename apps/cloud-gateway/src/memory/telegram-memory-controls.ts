import {
  validateEnvelope,
  type EventEnvelope,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import type { ArchiveBucket } from "../archive/archival-service.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "../conversation/conversation-repository.js";
import {
  snapshotModelAdapterStreamInput,
  type ModelAdapter,
  type ModelAdapterStreamInput,
  type ModelToken,
} from "../model/model-adapter.js";
import { Redactor } from "../security/redaction.js";
import {
  MemoryOwnerControlsService,
  type MemoryExplanation,
} from "./memory-owner-controls.js";
import {
  MemoryRepositoryError,
  type MemoryControlIntent,
  type MemoryKind,
  type MemoryOwnerTurnInput,
} from "./memory-types.js";
import {
  parseTelegramMemoryControl,
  type TelegramMemoryControl,
} from "./telegram-memory-language.js";
import type { TelegramMemoryTargetFinder } from "./telegram-memory-retriever.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OWNER_TURN_FIELDS = new Set([
  "turn_id", "principal_id", "channel", "user_event_id", "state", "sequence",
  "event_id", "event_type", "source", "subject_id", "occurred_at", "content_hash",
  "envelope_json",
]);
const HISTORY_PAYLOAD_FIELDS = new Set([
  "schemaCode", "channelCode", "sensitivityCode", "historyEligible", "text",
]);
const HIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const encoder = new TextEncoder();
const redactor = new Redactor();

interface OwnerTurnRow {
  readonly turn_id: unknown;
  readonly principal_id: unknown;
  readonly channel: unknown;
  readonly user_event_id: unknown;
  readonly state: unknown;
  readonly sequence: unknown;
  readonly event_id: unknown;
  readonly event_type: unknown;
  readonly source: unknown;
  readonly subject_id: unknown;
  readonly occurred_at: unknown;
  readonly content_hash: unknown;
  readonly envelope_json: unknown;
}

export interface TelegramMemoryControlAuthority {
  readonly principalId: string;
  readonly text: string;
  /** False for Telegram-forwarded or externally borrowed text. */
  readonly isDirectText: boolean;
}

export interface TelegramMemoryControlModelOptions {
  readonly database: D1Database;
  readonly archive: ArchiveBucket;
  readonly fallbackModel: ModelAdapter;
  readonly ownerPrincipalId: string;
  readonly authority: TelegramMemoryControlAuthority;
  readonly targets: TelegramMemoryTargetFinder;
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(error);
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) throw new TypeError(error);
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    captured[field] = descriptor.value;
  }
  return captured;
}

function safeText(value: unknown, maximumBytes: number, error: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new TypeError(error);
  }
  return value;
}

function safeAtom(value: unknown, error: string): string {
  const text = safeText(value, 1_024, error);
  if (/[\r\n]/u.test(text)) throw new TypeError(error);
  return text;
}

function safeUlid(value: unknown, error: string): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(error);
  return value as Ulid;
}

function safeTimestamp(value: unknown, error: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TypeError(error);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(error);
  return value;
}

function plainLine(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || HIDDEN_TEXT.test(value)
    || encoder.encode(value).byteLength > 4_096) {
    return "I could not safely apply that memory request, so I changed nothing.";
  }
  return value;
}

function memoryKind(text: string): MemoryKind {
  if (/\b(?:decided|decision)\b/iu.test(text)) return "decision";
  if (/\b(?:plan|intend|going[ \t]+to|will)\b/iu.test(text)) return "plan";
  if (/\b(?:prefer|preference|favourite|favorite)\b/iu.test(text)) return "preference";
  if (/\b(?:mother|father|parent|sister|brother|partner|friend|teacher)\b/iu.test(text)) return "relationship";
  return "fact";
}

function evidenceReceipt(explanation: MemoryExplanation): string {
  const sources = explanation.sources.map((source) => (
    `${source.channel} event ${source.eventId} at ${source.occurredAt}`
  )).join(", ");
  const area = explanation.topicPath.at(-1) ?? "hidden area";
  return plainLine(`Evidence for 1 memory in ${area}: ${sources}; nothing changed.`);
}

function mutationReceipt(intent: "remember" | "forget" | "lift", receipt: string): string {
  const line = plainLine(receipt);
  if (intent === "remember" && !/\bforget it\b/iu.test(line)) {
    return `${line} You can ask in ordinary language to forget it.`;
  }
  if (intent === "forget" && !/\buse it again\b/iu.test(line)) {
    return `${line} You can ask in ordinary language to use it again.`;
  }
  if (intent === "lift" && !/\bforget it again\b/iu.test(line)) {
    return `${line} You can ask in ordinary language to forget it again.`;
  }
  return line;
}

function failureReceipt(error: unknown): string {
  if (error instanceof MemoryRepositoryError) {
    if (error.code === "memory_ambiguous") {
      return "Which memory do you mean? Tell me a few words from it; I changed nothing.";
    }
    if (error.code === "memory_not_found") {
      return "I could not find that memory. Tell me a few words from it; I changed nothing.";
    }
    if (error.code === "memory_refused") {
      return "I could not apply that memory request from this message. Please ask again in your own words.";
    }
  }
  return "I could not safely access memory just now, so I changed nothing.";
}

/**
 * Intercepts an exact trusted Telegram owner turn after it is durably committed
 * but before the provider model. A handled control emits one token at index 0;
 * an ordinary turn delegates without adding a token or changing its indexes.
 */
export class TelegramMemoryControlModelAdapter implements ModelAdapter {
  private readonly authority: Readonly<TelegramMemoryControlAuthority>;

  constructor(private readonly options: TelegramMemoryControlModelOptions) {
    this.authority = Object.freeze({
      principalId: safeAtom(options.authority.principalId, "telegram_memory_authority_invalid"),
      text: safeText(options.authority.text, 65_536, "telegram_memory_authority_invalid"),
      isDirectText: options.authority.isDirectText,
    });
    safeAtom(options.ownerPrincipalId, "telegram_memory_owner_invalid");
    if (typeof options.authority.isDirectText !== "boolean") {
      throw new TypeError("telegram_memory_authority_invalid");
    }
  }

  stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    return this.streamCaptured(snapshotModelAdapterStreamInput(input));
  }

  private async *streamCaptured(input: Readonly<ModelAdapterStreamInput>): AsyncIterable<ModelToken> {
    const control = parseTelegramMemoryControl(input.userText);
    const authoritative = input.channel === "telegram"
      && input.principalId === this.options.ownerPrincipalId
      && this.authority.principalId === input.principalId
      && this.authority.text === input.userText
      && this.authority.isDirectText;
    if (control === null || !authoritative) {
      yield* this.options.fallbackModel.stream(input);
      return;
    }

    let receipt: string;
    try {
      receipt = await this.applyControl(input, control);
    } catch (error) {
      receipt = failureReceipt(error);
    }
    yield Object.freeze({ index: 0, text: plainLine(receipt) });
  }

  private async applyControl(
    input: Readonly<ModelAdapterStreamInput>,
    control: TelegramMemoryControl,
  ): Promise<string> {
    const ownerTurn = await this.readOwnerTurn(input, control.intent);
    const controls = new MemoryOwnerControlsService(this.options.database, this.options.archive);
    if (control.intent === "remember") {
      const result = await controls.remember({
        ownerTurn,
        text: control.memoryText,
        kind: memoryKind(control.memoryText),
        sensitivity: "normal",
      });
      return mutationReceipt("remember", result.receipt);
    }

    const candidates = await this.options.targets.findControlTargets({
      principalId: input.principalId,
      operation: control.intent,
      query: control.targetQuery,
    });
    if (candidates.length !== 1) {
      return "Which memory do you mean? Tell me a few words from it; I changed nothing.";
    }
    if (control.intent === "forget") {
      return mutationReceipt(
        "forget",
        (await controls.forget({ ownerTurn, candidateItemIds: candidates })).receipt,
      );
    }
    if (control.intent === "lift") {
      return mutationReceipt(
        "lift",
        (await controls.lift({ ownerTurn, candidateItemIds: candidates })).receipt,
      );
    }
    return evidenceReceipt(await controls.explain({ ownerTurn, candidateItemIds: candidates }));
  }

  private async readOwnerTurn(
    input: Readonly<ModelAdapterStreamInput>,
    memoryIntent: MemoryControlIntent,
  ): Promise<MemoryOwnerTurnInput> {
    const rowValue = await this.options.database.prepare(`SELECT turn.turn_id, turn.principal_id,
        turn.channel, turn.user_event_id, turn.state, event.sequence, event.event_id,
        event.event_type, event.source, event.subject_id, event.occurred_at,
        event.content_hash, event.envelope_json
      FROM conversation_turns turn
      JOIN events event ON event.event_id = turn.user_event_id
      WHERE turn.turn_id = ? AND turn.principal_id = ? AND turn.channel = 'telegram'`)
      .bind(input.correlationId, input.principalId).first<OwnerTurnRow>();
    if (rowValue === null) throw new MemoryRepositoryError("memory_refused");
    const row = exactRecord(rowValue, OWNER_TURN_FIELDS, "telegram_memory_owner_turn_invalid");
    const turnId = safeUlid(row.turn_id, "telegram_memory_owner_turn_invalid");
    const eventId = safeUlid(row.event_id, "telegram_memory_owner_turn_invalid");
    const userEventId = safeUlid(row.user_event_id, "telegram_memory_owner_turn_invalid");
    const principalId = safeAtom(row.principal_id, "telegram_memory_owner_turn_invalid");
    const sequence = row.sequence;
    const occurredAt = safeTimestamp(row.occurred_at, "telegram_memory_owner_turn_invalid");
    if (turnId !== input.correlationId || eventId !== userEventId || principalId !== input.principalId
      || row.channel !== "telegram" || row.state !== "model_claimed"
      || !Number.isSafeInteger(sequence) || (sequence as number) < 1
      || row.event_type !== "conversation.user_committed"
      || row.source !== CONVERSATION_EVENT_SOURCE || row.subject_id !== principalId
      || typeof row.content_hash !== "string" || !SHA256.test(row.content_hash)
      || typeof row.envelope_json !== "string" || row.envelope_json.length === 0
      || !row.envelope_json.isWellFormed()) {
      throw new MemoryRepositoryError("memory_refused");
    }
    let decoded: unknown;
    try { decoded = JSON.parse(row.envelope_json); }
    catch { throw new MemoryRepositoryError("memory_corrupt"); }
    let envelope: EventEnvelope;
    try { envelope = await validateEnvelope(decoded); }
    catch { throw new MemoryRepositoryError("memory_corrupt"); }
    const payload = exactRecord(envelope.payload, HISTORY_PAYLOAD_FIELDS, "telegram_memory_owner_turn_invalid");
    const checked = redactor.redactText(input.userText);
    if (envelope.eventId !== eventId || envelope.eventType !== row.event_type
      || envelope.source !== row.source || envelope.subjectId !== principalId
      || envelope.correlationId !== turnId || envelope.occurredAt !== occurredAt
      || envelope.contentHash !== row.content_hash
      || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION
      || payload.schemaCode !== 1 || payload.channelCode !== 2
      || payload.sensitivityCode !== 1 || payload.historyEligible !== true
      || payload.text !== input.userText || !checked.ok || checked.text !== input.userText) {
      throw new MemoryRepositoryError("memory_refused");
    }
    return Object.freeze({
      principalId,
      eventId,
      eventSequence: sequence as number,
      occurredAt,
      channel: "telegram",
      memoryIntent,
      forwarded: false,
      quoted: false,
      pasted: false,
      hasAttachment: false,
      modelGenerated: false,
      toolGenerated: false,
      guest: false,
    });
  }
}
