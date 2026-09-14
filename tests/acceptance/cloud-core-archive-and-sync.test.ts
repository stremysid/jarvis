import { permittedOutboundControls } from "../../apps/cloud-gateway/test/policy/outbound-controls-fixture.js";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  canonicalJson, canonicalize, createEnvelope, newUlid, sha256Hex,
  type OutboundCallCommand, type SignedRequestV1, type SyncEventsAckBodyV1,
  type SyncEventsPageV1, type SyncEventsPullBodyV1,
} from "../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../../apps/cloud-gateway/src/archive/archive-repository.js";
import { ArchivalService } from "../../apps/cloud-gateway/src/archive/archival-service.js";
import { TieredEventReader } from "../../apps/cloud-gateway/src/archive/tiered-event-reader.js";
import { OutboundCallDispatcher } from "../../apps/cloud-gateway/src/calls/outbound-call-dispatcher.js";
import { CallRepository } from "../../apps/cloud-gateway/src/persistence/call-repository.js";
import { EventRepository } from "../../apps/cloud-gateway/src/persistence/event-repository.js";
import { PolicyEngine, type MutablePolicyContext } from "../../apps/cloud-gateway/src/policy/policy-engine.js";
import { FakeTwilioProvider } from "../../apps/cloud-gateway/src/providers/fake-twilio-provider.js";
import { Redactor } from "../../apps/cloud-gateway/src/security/redaction.js";
import { DeviceEnrollment, type DeviceEnrollmentIdFactory, type DeviceEnrollmentResult } from "../../apps/cloud-gateway/src/sync/device-enrollment.js";
import { DeviceRequestVerifier, encodeBase64Url } from "../../apps/cloud-gateway/src/sync/signed-request.js";
import { SyncService } from "../../apps/cloud-gateway/src/sync/sync-service.js";
import { resetArchiveFixture } from "../../apps/cloud-gateway/test/archive/archive-fixture.js";

const enrollmentNow = new Date("2026-08-30T12:00:00.000Z");
const archiveNow = new Date("2026-12-01T12:00:00.000Z");
const syncNow = new Date("2026-12-01T12:01:00.000Z");
const eventTimestamp = "2026-08-30T12:00:00.000Z";
const audience = "jarvis-local-agent";
const pullPath = "/sync/pull";
const ackPath = "/sync/ack";
interface EnrolledDevice extends DeviceEnrollmentResult { readonly privateKey: CryptoKey }
interface ExpectedEvent {
  readonly eventSequence: number;
  readonly eventId: string;
  readonly sequencedEnvelopeSha256: string;
  readonly contentHash: string;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function encoded32(seed: number): string {
  return encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256));
}

function enrollmentIds(): DeviceEnrollmentIdFactory {
  return {
    principalId: () => "principal:acceptance",
    deviceId: () => "device:acceptance",
    keyId: () => "key:acceptance",
    phoneIdentityId: () => "identity:acceptance:voice",
    telegramIdentityId: () => "identity:acceptance:telegram",
  };
}

async function resetAcceptanceState(): Promise<void> {
  await resetArchiveFixture();
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
  ]);
}

async function bootstrapOneDevice(): Promise<EnrolledDevice> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const bootstrapTokenBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const bootstrapToken = encoded32(1);
  await env.DB.prepare(
    "INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, expires_at, issued_at, intended_channel, device_label, issued_by) VALUES (?, ?, ?, ?, 'local', 'Jarvis laptop', 'setup')",
  ).bind(
    "bootstrap:acceptance", await sha256Hex(bootstrapTokenBytes),
    "2026-08-30T12:15:00.000Z", enrollmentNow.toISOString(),
  ).run();
  const enrolled = await new DeviceEnrollment({
    database: env.DB, now: () => new Date(enrollmentNow), ids: enrollmentIds(),
  }).bootstrap({
    schemaVersion: "1.0", bootstrapToken, displayName: "Sid", deviceLabel: "Jarvis laptop",
    publicKeyBase64: base64(publicKey), phoneProviderSubject: "+14165550123", telegramProviderSubject: "424242",
  });
  return { ...enrolled, privateKey: pair.privateKey };
}

