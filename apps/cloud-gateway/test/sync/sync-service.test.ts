import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalize,
  createEnvelope,
  newUlid,
  sha256Hex,
  type PersistableEventEnvelopeV1,
  type Sha256Hex,
  type SignedRequestV1,
  type SyncEventsAckBodyV1,
  type SyncEventsPullBodyV1,
} from "../../../../packages/contracts/src/index.js";
import { EventRepository, type SyncEventReader } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import { SyncService } from "../../src/sync/sync-service.js";
import { applyFoundationMigration } from "../persistence/migration.js";

const audience = "jarvis-local-agent";
const pullPath = "/sync/pull";
const ackPath = "/sync/ack";
const initialNow = new Date("2026-08-30T12:00:00.000Z");
const eventTimestamp = "2026-08-30T11:00:00.000Z";

interface SigningIdentity {
  readonly deviceId: string;
  readonly principalId: string;
  readonly privateKey: CryptoKey;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encoded32(seed: number): string {
  return base64Url(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256));
}

async function eventFixture(label: string): Promise<PersistableEventEnvelopeV1> {
  const token = new Redactor().redact({ text: `api key = ${label}-secret`, channel: "telegram", field: "message.text" });
  if (!token.ok) throw new Error("fixture redaction failed");
  return createEnvelope({
    schemaVersion: "1.0",
    eventId: newUlid(),
    eventType: "telegram.update",
    source: "telegram",
    subjectId: "principal:one",
    occurredAt: eventTimestamp,
    receivedAt: eventTimestamp,
    correlationId: newUlid(),
    contentType: "application/json",
    payload: { message: token },
    producerVersion: "test",
  });
}

