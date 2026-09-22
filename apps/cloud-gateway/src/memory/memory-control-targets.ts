/**
 * Resolving which memory an owner control acts on.
 *
 * This is the half of the Telegram memory subsystem that answers "which item
 * did Sid mean", and at `d0ec419` it lived inside `TelegramMemoryRetriever` --
 * a `ContextRetriever` whose other job is ranking recall for one channel. The
 * consequence was a type, not a habit: `D1ContextRetriever implements
 * ContextRetriever` only, while `TelegramMemoryRetriever` also implemented
 * `TelegramMemoryTargetFinder`, so the voice path could not name a memory to
 * act on at all and every memory tool taking an `itemId` had nothing to
 * resolve one from.
 *
 * The class reads `memory_item_fts`/`memory_item_state` -- the `memory_items`
 * store the memory tools themselves write. That is deliberate: the `itemId`
 * tools act on the item store, so whichever channel asks has to read it. It is
 * a different question from which store the *recall* path reads, which is what
 * `docs/STATE.md` records as Telegram and voice disagreeing about.
 */

import { validateEnvelope, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ArchivalService, type ArchiveBucket } from "../archive/archival-service.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "../conversation/conversation-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import {
  MemoryRepositoryError,
  type MemoryLifecycleState,
} from "./memory-types.js";
import { CANDIDATE_SUPPRESSION_CLAUSES } from "./suppression-clauses.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const MAX_FTS_TERMS = 16;
const MAX_FTS_TERM_BYTES = 128;
const MAX_CONTROL_TARGETS = 2;
const MAX_REFERENCED_ITEMS = 8;
const MAX_QUERY_BYTES = 65_536;
const encoder = new TextEncoder();

const CONTROL_STOPWORDS = new Set([
  "a", "about", "again", "an", "and", "could", "do", "forget", "i", "it", "me",
  "memory", "my", "please", "remember", "that", "the", "think", "this", "use", "why",
  "would", "you",
]);

const ALL_MEMORY_STATES: readonly MemoryLifecycleState[] = Object.freeze([
  "proposed", "active", "rejected", "superseded", "forgotten", "expired",
]);

/**
 * Worst case for one control-target lookup. The same ceiling the retriever
 * enforced before this was extracted, enforced here by the counted database
 * proxy so a lookup that starts walking the whole item store fails instead of
 * timing out mid-write.
 */
export const MEMORY_CONTROL_TARGET_LIMITS = Object.freeze({
  d1Statements: 384,
  candidatesExamined: MAX_CONTROL_TARGETS,
});

export type MemoryTargetOperation =
  | "forget" | "lift" | "confirm" | "explain" | "correct" | "pin" | "unpin";

export interface MemoryTargetFinder {
  findControlTargets(input: Readonly<{
    principalId: string;
    operation: MemoryTargetOperation;
    query: string | null;
    turnId?: Ulid;
  }>): Promise<readonly Ulid[]>;
}

/** The names the Telegram composition already used for these. */
export type TelegramMemoryTargetOperation = MemoryTargetOperation;
export type TelegramMemoryTargetFinder = MemoryTargetFinder;

/**
 * Every declared operation, once, checked against the union.
 *
 * `pin` and `unpin` were missing from the old hand-written guard, so
 * `memory_pin` and `memory_unpin` threw `telegram_memory_target_invalid` on
 * every call while the suite stayed green, because three test files injected a
 * stub in place of this method. A `satisfies Readonly<Record<...>>` map turns
 * the next added operation into a compile error instead of a dead tool.
 */
const SUPPORTED_OPERATIONS = Object.freeze({
  forget: true, lift: true, confirm: true, explain: true, correct: true, pin: true, unpin: true,
} satisfies Readonly<Record<MemoryTargetOperation, true>>);

interface CandidateRow {
  readonly item_id: unknown;
  readonly version_id: unknown;
  readonly relevance: unknown;
}