async function appendCanonicalEvents(events: EventRepository, enrolled: EnrolledDevice, count: number): Promise<readonly ExpectedEvent[]> {
  const expected: ExpectedEvent[] = [];
  const redactor = new Redactor();
  for (let index = 1; index <= count; index += 1) {
    const message = redactor.redact({
      text: `api key = acceptance-${index}-secret`, channel: "telegram", field: "message.text",
    });
    if (!message.ok) throw new Error("acceptance_redaction_failed");
    const envelope = await createEnvelope({
      schemaVersion: "1.0", eventId: newUlid(), eventType: "telegram.update", source: "telegram",
      subjectId: enrolled.principalId, occurredAt: eventTimestamp, receivedAt: eventTimestamp,
      correlationId: newUlid(), contentType: "application/json", payload: { index, accepted: true, message },
      producerVersion: "acceptance-v1",
    });
    const appended = await events.append({
      envelope, scope: "acceptance:event", key: `event:${index}`,
      requestHash: await sha256Hex(canonicalJson({ index })),
    });
    expected.push({
      eventSequence: appended.eventSequence,
      eventId: appended.envelope.eventId,
      sequencedEnvelopeSha256: await sha256Hex(canonicalJson(appended.envelope)),
      contentHash: appended.envelope.contentHash,
    });
  }
  return expected;
}