describe("SyncService", () => {
  let primary: SigningIdentity;
  let verifier: DeviceRequestVerifier;
  let events: EventRepository;
  let sync: SyncService;
  let currentNow: Date;
  let nonceSeed: number;
  let snapshotSeed: number;

  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sync_ack_receipts"),
      env.DB.prepare("DELETE FROM sync_snapshots"),
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM consumer_cursors"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
    ]);
    currentNow = new Date(initialNow);
    nonceSeed = 1;
    snapshotSeed = 101;
    primary = await insertDevice({ principalId: "principal:one", principalType: "human", deviceId: "device:one", keyId: "key:one" });
    verifier = new DeviceRequestVerifier({ database: env.DB, audience });
    events = new EventRepository(env.DB);
    sync = makeService(events);
  });

  async function insertDevice(input: {
    principalId: string;
    principalType: "human" | "service";
    deviceId: string;
    keyId: string;
  }): Promise<SigningIdentity> {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const fingerprint = await sha256Hex(publicKey);
    if (input.principalType === "human") {
      await env.DB.prepare(
        "INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES (?, 'human', 'active', 'Sid', '1.0', 'PIN_VERIFIER_JSON', ?, ?)",
      ).bind(input.principalId, initialNow.toISOString(), initialNow.toISOString()).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'service', 'active', 'service', ?, ?)",
      ).bind(input.principalId, initialNow.toISOString(), initialNow.toISOString()).run();
    }
    await env.DB.prepare(
      "INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at) VALUES (?, ?, ?, ?, ?, 1, 'ed25519', 'active', 'test', ?, ?)",
    ).bind(input.deviceId, input.principalId, input.keyId, base64(publicKey), fingerprint, "0".repeat(64), initialNow.toISOString()).run();
    await env.DB.prepare("INSERT INTO consumer_cursors (consumer_name, current_sequence, updated_at) VALUES (?, 0, ?)")
      .bind(`device:${input.deviceId}`, initialNow.toISOString()).run();
    return { deviceId: input.deviceId, principalId: input.principalId, privateKey: pair.privateKey };
  }

  function makeService(reader: SyncEventReader, overrides: Partial<ConstructorParameters<typeof SyncService>[0]> = {}): SyncService {
    return new SyncService({
      database: env.DB,
      verifier,
      events: reader,
      continuationSecret: Uint8Array.from({ length: 32 }, (_, index) => 201 - index),
      now: () => new Date(currentNow),
      snapshotId: () => encoded32(snapshotSeed++),
      ...overrides,
    });
  }

  async function append(count: number): Promise<void> {
    const start = await events.latestSequence();
    for (let index = 1; index <= count; index += 1) {
      const label = `event-${start + index}`;
      await events.append({
        envelope: await eventFixture(label),
        scope: "telegram:update",
        key: label,
        requestHash: await sha256Hex(canonicalJson({ label })),
      });
    }
  }

  async function signed<T extends object>(path: string, body: T, identity = primary): Promise<{ request: SignedRequestV1; rawBody: Uint8Array }> {
    const rawBody = canonicalize(body);
    const unsigned = {
      schemaVersion: "1.0" as const,
      deviceId: identity.deviceId,
      principalId: identity.principalId,
      audience,
      issuedAt: currentNow.toISOString(),
      nonce: encoded32(nonceSeed++),
      bodyHash: await sha256Hex(rawBody),
    };
    const text = new TextEncoder().encode([
      "POST", path, unsigned.deviceId, unsigned.principalId, unsigned.audience, unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
    ].join("\n"));
    return {
      request: { ...unsigned, signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", identity.privateKey, text))) },
      rawBody,
    };
  }

  function pullBody(afterSequence = 0, pageSize = 100, snapshotToken: string | null = null, deviceId = primary.deviceId): SyncEventsPullBodyV1 {
    return { schemaVersion: "1.0", consumerId: `device:${deviceId}`, afterSequence, pageSize, snapshotToken };
  }

  async function pull(body: SyncEventsPullBodyV1, identity = primary) {
    const request = await signed(pullPath, body, identity);
    return sync.pull(request.request, body, request.rawBody);
  }

  async function acknowledge(body: SyncEventsAckBodyV1, identity = primary) {
    const request = await signed(ackPath, body, identity);
    return sync.acknowledgeDurableReceipt(request.request, body, request.rawBody);
  }

  async function cursor(identity = primary): Promise<number> {
    return (await env.DB.prepare("SELECT current_sequence FROM consumer_cursors WHERE consumer_name = ?")
      .bind(`device:${identity.deviceId}`).first<{ current_sequence: number }>())?.current_sequence ?? -1;
  }

  it("captures one inclusive upper sequence, returns contiguous pages, and excludes later appends", async () => {
    await append(3);
    expect(await events.latestSequence()).toBe(3);

    const first = await pull(pullBody(0, 2));
    expect(first).toMatchObject({ fromSequence: 0, toSequence: 2, hasMore: true });
    expect(first.events.map((event) => event.eventSequence)).toEqual([1, 2]);
    expect(await cursor()).toBe(0);
    await append(1);
    expect(await events.latestSequence()).toBe(4);

    const second = await pull(pullBody(2, 2, first.snapshotToken));
    expect(second).toMatchObject({ fromSequence: 2, toSequence: 3, hasMore: false });
    expect(second.events.map((event) => event.eventSequence)).toEqual([3]);
    expect((await env.DB.prepare("SELECT DISTINCT root_upper_sequence FROM sync_snapshots").all<{ root_upper_sequence: number }>()).results).toEqual([{ root_upper_sequence: 3 }]);
    expect(await cursor()).toBe(0);
  });

  it("stores only continuation-token hashes and reproduces the same child page for a fresh-nonce semantic retry", async () => {
    await append(4);
    const root = await pull(pullBody(0, 1));
    const childBody = pullBody(1, 1, root.snapshotToken);

    const child = await pull(childBody);
    const retry = await pull(childBody);

    expect(retry).toEqual(child);
    expect(child.snapshotToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await env.DB.prepare("SELECT * FROM sync_snapshots WHERE snapshot_id = ?").bind(child.snapshotId).first<Record<string, unknown>>();
    expect(stored?.output_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(child.snapshotToken);
    await expect(pull(pullBody(1, 2, root.snapshotToken))).rejects.toThrow("snapshot_continuation_conflict");
  });

  it("atomically converges concurrent uses of the same continuation token on one immutable child page", async () => {
    await append(3);
    const root = await pull(pullBody(0, 1));
    const body = pullBody(1, 1, root.snapshotToken);
    const first = await signed(pullPath, body);
    const second = await signed(pullPath, body);

    const pages = await Promise.all([
      sync.pull(first.request, body, first.rawBody),
      sync.pull(second.request, body, second.rawBody),
    ]);

    expect(pages[0]).toEqual(pages[1]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_snapshots WHERE input_token_hash IS NOT NULL").first<{ count: number }>())?.count).toBe(1);
  });

  it("strictly rejects malformed pull bodies, noncanonical tokens, and supplied/raw splits before snapshot creation", async () => {
    const invalidBodies: object[] = [
      { ...pullBody(), afterSequence: -1 },
      { ...pullBody(), pageSize: 0 },
      { ...pullBody(), pageSize: 501 },
      { ...pullBody(), snapshotToken: "short" },
      { ...pullBody(), admin: true },
    ];
    for (const body of invalidBodies) {
      const request = await signed(pullPath, body);
      await expect(sync.pull(request.request, body as SyncEventsPullBodyV1, request.rawBody)).rejects.toThrow("sync_pull_body_invalid");
    }
    const authoritative = pullBody(0, 2);
    const request = await signed(pullPath, authoritative);
    await expect(sync.pull(request.request, pullBody(0, 3), request.rawBody)).rejects.toThrow("signed_body_mismatch");
    await expect(pull({ ...pullBody(), consumerId: "device:other" })).rejects.toThrow("consumer_binding_invalid");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_snapshots").first<{ count: number }>())?.count).toBe(0);
  });

  it("rejects a continuation at exact root expiry", async () => {
    await append(2);
    const root = await pull(pullBody(0, 1));
    const expiry = await env.DB.prepare("SELECT expires_at FROM sync_snapshots WHERE snapshot_id = ?").bind(root.snapshotId).first<{ expires_at: string }>();
    if (expiry === null) throw new Error("missing snapshot fixture");
    currentNow = new Date(expiry.expires_at);

    await expect(pull(pullBody(1, 1, root.snapshotToken))).rejects.toThrow("snapshot_expired");
  });

  it("fails closed on a noncontiguous event reader without persisting a page", async () => {
    await append(2);
    const incomplete: SyncEventReader = {
      latestSequence: () => events.latestSequence(),
      readRange: async (afterSequence, limit) => (await events.readRange(afterSequence, limit)).slice(1),
    };
    sync = makeService(incomplete);

    await expect(pull(pullBody(0, 2))).rejects.toThrow("sync_event_range_incomplete");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_snapshots").first<{ count: number }>())?.count).toBe(0);
  });

  it("atomically acknowledges an exact issued boundary and replays only its durable receipt", async () => {
    await append(2);
    const page = await pull(pullBody(0, 2));
    const body: SyncEventsAckBodyV1 = { schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: 2 };

    await expect(acknowledge(body)).resolves.toEqual({ schemaVersion: "1.0", currentSequence: 2, replayed: false });
    expect(await cursor()).toBe(2);
    await expect(acknowledge(body)).resolves.toEqual({ schemaVersion: "1.0", currentSequence: 2, replayed: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_ack_receipts WHERE receipt_kind = 'snapshot'").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT acknowledged_at FROM sync_snapshots WHERE snapshot_id = ?").bind(page.snapshotId).first<{ acknowledged_at: string | null }>())?.acknowledged_at).toBe(initialNow.toISOString());
  });

  it("strictly rejects malformed ACK bodies and supplied/raw splits before creating a receipt", async () => {
    await append(1);
    const page = await pull(pullBody(0, 1));
    const nonceBaseline = (await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count;
    const invalidBodies: object[] = [
      { schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 1, throughSequence: 0 },
      { schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: 1, admin: true },
      { schemaVersion: "1.0", snapshotId: "short", expectedCurrent: 0, throughSequence: 1 },
    ];
    for (const body of invalidBodies) {
      const request = await signed(ackPath, body);
      await expect(sync.acknowledgeDurableReceipt(request.request, body as SyncEventsAckBodyV1, request.rawBody)).rejects.toThrow("sync_ack_body_invalid");
    }
    const authoritative: SyncEventsAckBodyV1 = { schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: 1 };
    const request = await signed(ackPath, authoritative);
    await expect(sync.acknowledgeDurableReceipt(request.request, { ...authoritative, throughSequence: 0 }, request.rawBody)).rejects.toThrow("signed_body_mismatch");

    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(nonceBaseline);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_ack_receipts WHERE receipt_kind = 'snapshot'").first<{ count: number }>())?.count).toBe(0);
    expect(await cursor()).toBe(0);
  });

  it("permits exactly one first-time ACK under a concurrent fresh-nonce retry race", async () => {
    await append(2);
    const page = await pull(pullBody(0, 2));
    const body: SyncEventsAckBodyV1 = { schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: 2 };
    const first = await signed(ackPath, body);
    const second = await signed(ackPath, body);

    const receipts = await Promise.all([
      sync.acknowledgeDurableReceipt(first.request, body, first.rawBody),
      sync.acknowledgeDurableReceipt(second.request, body, second.rawBody),
    ]);

    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);
    expect(await cursor()).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_ack_receipts WHERE receipt_kind = 'snapshot'").first<{ count: number }>())?.count).toBe(1);
  });

  it("writes and replays a durable empty-page receipt without advancing the zero-width cursor", async () => {
    const page = await pull(pullBody(0, 100));
    expect(page).toMatchObject({ fromSequence: 0, toSequence: 0, events: [], hasMore: false });
    const body: SyncEventsAckBodyV1 = { schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: 0 };

    await expect(acknowledge(body)).resolves.toEqual({ schemaVersion: "1.0", currentSequence: 0, replayed: false });
    expect(await cursor()).toBe(0);
    await env.DB.prepare("DELETE FROM sync_snapshots WHERE snapshot_id = ?").bind(page.snapshotId).run();
    currentNow = new Date("2026-08-30T13:00:00.000Z");
    await expect(acknowledge(body)).resolves.toEqual({ schemaVersion: "1.0", currentSequence: 0, replayed: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_ack_receipts WHERE snapshot_id = ?").bind(page.snapshotId).first<{ count: number }>())?.count).toBe(1);
  });

  it("acknowledges from the immutable page boundary after all referenced D1 event rows are purged", async () => {
    await append(2);
    const page = await pull(pullBody(0, 2));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"),
      env.DB.prepare("DELETE FROM events"),
    ]);
    const body: SyncEventsAckBodyV1 = { schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: 2 };

    await expect(acknowledge(body)).resolves.toEqual({ schemaVersion: "1.0", currentSequence: 2, replayed: false });
    expect(await cursor()).toBe(2);
  });

  it("rejects boundary mismatches, stale cursors, and first-time ACKs at exact expiry", async () => {
    await append(2);
    const boundaryPage = await pull(pullBody(0, 2));
    await expect(acknowledge({ schemaVersion: "1.0", snapshotId: boundaryPage.snapshotId, expectedCurrent: 0, throughSequence: 1 }))
      .rejects.toThrow("snapshot_boundary_mismatch");
    await env.DB.prepare("UPDATE consumer_cursors SET current_sequence = 2 WHERE consumer_name = ?").bind(`device:${primary.deviceId}`).run();
    await expect(acknowledge({ schemaVersion: "1.0", snapshotId: boundaryPage.snapshotId, expectedCurrent: 0, throughSequence: 2 }))
      .rejects.toThrow("cursor_compare_failed");
    await env.DB.prepare("UPDATE consumer_cursors SET current_sequence = 0 WHERE consumer_name = ?").bind(`device:${primary.deviceId}`).run();
    const expiry = await env.DB.prepare("SELECT expires_at FROM sync_snapshots WHERE snapshot_id = ?").bind(boundaryPage.snapshotId).first<{ expires_at: string }>();
    if (expiry === null) throw new Error("missing snapshot fixture");
    currentNow = new Date(expiry.expires_at);
    await expect(acknowledge({ schemaVersion: "1.0", snapshotId: boundaryPage.snapshotId, expectedCurrent: 0, throughSequence: 2 }))
      .rejects.toThrow("snapshot_expired");
    expect(await cursor()).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_ack_receipts WHERE receipt_kind = 'snapshot'").first<{ count: number }>())?.count).toBe(0);
  });

  it("binds continuation and ACK ownership to the exact enrolled device and principal", async () => {
    await append(2);
    const root = await pull(pullBody(0, 1));
    const foreign = await insertDevice({ principalId: "service:other", principalType: "service", deviceId: "device:other", keyId: "key:other" });

    await expect(pull(pullBody(1, 1, root.snapshotToken, foreign.deviceId), foreign)).rejects.toThrow("snapshot_owner_mismatch");
    await expect(acknowledge({ schemaVersion: "1.0", snapshotId: root.snapshotId, expectedCurrent: 0, throughSequence: 1 }, foreign))
      .rejects.toThrow("snapshot_owner_mismatch");
    expect(await cursor(foreign)).toBe(0);
  });

  it("persists snapshot and ACK receipt rows under the verified device-principal composite", async () => {
    await append(1);
    const page = await pull(pullBody(0, 1));
    const foreign = await insertDevice({ principalId: "service:other", principalType: "service", deviceId: "device:other", keyId: "key:other" });

    await expect(env.DB.prepare("UPDATE sync_snapshots SET principal_id = ? WHERE snapshot_id = ?")
      .bind(foreign.principalId, page.snapshotId).run()).rejects.toThrow();
    await acknowledge({ schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: 1 });
    await expect(env.DB.prepare("UPDATE sync_ack_receipts SET principal_id = ? WHERE snapshot_id = ?")
      .bind(foreign.principalId, page.snapshotId).run()).rejects.toThrow();

    expect(await env.DB.prepare(
      "SELECT principal_id, device_id, receipt_kind FROM sync_ack_receipts WHERE snapshot_id = ?",
    ).bind(page.snapshotId).first()).toEqual({
      principal_id: primary.principalId,
      device_id: primary.deviceId,
      receipt_kind: "snapshot",
    });
  });

  it("loses a post-verification revocation race before snapshot creation", async () => {
    sync = makeService(events, {
      beforeSnapshotAction: async () => {
        await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
          .bind(initialNow.toISOString(), primary.deviceId).run();
      },
    });

    await expect(pull(pullBody())).rejects.toThrow("sync_device_state_changed");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_snapshots").first<{ count: number }>())?.count).toBe(0);
  });

  it("loses a post-verification revocation race before atomic ACK mutation", async () => {
    await append(1);
    const page = await pull(pullBody(0, 1));
    sync = makeService(events, {
      beforeAcknowledge: async () => {
        await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
          .bind(initialNow.toISOString(), primary.deviceId).run();
      },
    });
    const body: SyncEventsAckBodyV1 = { schemaVersion: "1.0", snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: 1 };

    await expect(acknowledge(body)).rejects.toThrow("sync_device_state_changed");
    expect(await cursor()).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_ack_receipts WHERE receipt_kind = 'snapshot'").first<{ count: number }>())?.count).toBe(0);
  });
});
