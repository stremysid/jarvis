import {
  canonicalJson,
  sha256Hex,
  type SequencedEventV1,
  type Sha256Hex,
  type SignedRequestV1,
  type SyncAckReceiptV1,
  type SyncEventsAckBodyV1,
  type SyncEventsPageV1,
  type SyncEventsPullBodyV1,
} from "../../../../packages/contracts/src/index.js";
import {
  DeviceRepository,
  type SyncSnapshotRow,
} from "../persistence/device-repository.js";
import type { AppendedEvent, SyncEventReader } from "../persistence/event-repository.js";
import {
  decodeCanonicalBase64Url,
  encodeBase64Url,
  DeviceRequestVerifier,
  type VerifiedDeviceRequest,
} from "./signed-request.js";

const PULL_PATH = "/sync/pull";
const ACK_PATH = "/sync/ack";
const SNAPSHOT_LIFETIME_MS = 300_000;
// Requested pageSize remains 500; actual immutable pages stay memory-safe for
// the maximum 256 KiB envelope and persist their exact replay event_count.
const MAXIMUM_MATERIAL_EVENTS = 48;
const PULL_FIELDS = new Set(["schemaVersion", "consumerId", "afterSequence", "pageSize", "snapshotToken"]);
const ACK_FIELDS = new Set(["schemaVersion", "snapshotId", "expectedCurrent", "throughSequence"]);
const encoder = new TextEncoder();

interface PageMaterial {
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly events: readonly AppendedEvent[];
  readonly boundaryStartEventId: string | null;
  readonly boundaryEndEventId: string | null;
  readonly hasMore: boolean;
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(error);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) throw new TypeError(error);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    result[field] = descriptor.value;
  }
  return result;
}

function safeAtom(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && value === value.normalize("NFC")
    && !value.includes("\n") && !value.includes("\r") && encoder.encode(value).byteLength <= maximumBytes;
}

function nonNegativeSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validatePullBody(value: unknown): SyncEventsPullBodyV1 {
  const record = exactRecord(value, PULL_FIELDS, "sync_pull_body_invalid");
  if (record.schemaVersion !== "1.0" || !safeAtom(record.consumerId, 128) || !nonNegativeSequence(record.afterSequence)
    || typeof record.pageSize !== "number" || !Number.isSafeInteger(record.pageSize) || record.pageSize < 1 || record.pageSize > 500) {
    throw new TypeError("sync_pull_body_invalid");
  }
  if (record.snapshotToken !== null) decodeCanonicalBase64Url(record.snapshotToken, 32, "sync_pull_body_invalid");
  return record as unknown as SyncEventsPullBodyV1;
}

function validateAckBody(value: unknown): SyncEventsAckBodyV1 {
  const record = exactRecord(value, ACK_FIELDS, "sync_ack_body_invalid");
  if (record.schemaVersion !== "1.0" || !safeAtom(record.snapshotId, 64)
    || !nonNegativeSequence(record.expectedCurrent) || !nonNegativeSequence(record.throughSequence)
    || record.throughSequence < record.expectedCurrent) {
    throw new TypeError("sync_ack_body_invalid");
  }
  decodeCanonicalBase64Url(record.snapshotId, 32, "sync_ack_body_invalid");
  return record as unknown as SyncEventsAckBodyV1;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError("sync_time_invalid");
  return value;
}

function snapshotOwnerMatches(row: SyncSnapshotRow, verified: VerifiedDeviceRequest, consumerName: string): boolean {
  return row.principal_id === verified.principalId && row.device_id === verified.deviceId && row.consumer_name === consumerName;
}

function freezePage(input: {
  snapshotId: string;
  snapshotToken: string;
  material: PageMaterial;
}): SyncEventsPageV1 {
  const events = Object.freeze(input.material.events.map((event): SequencedEventV1 => Object.freeze({
    eventSequence: event.eventSequence,
    envelope: event.envelope,
  })));
  return Object.freeze({
    snapshotId: input.snapshotId,
    snapshotToken: input.snapshotToken,
    fromSequence: input.material.fromSequence,
    toSequence: input.material.throughSequence,
    events,
    hasMore: input.material.hasMore,
  });
}

/** Device-signed, fixed-boundary snapshot pull and durable receipt acknowledgement. */
export class SyncService {
  private readonly repository: DeviceRepository;
  private readonly continuationKey: Promise<CryptoKey>;