async function archiveAndPurgeEligibleEvents(archive: ArchivalService): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE events SET created_at = ? WHERE sequence BETWEEN 1 AND 600").bind("2026-08-30T12:00:00.000Z"),
    env.DB.prepare("UPDATE events SET created_at = ? WHERE sequence BETWEEN 601 AND 1000").bind("2026-11-30T12:00:00.000Z"),
    env.DB.prepare("UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE event_sequence BETWEEN 1 AND 600")
      .bind("2026-08-30T12:01:00.000Z"),
  ]);
  const manifests = [];
  for (let attempt = 0; attempt < 26; attempt += 1) {
    const manifest = await archive.archiveEligible(archiveNow, 1_000);
    if (manifest === null) break;
    manifests.push(manifest);
  }
  expect(manifests).toHaveLength(25);
  expect(manifests.map((manifest) => [manifest.startSequence, manifest.endSequence, manifest.eventCount]))
    .toEqual(Array.from({ length: 25 }, (_, index) => [index * 24 + 1, (index + 1) * 24, 24]));
  expect(await new ArchiveRepository(env.DB).readState()).toEqual({
    sealedThrough: 600, circuitState: "closed", circuitReason: null, circuitOpenedAt: null,
  });
  expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(25);
  expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_segment_events").first<{ count: number }>())?.count).toBe(600);
  expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(600);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count, MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence FROM events").first())
    .toEqual({ count: 400, first_sequence: 601, last_sequence: 1000 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count, MIN(event_sequence) AS first_sequence, MAX(event_sequence) AS last_sequence FROM outbox").first())
    .toEqual({ count: 400, first_sequence: 601, last_sequence: 1000 });
  const objects = await env.ARCHIVE.list({ prefix: "events/sha256/" });
  expect(objects.truncated).toBe(false);
  expect(objects.objects).toHaveLength(25);
}

class SignedDeviceClient {
  private nonceSeed = 1;
  constructor(private readonly device: EnrolledDevice) {}

  async sign<T extends object>(path: string, body: T): Promise<{ request: SignedRequestV1; rawBody: Uint8Array }> {
    const rawBody = canonicalize(body);
    const unsigned = {
      schemaVersion: "1.0" as const, deviceId: this.device.deviceId, principalId: this.device.principalId,
      audience, issuedAt: syncNow.toISOString(), nonce: encoded32(this.nonceSeed++), bodyHash: await sha256Hex(rawBody),
    };
    const material = new TextEncoder().encode([
      "POST", path, unsigned.deviceId, unsigned.principalId, unsigned.audience,
      unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
    ].join("\n"));
    return {
      request: {
        ...unsigned,
        signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", this.device.privateKey, material))),
      },
      rawBody,
    };
  }
}

async function pullIntoEmptyLocalArchive(input: {
  enrolled: EnrolledDevice; sync: SyncService; expected: readonly ExpectedEvent[];
}): Promise<{ local: readonly ExpectedEvent[]; pages: readonly SyncEventsPageV1[] }> {
  const client = new SignedDeviceClient(input.enrolled);
  const local: ExpectedEvent[] = [];
  const pages: SyncEventsPageV1[] = [];
  const operations: { kind: "commit" | "ack"; snapshotId: string }[] = [];
  let afterSequence = 0;
  let snapshotToken: string | null = null;
  let lastAck: SyncEventsAckBodyV1 | null = null;
  while (true) {
    const body: SyncEventsPullBodyV1 = {
      schemaVersion: "1.0", consumerId: `device:${input.enrolled.deviceId}`,
      afterSequence, pageSize: 500, snapshotToken,
    };
    const signedPull = await client.sign(pullPath, body);
    const page = await input.sync.pull(signedPull.request, body, signedPull.rawBody);
    if (pages.length === 0) {
      await expect(input.sync.pull(signedPull.request, body, signedPull.rawBody)).rejects.toThrow("replayed_nonce");
    }
    expect(page.fromSequence).toBe(afterSequence);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.length).toBeLessThanOrEqual(48);
    for (const event of page.events) {
      const original = input.expected[event.eventSequence - 1];
      if (original === undefined) throw new Error("acceptance_expected_event_missing");
      const sequencedEnvelopeSha256 = await sha256Hex(canonicalJson(event.envelope));
      const recomputedContentHash = await sha256Hex(canonicalJson(event.envelope.payload));
      expect(event.envelope.eventId).toBe(original.eventId);
      expect(sequencedEnvelopeSha256).toBe(original.sequencedEnvelopeSha256);
      expect(event.envelope.contentHash).toBe(original.contentHash);
      expect(recomputedContentHash).toBe(event.envelope.contentHash);
      local.push({
        eventSequence: event.eventSequence,
        eventId: event.envelope.eventId,
        sequencedEnvelopeSha256,
        contentHash: event.envelope.contentHash,
      });
    }
    pages.push(page);
    operations.push({ kind: "commit", snapshotId: page.snapshotId });
    const ackBody: SyncEventsAckBodyV1 = {
      schemaVersion: "1.0", snapshotId: page.snapshotId,
      expectedCurrent: page.fromSequence, throughSequence: page.toSequence,
    };
    const signedAck = await client.sign(ackPath, ackBody);
    await expect(input.sync.acknowledgeDurableReceipt(signedAck.request, ackBody, signedAck.rawBody)).resolves.toEqual({
      schemaVersion: "1.0", currentSequence: page.toSequence, replayed: false,
    });
    operations.push({ kind: "ack", snapshotId: page.snapshotId });
    lastAck = ackBody;
    if (!page.hasMore) break;
    afterSequence = page.toSequence;
    snapshotToken = page.snapshotToken;
  }
  for (let index = 0; index < pages.length; index += 1) {
    expect(operations.slice(index * 2, index * 2 + 2)).toEqual([
      { kind: "commit", snapshotId: pages[index]!.snapshotId },
      { kind: "ack", snapshotId: pages[index]!.snapshotId },
    ]);
  }
  if (lastAck === null) throw new Error("acceptance_ack_missing");
  const replay = await client.sign(ackPath, lastAck);
  await expect(input.sync.acknowledgeDurableReceipt(replay.request, lastAck, replay.rawBody)).resolves.toEqual({
    schemaVersion: "1.0", currentSequence: 1000, replayed: true,
  });
  return { local, pages };
}

class AcceptancePolicyContext implements MutablePolicyContext {
  readonly killSwitch = false;
  now(): Date { return new Date(syncNow); }
  isQuietHours(): boolean { return false; }
  activeOutboundCalls(): number { return 0; }
  outboundCallsForUtcPolicyDay(): number { return 0; }
  retryCount(): number { return 0; }
  authenticatedOrigin(): null { return null; }
}

beforeEach(resetAcceptanceState);
afterEach(resetAcceptanceState);