interface PreviousAssistantRow {
  readonly turn_id: unknown;
  readonly user_event_id: unknown;
  readonly staged_event_id: unknown;
  readonly staged_envelope_json: unknown;
  readonly delivered_event_id: unknown;
  readonly delivered_envelope_json: unknown;
}

interface ItemStateRow {
  readonly item_id: unknown;
  readonly lifecycle_state: unknown;
}

export interface MemoryControlTargetFinderOptions {
  readonly database: D1Database;
  /** Absent in some test compositions; only the item store is read either way. */
  readonly archive?: ArchiveBucket;
}

class StatementBudget {
  used = 0;
  private aborted = false;

  constructor(readonly maximum: number) {}

  take(): void {
    if (this.aborted) throw new RangeError("telegram_memory_retrieval_aborted");
    this.used += 1;
    if (this.used > this.maximum) throw new RangeError("telegram_memory_d1_budget_exceeded");
  }

  abort(): void {
    this.aborted = true;
  }
}

function countedDatabase(database: D1Database, budget: StatementBudget): D1Database {
  return new Proxy(database as object, {
    get(target, property): unknown {
      if (property === "prepare") {
        return (query: string) => {
          budget.take();
          return Reflect.apply((target as D1Database).prepare, target, [query]);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function exactRow(value: object, fields: ReadonlySet<string>, error: string): void {
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) throw new TypeError(error);
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(error);
  exactRow(value, fields, error);
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
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(error);
  }
  return value;
}

function safePrincipal(value: unknown): string {
  const principalId = safeText(value, 256, "telegram_memory_principal_invalid");
  if (/[\r\n]/u.test(principalId)) throw new TypeError("telegram_memory_principal_invalid");
  return principalId;
}

function safeUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError("telegram_memory_id_invalid");
  return value as Ulid;
}

function candidateRows(value: unknown): readonly Readonly<{ itemId: Ulid; versionId: Ulid }>[] {
  if (!Array.isArray(value) || value.length > MAX_CONTROL_TARGETS) {
    throw new TypeError("telegram_memory_candidates_invalid");
  }
  return Object.freeze(value.map((rowValue) => {
    if (rowValue === null || typeof rowValue !== "object" || Array.isArray(rowValue)) {
      throw new TypeError("telegram_memory_candidate_invalid");
    }
    exactRow(rowValue, new Set(["item_id", "version_id", "relevance"]), "telegram_memory_candidate_invalid");
    const row = rowValue as unknown as CandidateRow;
    if (typeof row.relevance !== "number" || !Number.isFinite(row.relevance)) {
      throw new TypeError("telegram_memory_candidate_invalid");
    }
    return Object.freeze({ itemId: safeUlid(row.item_id), versionId: safeUlid(row.version_id) });
  }));
}

function controlFtsQuery(value: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].normalize("NFC");
    const folded = term.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
    if (CONTROL_STOPWORDS.has(folded) || encoder.encode(term).byteLength > MAX_FTS_TERM_BYTES
      || seen.has(folded)) continue;
    seen.add(folded);
    terms.push(`"${term}"`);
    if (terms.length === MAX_FTS_TERMS) break;
  }
  return terms.length === 0 ? null : terms.join(" AND ");
}

function targetStates(operation: MemoryTargetOperation): readonly MemoryLifecycleState[] {
  if (operation === "forget") return Object.freeze(["active", "proposed"]);
  if (operation === "lift") return Object.freeze(["forgotten"]);
  if (operation === "confirm") return Object.freeze(["proposed"]);
  // Only a current wording can be replaced; the transition guard has no edge
  // from any other state into 'superseded'.
  if (operation === "correct") return Object.freeze(["active"]);
  // Only a retrievable item can be in the core profile, so a pin can only target
  // one that is active. Offering a forgotten item as a pin candidate would
  // produce a preference that can never take effect.
  if (operation === "pin" || operation === "unpin") return Object.freeze(["active"]);
  return ALL_MEMORY_STATES;
}

export class D1MemoryControlTargetFinder implements MemoryTargetFinder {
  private readonly database: D1Database;

  constructor(private readonly options: MemoryControlTargetFinderOptions) {
    this.database = options.database;
  }

  async findControlTargets(input: Readonly<{
    principalId: string;
    operation: MemoryTargetOperation;
    query: string | null;
    turnId?: Ulid;
  }>): Promise<readonly Ulid[]> {
    const principalId = safePrincipal(input.principalId);
    if (!Object.hasOwn(SUPPORTED_OPERATIONS, input.operation)) {
      throw new TypeError("telegram_memory_target_invalid");
    }
    const states = targetStates(input.operation);
    const query = input.query === null ? null : safeText(input.query, 1_024, "telegram_memory_target_invalid");
    const terms = query === null ? null : controlFtsQuery(query);
    if (query !== null && terms === null) return Object.freeze([]);
    // One budget per lookup, split across the item read and the target SQL so a
    // read that starts walking the store fails rather than timing out.
    const ids = countedDatabase(this.database, new StatementBudget(MEMORY_CONTROL_TARGET_LIMITS.d1Statements));
    const memory = this.memory(ids);
    if (terms === null) {
      return input.turnId === undefined
        ? Object.freeze([])
        : this.findLastReferencedTarget(ids, principalId, safeUlid(input.turnId), states);
    }
    return this.selectControlTargets(ids, memory, principalId, states, terms);
  }

  private memory(database: D1Database): MemoryRepository {
    const bucket = this.options.archive;
    return bucket === undefined
      ? new MemoryRepository(database)
      // `archivedEventReader` is passed whenever an archive bucket exists so a
      // remembered source that has since been archived still resolves. Without
      // the bucket the finder has no archive to read and constructs without it.
      : new MemoryRepository(database, {
        archivedEventReader: new ArchivalService({
          database, bucket, cacheVerifiedSegments: true,
        }),
      });
  }

  private async selectControlTargets(
    ids: D1Database,
    memory: MemoryRepository,
    principalId: string,
    states: readonly MemoryLifecycleState[],
    terms: string,
  ): Promise<readonly Ulid[]> {
    const stateSql = states.map((state) => `'${state}'`).join(", ");
    const result = await ids.prepare(`SELECT version.item_id, version.version_id,
        memory_item_fts.rank AS relevance
      FROM memory_item_fts
      JOIN memory_item_versions version ON version.version_rowid = memory_item_fts.rowid
      JOIN memory_item_state state
        ON state.principal_id = version.principal_id
        AND state.current_version_id = version.version_id
      JOIN memory_items item
        ON item.principal_id = state.principal_id AND item.item_id = state.item_id
      WHERE memory_item_fts MATCH ? AND state.principal_id = ?
        AND state.lifecycle_state IN (${stateSql})
        ${CANDIDATE_SUPPRESSION_CLAUSES}
      ORDER BY memory_item_fts.rank ASC, version.created_at DESC, version.item_id ASC LIMIT ?`)
      .bind(terms, principalId, MAX_CONTROL_TARGETS).all<CandidateRow>();
    const rows = candidateRows(result.results);
    const selected: Ulid[] = [];
    for (const candidate of rows) {
      try {
        const item = await memory.readCurrentItem(principalId, candidate.itemId);
        if (item.version.versionId === candidate.versionId && states.includes(item.lifecycle.state)) {
          selected.push(item.itemId);
        }
      } catch (error) {
        if (!(error instanceof MemoryRepositoryError) || error.code !== "memory_not_found") throw error;
      }
    }
    return Object.freeze(selected);
  }

  /**
   * The most recently delivered assistant turn's item ids, when exactly one.
   *
   * Only one, because "which memory did he mean" with two candidates is a
   * question the model has to answer by naming an id, not one this may guess.
   */
  private async findLastReferencedTarget(
    ids: D1Database,
    principalId: string,
    turnId: Ulid,
    states: readonly MemoryLifecycleState[],
  ): Promise<readonly Ulid[]> {
    const row = await ids.prepare(`SELECT previous.turn_id,
        previous.user_event_id, delivery.staged_event_id,
        staged.envelope_json AS staged_envelope_json,
        previous.delivered_assistant_event_id AS delivered_event_id,
        delivered.envelope_json AS delivered_envelope_json
      FROM conversation_turns current
      JOIN events current_user ON current_user.event_id = current.user_event_id
      JOIN conversation_turns previous
        ON previous.session_id = current.session_id
        AND previous.principal_id = current.principal_id
        AND previous.channel = current.channel
      JOIN events previous_user ON previous_user.event_id = previous.user_event_id
      JOIN conversation_deliveries delivery ON delivery.delivery_id = previous.staged_delivery_id
      JOIN events staged ON staged.event_id = delivery.staged_event_id
      JOIN events delivered ON delivered.event_id = previous.delivered_assistant_event_id
      WHERE current.turn_id = ? AND current.principal_id = ?
        AND previous.state = 'delivered'
        AND previous.delivered_assistant_event_id IS NOT NULL
        AND previous_user.sequence < current_user.sequence
      ORDER BY previous_user.sequence DESC LIMIT 1`)
      .bind(turnId, principalId).first<PreviousAssistantRow>();
    if (row === null) return Object.freeze([]);
    exactRow(row, new Set([
      "turn_id", "user_event_id", "staged_event_id", "staged_envelope_json",
      "delivered_event_id", "delivered_envelope_json",
    ]), "telegram_memory_reference_invalid");
    if (typeof row.staged_envelope_json !== "string" || typeof row.delivered_envelope_json !== "string") {
      throw new TypeError("telegram_memory_reference_invalid");
    }
    const previousTurnId = safeUlid(row.turn_id);
    const userEventId = safeUlid(row.user_event_id);
    const stagedEventId = safeUlid(row.staged_event_id);
    const deliveredEventId = safeUlid(row.delivered_event_id);
    const [stagedIds, deliveredText] = await Promise.all([
      stagedMemoryItemIds({
        envelopeJson: row.staged_envelope_json,
        eventId: stagedEventId,
        turnId: previousTurnId,
        userEventId,
        principalId,
      }),
      deliveredAssistantText({
        envelopeJson: row.delivered_envelope_json,
        eventId: deliveredEventId,
        stagedEventId,
        turnId: previousTurnId,
        principalId,
      }),
    ]);
    const referenced = [...new Set([...stagedIds, ...citedMemoryItemIds(deliveredText)])];
    if (referenced.length !== 1) return Object.freeze([]);
    const itemId = referenced[0]!;
    const state = await ids.prepare(`SELECT item_id, lifecycle_state
      FROM memory_item_state WHERE principal_id = ? AND item_id = ?`)
      .bind(principalId, itemId).first<ItemStateRow>();
    if (state === null) return Object.freeze([]);
    exactRow(state, new Set(["item_id", "lifecycle_state"]), "telegram_memory_reference_invalid");
    if (safeUlid(state.item_id) !== itemId || typeof state.lifecycle_state !== "string"
      || !ALL_MEMORY_STATES.includes(state.lifecycle_state as MemoryLifecycleState)) {
      throw new TypeError("telegram_memory_reference_invalid");
    }
    if (!states.includes(state.lifecycle_state as MemoryLifecycleState)) {
      return Object.freeze([]);
    }
    return Object.freeze([itemId]);
  }
}

const HISTORY_PAYLOAD_FIELDS = new Set([
  "schemaCode", "channelCode", "sensitivityCode", "historyEligible", "text",
]);
const HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS = new Set([
  ...HISTORY_PAYLOAD_FIELDS,
  "directOwnerText",
]);
const ASSISTANT_STAGE_PAYLOAD_WITH_REFERENCES_FIELDS = new Set([
  ...HISTORY_PAYLOAD_FIELDS,
  "memoryItemIds",
]);
const ASSISTANT_STAGE_EVENT_TYPE = "conversation.assistant_staged";
const ASSISTANT_DELIVERED_EVENT_TYPE = "conversation.assistant_delivered";

function conversationText(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  const fields = Object.hasOwn(value, "directOwnerText")
    ? HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS
    : HISTORY_PAYLOAD_FIELDS;
  const payload = exactRecord(value, fields, "telegram_memory_reference_invalid");
  if (payload.schemaCode !== 1 || payload.channelCode !== 2 || payload.sensitivityCode !== 1
    || payload.historyEligible !== true
    || Object.hasOwn(payload, "directOwnerText") && typeof payload.directOwnerText !== "boolean") {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  return safeText(payload.text, MAX_QUERY_BYTES, "telegram_memory_reference_invalid");
}

async function stagedMemoryItemIds(input: Readonly<{
  envelopeJson: string;
  eventId: Ulid;
  turnId: Ulid;
  userEventId: Ulid;
  principalId: string;
}>): Promise<readonly Ulid[]> {
  let decoded: unknown;
  try { decoded = JSON.parse(input.envelopeJson); }
  catch { throw new TypeError("telegram_memory_reference_invalid"); }
  const envelope = await validateEnvelope(decoded);
  if (envelope.eventId !== input.eventId || envelope.correlationId !== input.turnId
    || envelope.causationId !== input.userEventId || envelope.subjectId !== input.principalId
    || envelope.eventType !== ASSISTANT_STAGE_EVENT_TYPE
    || envelope.source !== CONVERSATION_EVENT_SOURCE
    || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  if (envelope.payload === null || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  const fields = Object.hasOwn(envelope.payload, "memoryItemIds")
    ? ASSISTANT_STAGE_PAYLOAD_WITH_REFERENCES_FIELDS
    : HISTORY_PAYLOAD_FIELDS;
  const payload = exactRecord(envelope.payload, fields, "telegram_memory_reference_invalid");
  // `channelCode` stays 2 because this is one exact durable Telegram envelope
  // shape: a voice turn never stages an assistant delivery at all, it sends on
  // the relay, so there is no second code to read here.
  if (payload.schemaCode !== 1 || payload.channelCode !== 2 || payload.sensitivityCode !== 1
    || payload.historyEligible !== false) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  safeText(payload.text, MAX_QUERY_BYTES, "telegram_memory_reference_invalid");
  if (!Object.hasOwn(payload, "memoryItemIds")) return Object.freeze([]);
  if (!Array.isArray(payload.memoryItemIds) || payload.memoryItemIds.length === 0
    || payload.memoryItemIds.length > MAX_REFERENCED_ITEMS) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  const itemIds = payload.memoryItemIds.map((itemId) => safeUlid(itemId));
  if (new Set(itemIds).size !== itemIds.length) throw new TypeError("telegram_memory_reference_invalid");
  return Object.freeze(itemIds);
}

async function deliveredAssistantText(input: Readonly<{
  envelopeJson: string;
  eventId: Ulid;
  stagedEventId: Ulid;
  turnId: Ulid;
  principalId: string;
}>): Promise<string> {
  let decoded: unknown;
  try { decoded = JSON.parse(input.envelopeJson); }
  catch { throw new TypeError("telegram_memory_reference_invalid"); }
  const envelope = await validateEnvelope(decoded);
  if (envelope.eventId !== input.eventId || envelope.correlationId !== input.turnId
    || envelope.causationId !== input.stagedEventId || envelope.subjectId !== input.principalId
    || envelope.eventType !== ASSISTANT_DELIVERED_EVENT_TYPE
    || envelope.source !== CONVERSATION_EVENT_SOURCE
    || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  return conversationText(envelope.payload);
}

function citedMemoryItemIds(text: string): readonly Ulid[] {
  const itemIds: Ulid[] = [];
  for (const match of text.matchAll(/\bitem[ \t]+([0-7][0-9a-hjkmnp-tv-z]{25})\b/gu)) {
    const itemId = safeUlid(match[1]);
    if (!itemIds.includes(itemId)) itemIds.push(itemId);
    if (itemIds.length === MAX_REFERENCED_ITEMS) break;
  }
  return Object.freeze(itemIds);
}