  constructor(private readonly deps: {
    database: D1Database;
    verifier: DeviceRequestVerifier;
    events: SyncEventReader;
    continuationSecret: Uint8Array;
    now?: () => Date;
    snapshotId?: () => string;
    receiptId?: () => string;
    beforeSnapshotAction?: () => void | Promise<void>;
    beforeAcknowledge?: () => void | Promise<void>;
  }) {
    if (!(deps.continuationSecret instanceof Uint8Array) || deps.continuationSecret.byteLength !== 32) {
      throw new TypeError("sync_continuation_configuration_invalid");
    }
    this.repository = new DeviceRepository(deps.database);
    this.continuationKey = crypto.subtle.importKey(
      "raw", new Uint8Array(deps.continuationSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
  }

  async pull(
    request: SignedRequestV1,
    body: SyncEventsPullBodyV1,
    rawBody: Uint8Array,
  ): Promise<SyncEventsPageV1> {
    const now = validNow((this.deps.now ?? (() => new Date()))());
    const verified = await this.deps.verifier.verify(request, "POST", PULL_PATH, body, rawBody, now, validatePullBody);
    const consumerName = `device:${verified.deviceId}`;
    if (verified.body.consumerId !== consumerName) throw new Error("consumer_binding_invalid");
    await this.deps.beforeSnapshotAction?.();
    if (!await this.repository.isCurrentDevice(verified)) throw new Error("sync_device_state_changed");

    if (verified.body.snapshotToken === null) return this.createRootPage(verified, consumerName, now);
    return this.continuePage(verified, consumerName, now);
  }

  async acknowledgeDurableReceipt(
    request: SignedRequestV1,
    body: SyncEventsAckBodyV1,
    rawBody: Uint8Array,
  ): Promise<SyncAckReceiptV1> {
    const now = validNow((this.deps.now ?? (() => new Date()))());
    const verified = await this.deps.verifier.verify(request, "POST", ACK_PATH, body, rawBody, now, validateAckBody);
    const consumerName = `device:${verified.deviceId}`;
    const receiptKey = {
      snapshotId: verified.body.snapshotId,
      principalId: verified.principalId,
      deviceId: verified.deviceId,
      consumerName,
      expectedCurrent: verified.body.expectedCurrent,
      throughSequence: verified.body.throughSequence,
    };
    const replay = await this.repository.readSnapshotReceipt(receiptKey);
    if (replay !== null) return Object.freeze({ schemaVersion: "1.0", currentSequence: replay.current_sequence, replayed: true });

    await this.deps.beforeAcknowledge?.();
    const snapshot = await this.repository.readSnapshotById(verified.body.snapshotId);
    this.validateFirstAck(snapshot, verified, consumerName, now);
    if (snapshot === null) throw new Error("snapshot_not_found");

    let applied = false;
    try {
      applied = await this.repository.acknowledgeSnapshot({
        receiptId: (this.deps.receiptId ?? (() => `receipt:${crypto.randomUUID()}`))(),
        verified,
        snapshotId: snapshot.snapshot_id,
        consumerName,
        expectedCurrent: verified.body.expectedCurrent,
        throughSequence: verified.body.throughSequence,
        acknowledgedAt: now.toISOString(),
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("sync_cursor_compare_failed") && !error.message.includes("sync_snapshot_state_changed")) throw error;
    }
    if (applied) return Object.freeze({ schemaVersion: "1.0", currentSequence: verified.body.throughSequence, replayed: false });

    const racedReceipt = await this.repository.readSnapshotReceipt(receiptKey);
    if (racedReceipt !== null) return Object.freeze({ schemaVersion: "1.0", currentSequence: racedReceipt.current_sequence, replayed: true });
    if (!await this.repository.isCurrentDevice(verified)) throw new Error("sync_device_state_changed");
    const currentSnapshot = await this.repository.readSnapshotById(verified.body.snapshotId);
    this.validateFirstAck(currentSnapshot, verified, consumerName, now);
    const currentCursor = await this.repository.readCursor(consumerName);
    // An acknowledgement for a range the cursor already covers, accepted as a
    // replay. This is the reinstall case, and it is not hypothetical: a device
    // that acknowledged through 267 and then lost its archive pulls from 0,
    // commits 0→48, and acknowledges with `expectedCurrent: 0`. The cursor is
    // still 267, so `acknowledgeSnapshot` matches no row and the comparison
    // below refuses. The device re-pulls the same range and acknowledges the
    // same way, forever -- this is a stable state, not a transient race.
    //
    // Accepting the range as covered is the only answer that needs neither a
    // migration nor a hand-edit of production, and it is also the honest one:
    // the cursor reached 267 because this device acknowledged a superset, so no
    // event below `throughSequence` is invisible to it.
    //
    // What it gives up, stated rather than implied: an acknowledgement stops
    // being proof that *this* archive durably stored the range. The device
    // asserts it and the cloud cannot check it -- but it cannot check it for a
    // first-time acknowledgement either, since the cursor is the device's own
    // position in both cases. What is preserved is the direction: this branch
    // requires `throughSequence <= cursor`, so an acknowledgement reaching it
    // cannot move a cursor forward, and therefore cannot move one backwards.
    if (currentCursor >= verified.body.throughSequence) {
      return Object.freeze({ schemaVersion: "1.0", currentSequence: currentCursor, replayed: true });
    }
    if (currentCursor !== verified.body.expectedCurrent) throw new Error("cursor_compare_failed");
    throw new Error("sync_snapshot_state_changed");
  }

  private async createRootPage(
    verified: VerifiedDeviceRequest<SyncEventsPullBodyV1>,
    consumerName: string,
    now: Date,
  ): Promise<SyncEventsPageV1> {
    const upper = await this.deps.events.latestSequence();
    if (!nonNegativeSequence(upper)) throw new Error("event_sequence_invalid");
    if (verified.body.afterSequence > upper) throw new Error("sync_after_sequence_ahead");
    const material = await this.readMaterial(verified.body.afterSequence, verified.body.pageSize, upper);
    const snapshotId = this.newSnapshotId();
    const snapshotToken = await this.snapshotToken(snapshotId);
    const outputTokenHash = await this.tokenHash(snapshotToken);
    const expiresAt = new Date(now.valueOf() + SNAPSHOT_LIFETIME_MS).toISOString();
    const created = await this.repository.createSyncSnapshot({
      snapshotId, verified, consumerName, rootSnapshotId: snapshotId, inputTokenHash: null,
      outputTokenHash, materialHash: verified.bodyHash, rootUpperSequence: upper,
      fromSequence: material.fromSequence, throughSequence: material.throughSequence,
      boundaryStartEventId: material.boundaryStartEventId, boundaryEndEventId: material.boundaryEndEventId,
      eventCount: material.events.length, hasMore: material.hasMore, expiresAt, createdAt: now.toISOString(),
    });
    if (!created) throw new Error("sync_device_state_changed");
    return freezePage({ snapshotId, snapshotToken, material });
  }

  private async continuePage(
    verified: VerifiedDeviceRequest<SyncEventsPullBodyV1>,
    consumerName: string,
    now: Date,
  ): Promise<SyncEventsPageV1> {
    const token = verified.body.snapshotToken;
    if (token === null) throw new Error("snapshot_token_invalid");
    const inputTokenHash = await this.tokenHash(token);
    const parent = await this.repository.readSnapshotByOutputToken(inputTokenHash);
    if (parent === null) throw new Error("snapshot_token_invalid");
    if (!snapshotOwnerMatches(parent, verified, consumerName)) throw new Error("snapshot_owner_mismatch");
    if (parent.expires_at <= now.toISOString()) throw new Error("snapshot_expired");
    if (parent.has_more !== 1) throw new Error("snapshot_continuation_complete");
    if (verified.body.afterSequence !== parent.through_sequence) throw new Error("snapshot_continuation_boundary_mismatch");

    const existing = await this.repository.readSnapshotByInputToken(inputTokenHash);
    if (existing !== null) return this.replayContinuation(existing, verified, consumerName, now);

    const material = await this.readMaterial(verified.body.afterSequence, verified.body.pageSize, parent.root_upper_sequence);
    const snapshotId = this.newSnapshotId();
    const snapshotToken = await this.snapshotToken(snapshotId);
    const outputTokenHash = await this.tokenHash(snapshotToken);
    try {
      const created = await this.repository.createSyncSnapshot({
        snapshotId, verified, consumerName, rootSnapshotId: parent.root_snapshot_id, inputTokenHash,
        outputTokenHash, materialHash: verified.bodyHash, rootUpperSequence: parent.root_upper_sequence,
        fromSequence: material.fromSequence, throughSequence: material.throughSequence,
        boundaryStartEventId: material.boundaryStartEventId, boundaryEndEventId: material.boundaryEndEventId,
        eventCount: material.events.length, hasMore: material.hasMore, expiresAt: parent.expires_at, createdAt: now.toISOString(),
      });
      if (!created) throw new Error("sync_device_state_changed");
      return freezePage({ snapshotId, snapshotToken, material });
    } catch (error) {
      const winner = await this.repository.readSnapshotByInputToken(inputTokenHash);
      if (winner !== null) return this.replayContinuation(winner, verified, consumerName, now);
      throw error;
    }
  }

  private async replayContinuation(
    snapshot: SyncSnapshotRow,
    verified: VerifiedDeviceRequest<SyncEventsPullBodyV1>,
    consumerName: string,
    now: Date,
  ): Promise<SyncEventsPageV1> {
    if (!snapshotOwnerMatches(snapshot, verified, consumerName)) throw new Error("snapshot_owner_mismatch");
    if (snapshot.expires_at <= now.toISOString()) throw new Error("snapshot_expired");
    if (snapshot.material_hash !== verified.bodyHash) throw new Error("snapshot_continuation_conflict");
    if (snapshot.from_sequence !== verified.body.afterSequence) throw new Error("snapshot_continuation_boundary_mismatch");
    return this.pageFromStored(snapshot);
  }

  private async pageFromStored(snapshot: SyncSnapshotRow): Promise<SyncEventsPageV1> {
    if (!nonNegativeSequence(snapshot.from_sequence) || !nonNegativeSequence(snapshot.through_sequence)
      || !nonNegativeSequence(snapshot.root_upper_sequence) || !nonNegativeSequence(snapshot.event_count)
      || snapshot.through_sequence !== snapshot.from_sequence + snapshot.event_count
      || snapshot.through_sequence > snapshot.root_upper_sequence
      || (snapshot.has_more === 1) !== (snapshot.through_sequence < snapshot.root_upper_sequence)) {
      throw new Error("snapshot_boundary_corrupt");
    }
    const events = snapshot.event_count === 0 ? [] : await this.deps.events.readRange(snapshot.from_sequence, snapshot.event_count);
    const material = this.validateMaterial(snapshot.from_sequence, snapshot.root_upper_sequence, events, snapshot.event_count);
    if (material.throughSequence !== snapshot.through_sequence
      || material.boundaryStartEventId !== snapshot.boundary_start_event_id
      || material.boundaryEndEventId !== snapshot.boundary_end_event_id
      || material.hasMore !== (snapshot.has_more === 1)) {
      throw new Error("snapshot_boundary_corrupt");
    }
    const snapshotToken = await this.snapshotToken(snapshot.snapshot_id);
    if (await this.tokenHash(snapshotToken) !== snapshot.output_token_hash) throw new Error("snapshot_token_corrupt");
    return freezePage({ snapshotId: snapshot.snapshot_id, snapshotToken, material });
  }

  private async readMaterial(afterSequence: number, pageSize: number, upperSequence: number): Promise<PageMaterial> {
    if (afterSequence > upperSequence) throw new Error("snapshot_continuation_boundary_mismatch");
    const count = Math.min(pageSize, upperSequence - afterSequence, MAXIMUM_MATERIAL_EVENTS);
    const events = count === 0 ? [] : await this.deps.events.readRange(afterSequence, count);
    return this.validateMaterial(afterSequence, upperSequence, events, count);
  }

  private validateMaterial(
    afterSequence: number,
    upperSequence: number,
    events: readonly AppendedEvent[],
    expectedCount: number,
  ): PageMaterial {
    if (events.length !== expectedCount) throw new Error("sync_event_range_incomplete");
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined || event.eventSequence !== afterSequence + index + 1
        || event.envelope.eventSequence !== event.eventSequence) {
        throw new Error("sync_event_range_incomplete");
      }
    }
    const throughSequence = afterSequence + events.length;
    return {
      fromSequence: afterSequence,
      throughSequence,
      events: Object.freeze([...events]),
      boundaryStartEventId: events[0]?.envelope.eventId ?? null,
      boundaryEndEventId: events.at(-1)?.envelope.eventId ?? null,
      hasMore: throughSequence < upperSequence,
    };
  }

  private validateFirstAck(
    snapshot: SyncSnapshotRow | null,
    verified: VerifiedDeviceRequest<SyncEventsAckBodyV1>,
    consumerName: string,
    now: Date,
  ): void {
    if (snapshot === null) throw new Error("snapshot_not_found");
    if (!snapshotOwnerMatches(snapshot, verified, consumerName)) throw new Error("snapshot_owner_mismatch");
    if (snapshot.from_sequence !== verified.body.expectedCurrent || snapshot.through_sequence !== verified.body.throughSequence) {
      throw new Error("snapshot_boundary_mismatch");
    }
    if (snapshot.acknowledged_at !== null) throw new Error("snapshot_ack_conflict");
    if (snapshot.expires_at <= now.toISOString()) throw new Error("snapshot_expired");
  }

  private newSnapshotId(): string {
    const snapshotId = (this.deps.snapshotId ?? (() => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return encodeBase64Url(bytes);
    }))();
    decodeCanonicalBase64Url(snapshotId, 32, "snapshot_id_invalid");
    return snapshotId;
  }

  private async snapshotToken(snapshotId: string): Promise<string> {
    const input = encoder.encode(canonicalJson({ domain: "jarvis.sync.continuation.v1", snapshotId }));
    return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", await this.continuationKey, input)));
  }

  private tokenHash(token: string): Promise<Sha256Hex> {
    return sha256Hex(decodeCanonicalBase64Url(token, 32, "snapshot_token_invalid"));
  }
}