it("preserves 1,000 canonical events across D1, R2, signed sync, and denied dispatch", async () => {
  const enrolled = await bootstrapOneDevice();
  const liveEvents = new EventRepository(env.DB);
  const expected = await appendCanonicalEvents(liveEvents, enrolled, 1_000);
  expect(expected.map((event) => event.eventSequence)).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
  const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
  await archiveAndPurgeEligibleEvents(archive);
  const tiered = new TieredEventReader({ archive, live: liveEvents, state: new ArchiveRepository(env.DB) });
  let snapshotSeed = 100;
  let receiptSeed = 1;
  const sync = new SyncService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
    events: tiered,
    continuationSecret: Uint8Array.from({ length: 32 }, (_, index) => 201 - index),
    now: () => new Date(syncNow),
    snapshotId: () => encoded32(snapshotSeed++),
    receiptId: () => `receipt:acceptance:${receiptSeed++}`,
  });
  const copied = await pullIntoEmptyLocalArchive({ enrolled, sync, expected });
  expect(copied.local).toHaveLength(1_000);
  expect(copied.local.map((event) => event.eventSequence)).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
  expect(copied.local.map((event) => [event.sequencedEnvelopeSha256, event.contentHash]))
    .toEqual(expected.map((event) => [event.sequencedEnvelopeSha256, event.contentHash]));
  expect(copied.pages).toHaveLength(21);
  expect(copied.pages.map((page) => page.events.length)).toEqual([...Array<number>(20).fill(48), 40]);
  const seamPage = copied.pages[12];
  expect(seamPage).toMatchObject({ fromSequence: 576, toSequence: 624 });
  expect(seamPage?.events.map((event) => event.eventSequence)).toEqual(Array.from({ length: 48 }, (_, index) => 577 + index));
  expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_segment_events WHERE event_sequence BETWEEN 577 AND 624").first<{ count: number }>())?.count).toBe(24);
  expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE sequence BETWEEN 577 AND 624").first<{ count: number }>())?.count).toBe(24);
  const stored = await env.DB.prepare(
    "SELECT snapshot_id, from_sequence, through_sequence, event_count FROM sync_snapshots ORDER BY from_sequence",
  ).all<{ snapshot_id: string; from_sequence: number; through_sequence: number; event_count: number }>();
  expect(stored.results).toEqual(copied.pages.map((page) => ({
    snapshot_id: page.snapshotId, from_sequence: page.fromSequence,
    through_sequence: page.toSequence, event_count: page.events.length,
  })));
  expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_ack_receipts WHERE receipt_kind = 'snapshot'").first<{ count: number }>())?.count).toBe(21);
  expect((await env.DB.prepare("SELECT current_sequence FROM consumer_cursors WHERE consumer_name = ?")
    .bind(`device:${enrolled.deviceId}`).first<{ current_sequence: number }>())?.current_sequence).toBe(1_000);

  const modelCommand = {
    commandId: "01k3s6k8000000000000000007", principalId: enrolled.principalId,
    purposeCode: "user_requested", destinationIdentityId: enrolled.phoneIdentityId, urgency: "normal",
    authorizationExpiresAt: "2026-12-01T12:05:00.000Z", idempotencyKey: "call:model-origin", issuedBy: "model",
  } as unknown as OutboundCallCommand;
  const attemptId = "01k3s6k8000000000000000009" as OutboundCallCommand["commandId"];
  const checkId = "01k3s6k800000000000000000a" as OutboundCallCommand["commandId"];
  const policy = new PolicyEngine({
    database: env.DB,
    events: liveEvents,
    context: new AcceptancePolicyContext(),
    newUlid: () => checkId,
  });
  await expect(policy.evaluateOutboundCall(modelCommand)).resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
  const twilio = new FakeTwilioProvider();
  const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
    policy,
    twilio,
    repository: new CallRepository(env.DB, liveEvents),
    publicBaseUrl: new URL("https://jarvis.example/"),
    newAttemptId: () => attemptId,
    now: () => new Date(syncNow),
  });
  await expect(dispatcher.dispatch(modelCommand)).resolves.toEqual({
    status: "denied", reason: "authorization_denied", checkedAt: syncNow.toISOString(),
    checkId, attemptId,
  });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count, MIN(sequence) AS first_sequence FROM events WHERE event_type = 'policy.dispatch_checked'").first())
    .toEqual({ count: 1, first_sequence: 1001 });
  expect(twilio.requests).toHaveLength(0);
}, 180_000);
