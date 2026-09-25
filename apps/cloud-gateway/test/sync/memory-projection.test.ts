import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import policyVectors from "../../../../tests/fixtures/memory-projection-policy.json";
import {
  canonicalJson,
  canonicalize,
  createEnvelope,
  newUlid,
  sha256Hex,
  type MemoryFactProjectionCommitV1,
  type MemoryFactProjectionPageV1,
  type MemoryFactProjectionV1,
  type MemoryFactSourceV1,
  type SignedRequestV1,
} from "../../../../packages/contracts/src/index.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { EventRepository, type AppendedEvent, type SyncEventReader } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import {
  MEMORY_PROJECTION_PATH,
  MemoryProjectionService,
  ProjectionContentRejectedError,
  projectionManifestHash,
  projectionPageHash,
  validateProjectionBody,
} from "../../src/sync/memory-projection.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import { handleSyncRequest, SIGNED_REQUEST_HEADER } from "../../src/http/sync-routes.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import {
  applyCloudMemoryMigration,
  applyFoundationMigration,
  clearMemoryProjectionDataForTest,
} from "../persistence/migration.js";

const audience = "jarvis-local-agent";
const initialNow = new Date("2026-09-11T12:00:00.000Z");
const redactor = new Redactor("owner");

interface SigningIdentity {
  readonly deviceId: string;
  readonly principalId: string;
  readonly keyId: string;
  readonly generation: number;
  readonly privateKey: CryptoKey;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function encoded32(seed: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function generateSigningKey(): Promise<CryptoKeyPair> {
  const generate = crypto.subtle.generateKey.bind(crypto.subtle) as unknown as (
    algorithm: { readonly name: "Ed25519" },
    extractable: boolean,
    usages: readonly ("sign" | "verify")[],
  ) => Promise<CryptoKeyPair>;
  return generate({ name: "Ed25519" }, true, ["sign", "verify"]);
}

function exportPublicKey(key: CryptoKey): Promise<ArrayBuffer> {
  const exportKey = crypto.subtle.exportKey.bind(crypto.subtle) as unknown as (
    format: "raw",
    candidate: CryptoKey,
  ) => Promise<ArrayBuffer>;
  return exportKey("raw", key);
}

describe("signed active-fact projection", () => {
  let events: EventRepository;
  let identity: SigningIdentity;
  let nonceSeed: number;
  let currentNow: Date;

  beforeEach(async () => {
    await applyFoundationMigration();
    await applyCloudMemoryMigration();
    await clearMemoryProjectionDataForTest();
    await resetArchiveFixture();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM consumer_cursors"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
    ]);
    nonceSeed = 1;
    currentNow = new Date(initialNow);
    identity = await insertIdentity("principal:owner", "device:home", "key:one", 1);
    events = new EventRepository(env.DB);
  });

  async function insertIdentity(
    principalId: string,
    deviceId: string,
    keyId: string,
    generation: number,
    insertPrincipal = true,
  ): Promise<SigningIdentity> {
    const pair = await generateSigningKey();
    const publicKey = new Uint8Array(await exportPublicKey(pair.publicKey));
    if (insertPrincipal) {
      await env.DB.prepare(
        `INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
         VALUES (?, 'human', 'active', 'Owner', ?, ?)`,
      ).bind(principalId, initialNow.toISOString(), initialNow.toISOString()).run();
    }
    await env.DB.prepare(
      `INSERT INTO device_keys
       (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
        algorithm, status, device_label, bootstrap_metadata_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ed25519', 'active', 'test', ?, ?)`,
    ).bind(
      deviceId, principalId, keyId, base64(publicKey), await sha256Hex(publicKey), generation,
      "0".repeat(64), initialNow.toISOString(),
    ).run();
    return { deviceId, principalId, keyId, generation, privateKey: pair.privateKey };
  }

  function service(
    reader: SyncEventReader = events,
    beforePublish?: () => void | Promise<void>,
    beforeStage?: () => void | Promise<void>,
  ) {
    return new MemoryProjectionService({
      database: env.DB,
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      events: reader,
      now: () => new Date(currentNow),
      beforeStage,
      beforePublish,
    });
  }

  async function signed(
    body: MemoryFactProjectionPageV1 | MemoryFactProjectionCommitV1,
    signer = identity,
  ): Promise<{ request: SignedRequestV1; rawBody: Uint8Array }> {
    const rawBody = canonicalize(body as never);
    const unsigned = {
      schemaVersion: "1.0" as const,
      deviceId: signer.deviceId,
      principalId: signer.principalId,
      audience,
      issuedAt: currentNow.toISOString(),
      nonce: encoded32(nonceSeed++),
      bodyHash: await sha256Hex(rawBody),
    };
    const signingText = new TextEncoder().encode([
      "POST", MEMORY_PROJECTION_PATH, unsigned.deviceId, unsigned.principalId,
      unsigned.audience, unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
    ].join("\n"));
    return {
      request: {
        ...unsigned,
        signatureBase64: base64(new Uint8Array(
          await crypto.subtle.sign("Ed25519", signer.privateKey, signingText),
        )),
      },
      rawBody,
    };
  }

  async function project(
    target: MemoryProjectionService,
    body: MemoryFactProjectionPageV1 | MemoryFactProjectionCommitV1,
    signer = identity,
  ) {
    const wire = await signed(body, signer);
    return target.project(wire.request, body, wire.rawBody);
  }

  async function appendSource(
    text: string,
    principalId = identity.principalId,
    overrides: Partial<{
      eventType: string;
      source: string;
      producerVersion: string;
      historyEligible: boolean;
      sensitivityCode: number;
      channelCode: number;
      schemaCode: number;
    }> = {},
    persist = true,
  ): Promise<AppendedEvent> {
    const issued = redactor.redactText(text);
    if (!issued.ok) throw new Error("fixture redaction failed");
    const envelope = await createEnvelope({
      schemaVersion: "1.0",
      eventId: newUlid(),
      eventType: overrides.eventType ?? "conversation.user_committed",
      source: overrides.source ?? "conversation",
      subjectId: principalId,
      occurredAt: initialNow.toISOString(),
      receivedAt: initialNow.toISOString(),
      correlationId: newUlid(),
      contentType: "application/json",
      payload: {
        schemaCode: overrides.schemaCode ?? 1,
        channelCode: overrides.channelCode ?? 2,
        sensitivityCode: overrides.sensitivityCode ?? 1,
        historyEligible: overrides.historyEligible ?? true,
        text: issued,
      },
      producerVersion: overrides.producerVersion ?? "conversation-v1",
    });
    if (!persist) return { eventSequence: 1, envelope: JSON.parse(JSON.stringify(envelope)) as typeof envelope, replayed: false };
    return events.append({
      envelope,
      scope: "projection:source",
      key: envelope.eventId,
      requestHash: await sha256Hex(canonicalJson({ eventId: envelope.eventId })),
    });
  }

  async function fact(
    text: string,
    sources: readonly MemoryFactSourceV1[],
    overrides: Partial<MemoryFactProjectionV1> = {},
  ): Promise<MemoryFactProjectionV1> {
    const contentHash = await sha256Hex(canonicalJson({
      principal_id: identity.principalId,
      sources: [...sources.map((source) => source.eventId)].sort(),
      text,
    }));
    return {
      factId: `fact_${contentHash.slice(0, 32)}`,
      text,
      origin: "authenticated_first_person",
      sensitivity: "normal",
      confidence: 1,
      distillerVersion: "local-agent@0.1.0",
      distilledAt: initialNow.toISOString(),
      contentHash,
      sources,
      ...overrides,
    };
  }

  function source(event: AppendedEvent, excerpt: string): MemoryFactSourceV1 {
    return { eventId: event.envelope.eventId, eventSequence: event.eventSequence, excerpt };
  }

  async function snapshot(
    projectionVersion: number,
    facts: readonly MemoryFactProjectionV1[],
    pageSize = 32,
  ): Promise<{ pages: MemoryFactProjectionPageV1[]; commit: MemoryFactProjectionCommitV1 }> {
    const groups: MemoryFactProjectionV1[][] = [];
    if (facts.length === 0) groups.push([]);
    for (let offset = 0; offset < facts.length; offset += pageSize) {
      groups.push(facts.slice(offset, offset + pageSize));
    }
    const pageHashes = await Promise.all(groups.map(projectionPageHash));
    const manifestHash = await projectionManifestHash({
      projectionVersion,
      pageCount: groups.length,
      totalFactCount: facts.length,
      pageHashes,
    });
    return {
      pages: groups.map((pageFacts, pageIndex) => ({
        schemaVersion: "1.0",
        operation: "page",
        projectionVersion,
        pageIndex,
        pageCount: groups.length,
        totalFactCount: facts.length,
        pageHash: pageHashes[pageIndex]!,
        manifestHash,
        facts: pageFacts,
      })),
      commit: {
        schemaVersion: "1.0",
        operation: "commit",
        projectionVersion,
        pageCount: groups.length,
        totalFactCount: facts.length,
        manifestHash,
      },
    };
  }

  async function publishedVersion(): Promise<number> {
    return await env.DB.prepare(
      "SELECT published_version FROM memory_fact_projection_heads WHERE principal_id = ? AND device_id = ?",
    ).bind(identity.principalId, identity.deviceId).first<number>("published_version") ?? -1;
  }

  async function currentFactCount(): Promise<number> {
    return await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_fact_projection_facts f
       JOIN memory_fact_projection_heads h
         ON h.principal_id = f.principal_id AND h.device_id = f.device_id
        AND h.published_version = f.projection_version`,
    ).first<number>("count") ?? -1;
  }

  async function keyFingerprint(): Promise<string> {
    const fingerprint = await env.DB.prepare(
      "SELECT key_fingerprint FROM device_keys WHERE device_id = ? AND principal_id = ?",
    ).bind(identity.deviceId, identity.principalId).first<string>("key_fingerprint");
    if (fingerprint === null) throw new Error("fixture key missing");
    return fingerprint;
  }

  async function publishSnapshot(
    projectionVersion: number,
    facts: readonly MemoryFactProjectionV1[] = [],
  ): Promise<{ pages: MemoryFactProjectionPageV1[]; commit: MemoryFactProjectionCommitV1 }> {
    const built = await snapshot(projectionVersion, facts);
    for (const page of built.pages) await project(service(), page);
    await project(service(), built.commit);
    return built;
  }

  it("matches the independent RFC 8785 projection wire vector", async () => {
    const vectorFact: MemoryFactProjectionV1 = {
      factId: "fact_4d88ae4f8b685f140ef9103221b46a9f",
      text: "Mon café préféré est le moka.",
      origin: "authenticated_first_person" as const,
      sensitivity: "normal" as const,
      confidence: 0.95,
      distillerVersion: "vector-v1",
      distilledAt: "2026-09-11T12:00:00.000Z",
      contentHash: "4d88ae4f8b685f140ef9103221b46a9fd3a9b90c74c315890ab786bd4ca88160" as never,
      sources: [{
        eventId: "01k3w1t4000000000000000110" as never,
        eventSequence: 1,
        excerpt: "Mon café préféré est le moka.",
      }],
    };
    const pageHash = "d66840394f48b8f837e10e2fbdcc3cccbea82f7c321019bcab22f6b944ab6377";
    const manifestHash = "f902cc11a9c3da36d53b2fb0ac3f71424f613f5c41585542923c4c028e2899dc";
    const page = {
      schemaVersion: "1.0" as const,
      operation: "page" as const,
      projectionVersion: 1,
      pageIndex: 0,
      pageCount: 1,
      totalFactCount: 1,
      pageHash,
      manifestHash,
      facts: [vectorFact],
    };
    expect(await sha256Hex(canonicalJson({
      principal_id: "principal:projection-vector",
      sources: [vectorFact.sources[0].eventId],
      text: vectorFact.text,
    }))).toBe(vectorFact.contentHash);
    expect(await projectionPageHash(page.facts)).toBe(pageHash);
    expect(await projectionManifestHash({
      projectionVersion: 1,
      pageCount: 1,
      totalFactCount: 1,
      pageHashes: [pageHash],
    })).toBe(manifestHash);
    expect(await sha256Hex(canonicalize(page as never))).toBe(
      "84763e2e95a651bfc2defacb584852fe6033787df84fe8aede5b2b1ec708a2cc",
    );
  });

  it("publishes signed reordered pages only at commit and replays exact requests", async () => {
    const firstSource = await appendSource("I like coffee");
    const secondSource = await appendSource("I work on Tuesdays");
    const first = await fact("Sid likes coffee", [source(firstSource, "I like coffee")]);
    const second = await fact("Sid works on Tuesdays", [source(secondSource, "I work on Tuesdays")]);
    const built = await snapshot(1, [first, second], 1);
    const target = service();

    await expect(project(target, built.pages[1]!)).resolves.toMatchObject({ published: false, replayed: false });
    expect(await publishedVersion()).toBe(0);
    expect(await currentFactCount()).toBe(0);
    await expect(project(target, built.pages[0]!)).resolves.toMatchObject({ published: false, replayed: false });
    await expect(project(target, built.pages[0]!)).resolves.toMatchObject({ published: false, replayed: true });
    await expect(project(target, built.commit)).resolves.toMatchObject({ published: true, replayed: false });
    expect(await publishedVersion()).toBe(1);
    expect(await currentFactCount()).toBe(2);
    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId: identity.principalId,
      channel: "voice",
      purpose: "conversation",
      query: "coffee",
      maxTokens: 1_024,
    })).resolves.toEqual([
      { sourceEventId: first.sources[0]!.eventId, text: first.text, sensitivity: "personal" },
      { sourceEventId: firstSource.envelope.eventId, text: "I like coffee", sensitivity: "personal" },
      { sourceEventId: secondSource.envelope.eventId, text: "I work on Tuesdays", sensitivity: "personal" },
    ]);

    await expect(project(target, { ...built.commit, totalFactCount: 1 })).rejects.toThrow(
      "memory_projection_commit_mismatch",
    );
    await expect(project(target, built.commit)).resolves.toMatchObject({ published: true, replayed: true });
    await expect(project(target, built.pages[0]!)).resolves.toMatchObject({ published: false, replayed: true });
  });

  it("keeps the previous snapshot visible through failures then atomically retracts it", async () => {
    const event = await appendSource("I prefer tea");
    const active = await fact("Sid prefers tea", [source(event, "I prefer tea")]);
    const first = await snapshot(1, [active]);
    const target = service();
    await project(target, first.pages[0]!);
    await project(target, first.commit);

    const replacementEvent = await appendSource("I prefer coffee now");
    const replacement = await fact("Sid prefers coffee", [source(replacementEvent, "I prefer coffee now")]);
    const second = await snapshot(2, [active, replacement], 1);
    await project(target, second.pages[0]!);
    await expect(project(target, second.commit)).rejects.toThrow("memory_projection_incomplete");
    expect(await publishedVersion()).toBe(1);
    expect(await currentFactCount()).toBe(1);

    const conflictingFact = await fact("Sid prefers espresso", [source(replacementEvent, "I prefer")]);
    const conflicting = await snapshot(2, [conflictingFact]);
    await expect(project(target, conflicting.pages[0]!)).rejects.toThrow("memory_projection_version_conflict");
    expect(await publishedVersion()).toBe(1);

    await project(target, second.pages[1]!);
    await project(target, second.commit);
    expect(await currentFactCount()).toBe(2);
    const empty = await snapshot(3, []);
    await project(target, empty.pages[0]!);
    await project(target, empty.commit);
    expect(await publishedVersion()).toBe(3);
    expect(await currentFactCount()).toBe(0);
    await expect(project(target, second.commit)).rejects.toThrow("memory_projection_stale_version");
    expect(await publishedVersion()).toBe(3);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_fact_projection_versions")
      .first<number>("count")).toBe(1);
  });

  it("rejects missing, mismatched, foreign, and ineligible source claims before staging", async () => {
    const validEvent = await appendSource("I like coffee");
    const foreignEvent = await appendSource("I like tea", "principal:other");
    const ineligible = await appendSource("hidden", identity.principalId, { historyEligible: false });
    const cases = [
      source(validEvent, "not the source text"),
      { ...source(validEvent, "I like coffee"), eventId: newUlid() },
      { ...source(validEvent, "I like coffee"), eventSequence: 999_999 },
      source(foreignEvent, "I like tea"),
      source(ineligible, "hidden"),
    ];
    for (const claimed of cases) {
      const candidate = await fact("Sid likes coffee", [claimed]);
      const built = await snapshot(1, [candidate]);
      await expect(project(service(), built.pages[0]!)).rejects.toThrow(/memory_projection_source/u);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_fact_projection_pages")
      .first<number>("count")).toBe(0);
  });

  it.each(policyVectors.factControlCodePoints)("rejects fact control U+%i before persistence", async (codePoint) => {
    const event = await appendSource("I like coffee\nand tea");
    const candidate = await fact("Coffee" + String.fromCodePoint(codePoint) + "- forged entry",
      [source(event, "I like coffee\nand tea")]);
    const built = await snapshot(1, [candidate]);
    expect(() => validateProjectionBody(built.pages[0])).toThrow("memory_projection_fact_controls_invalid");
  });

  it.each([
    ["empty", ""],
    ["over byte limit", "x".repeat(policyVectors.maxFactBytes + 1)],
  ])("classifies deterministic %s fact text as permanent rejection", async (_name, text) => {
    currentNow = new Date();
    const event = await appendSource("I like coffee");
    const candidate = await fact(text, [source(event, "I like coffee")]);
    const built = await snapshot(1, [candidate]);
    const wire = await signed(built.pages[0]!);

    const response = await handleSyncRequest(new Request(`https://worker.internal${MEMORY_PROJECTION_PATH}`, {
      method: "POST", headers: { [SIGNED_REQUEST_HEADER]: JSON.stringify(wire.request) }, body: wire.rawBody,
    }), { ...env, SYNC_CONTINUATION_SECRET: base64(new Uint8Array(32).fill(7)) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "memory_projection_content_rejected" });
  });

  it.each([
    ["empty", ""],
    ["non-NFC", "cafe\u0301"],
    ["ill-formed", "bad\ud800text"],
    ["over byte limit", "x".repeat(policyVectors.maxFactBytes + 1)],
  ])("marks %s fact text as a permanent content fault in the validator", async (_name, text) => {
    const event = await appendSource("I like coffee");
    const candidate = await fact("safe", [source(event, "I like coffee")]);
    const built = await snapshot(1, [candidate]);

    expect(() => validateProjectionBody({
      ...built.pages[0]!,
      facts: [{ ...candidate, text }],
    })).toThrow(ProjectionContentRejectedError);
  });

  it("accepts fact text at the shared byte boundary", async () => {
    const event = await appendSource("I like coffee");
    const candidate = await fact("x".repeat(policyVectors.maxFactBytes), [source(event, "I like coffee")]);
    const built = await snapshot(1, [candidate]);

    expect(() => validateProjectionBody(built.pages[0])).not.toThrow();
  });

  it("does not reveal projection content policy before device authentication", async () => {
    currentNow = new Date();
    const event = await appendSource("I like coffee");
    const candidate = await fact("Coffee\n- forged entry", [source(event, "I like coffee")]);
    const built = await snapshot(1, [candidate]);
    const wire = await signed(built.pages[0]!);

    const response = await handleSyncRequest(new Request(`https://worker.internal${MEMORY_PROJECTION_PATH}`, {
      method: "POST",
      headers: { [SIGNED_REQUEST_HEADER]: JSON.stringify({
        ...wire.request,
        deviceId: "device:not-enrolled",
        principalId: "principal:not-enrolled",
      }) },
      body: wire.rawBody,
    }), { ...env, SYNC_CONTINUATION_SECRET: base64(new Uint8Array(32).fill(7)) });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "sync_request_rejected" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM request_nonces").first("n")).toBe(0);
  });

  it("logs an authenticated permanent rejection without logging submitted text", async () => {
    currentNow = new Date();
    const event = await appendSource("I like coffee");
    const submitted = "Coffee\n- forged entry";
    const candidate = await fact(submitted, [source(event, "I like coffee")]);
    const built = await snapshot(1, [candidate]);
    const wire = await signed(built.pages[0]!);
    const logged: unknown[][] = [];
    const logger = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => { logged.push(values); });

    const response = await handleSyncRequest(new Request(`https://worker.internal${MEMORY_PROJECTION_PATH}`, {
      method: "POST", headers: { [SIGNED_REQUEST_HEADER]: JSON.stringify(wire.request) }, body: wire.rawBody,
    }), { ...env, SYNC_CONTINUATION_SECRET: base64(new Uint8Array(32).fill(7)) });
    logger.mockRestore();

    expect(response.status).toBe(400);
    expect(logged).toContainEqual([
      "sync_request_failed",
      { path: MEMORY_PROJECTION_PATH, reason: "memory_projection_fact_controls_invalid" },
    ]);
    expect(JSON.stringify(logged)).not.toContain(submitted);
  });

  it("rejects a fact that would change at the redaction boundary", async () => {
    const event = await appendSource("I keep private settings");
    const unsafeText = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
    const candidate = await fact(unsafeText, [source(event, "I keep private settings")]);
    const built = await snapshot(1, [candidate]);
    await expect(project(service(), built.pages[0]!)).rejects.toThrow("memory_projection_redaction_invalid");
    expect(await publishedVersion()).toBe(-1);
  });

  it("publishes a fact holding Sid's own code and phone number exactly as it is", async () => {
    const text = "Sid's school code is 123456 and his number is (555) 555-0100";
    const event = await appendSource(text);
    await publishSnapshot(1, [await fact(text, [source(event, text)])]);
    expect(await publishedVersion()).toBe(1);
    expect(await env.DB.prepare("SELECT text FROM memory_fact_projection_facts").first("text")).toBe(text);
  });

  it("enforces structural and unique-source bounds without truncating", async () => {
    const fakeSource = (index: number): MemoryFactSourceV1 => ({
      eventId: newUlid(),
      eventSequence: index + 1,
      excerpt: "source",
    });
    const template = await fact("bounded", [fakeSource(0)]);
    expect(() => validateProjectionBody({
      schemaVersion: "1.0",
      operation: "page",
      projectionVersion: 1,
      pageIndex: 0,
      pageCount: 33,
      totalFactCount: 0,
      pageHash: "0".repeat(64),
      manifestHash: "0".repeat(64),
      facts: [],
    })).toThrow("memory_projection_page_invalid");
    const facts = Array.from({ length: 32 }, (_, index) => ({
      ...template,
      factId: `fact_${index.toString(16).padStart(32, "0")}`,
      sources: index === 0 ? [fakeSource(0), fakeSource(32)] : [fakeSource(index)],
    }));
    expect(() => validateProjectionBody({
      schemaVersion: "1.0",
      operation: "page",
      projectionVersion: 1,
      pageIndex: 0,
      pageCount: 1,
      totalFactCount: 32,
      pageHash: "0".repeat(64),
      manifestHash: "0".repeat(64),
      facts,
    })).toThrow("memory_projection_source_limit");
  });

  it("loses a revocation race at the atomic publish boundary", async () => {
    currentNow = new Date();
    const event = await appendSource("I like coffee");
    const candidate = await fact("Sid likes coffee", [source(event, "I like coffee")]);
    const built = await snapshot(1, [candidate]);
    await project(service(), built.pages[0]!);
    await env.DB.prepare(`CREATE TRIGGER test_projection_revoke_after_nonce
      AFTER INSERT ON request_nonces
      BEGIN
        UPDATE device_keys SET status = 'revoked', revoked_at = NEW.consumed_at
        WHERE device_id = NEW.device_id;
      END`).run();
    const wire = await signed(built.commit);
    const response = await handleSyncRequest(new Request(`https://worker.internal${MEMORY_PROJECTION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNED_REQUEST_HEADER]: JSON.stringify(wire.request),
      },
      body: wire.rawBody,
    }), { ...env, SYNC_CONTINUATION_SECRET: base64(new Uint8Array(32).fill(7)) });
    await env.DB.prepare("DROP TRIGGER test_projection_revoke_after_nonce").run();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "sync_request_rejected" });
    expect(await publishedVersion()).toBe(0);
    expect(await currentFactCount()).toBe(0);
  });

  it("does not stage a page when the key is revoked after verification", async () => {
    const firstEvent = await appendSource("I like coffee");
    const first = await snapshot(1, [
      await fact("Sid likes coffee", [source(firstEvent, "I like coffee")]),
    ]);
    await project(service(), first.pages[0]!);
    await project(service(), first.commit);
    const secondEvent = await appendSource("I like tea");
    const built = await snapshot(2, [
      await fact("Sid likes tea", [source(secondEvent, "I like tea")]),
    ]);
    const target = service(events, undefined, async () => {
      await env.DB.prepare(
        "UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?",
      ).bind(currentNow.toISOString(), identity.deviceId).run();
    });
    await expect(project(target, built.pages[0]!)).rejects.toThrow("memory_projection_device_state_changed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_fact_projection_versions")
      .first<number>("count")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_fact_projection_pages")
      .first<number>("count")).toBe(1);
    expect(await publishedVersion()).toBe(1);
  });

  it("allows a rotated key to restage every page at the same unpublished version", async () => {
    const firstEvent = await appendSource("I like coffee");
    const secondEvent = await appendSource("I like tea");
    const built = await snapshot(1, [
      await fact("Sid likes coffee", [source(firstEvent, "I like coffee")]),
      await fact("Sid likes tea", [source(secondEvent, "I like tea")]),
    ], 1);
    await project(service(), built.pages[0]!);

    const replacement = await generateSigningKey();
    const replacementRaw = new Uint8Array(await exportPublicKey(replacement.publicKey));
    await env.DB.prepare(
      `UPDATE device_keys SET key_id = 'key:two', public_key_base64 = ?,
       key_fingerprint = ?, key_generation = 2 WHERE device_id = ?`,
    ).bind(base64(replacementRaw), await sha256Hex(replacementRaw), identity.deviceId).run();
    identity = {
      ...identity,
      keyId: "key:two",
      generation: 2,
      privateKey: replacement.privateKey,
    };

    await project(service(), built.pages[1]!);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_fact_projection_pages")
      .first<number>("count")).toBe(1);
    await project(service(), built.pages[0]!);
    await project(service(), built.commit);
    expect(await publishedVersion()).toBe(1);
    expect(await currentFactCount()).toBe(2);
  });

  it("recovers an expired partial version when the node resends all immutable pages", async () => {
    const firstEvent = await appendSource("I like coffee");
    const secondEvent = await appendSource("I like tea");
    const built = await snapshot(1, [
      await fact("Sid likes coffee", [source(firstEvent, "I like coffee")]),
      await fact("Sid likes tea", [source(secondEvent, "I like tea")]),
    ], 1);
    await project(service(), built.pages[0]!);
    currentNow = new Date(currentNow.valueOf() + 3_600_001);
    await project(service(), built.pages[1]!);
    await project(service(), built.pages[0]!);
    await project(service(), built.commit);
    expect(await currentFactCount()).toBe(2);
  });

  it("validates a source through the verified R2 tier after its D1 row is purged", async () => {
    const event = await appendSource("I like archived coffee");
    await env.DB.prepare(
      "UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE event_sequence = ?",
    ).bind(initialNow.toISOString(), event.eventSequence).run();
    await env.DB.prepare("UPDATE events SET created_at = ? WHERE sequence = ?")
      .bind("2026-01-01T00:00:00.000Z", event.eventSequence).run();
    const archival = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    await archival.archiveEligible(new Date("2026-06-01T00:00:00.000Z"), 1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<number>("count")).toBe(0);
    const tiered = new TieredEventReader({
      live: events,
      archive: archival,
      state: new ArchiveRepository(env.DB),
    });
    const candidate = await fact("Sid likes archived coffee", [source(event, "I like archived coffee")]);
    const built = await snapshot(1, [candidate]);
    await project(service(tiered), built.pages[0]!);
    await project(service(tiered), built.commit);
    expect(await currentFactCount()).toBe(1);
  });

  it("refuses an out-of-order direct commit without replacing the published snapshot", async () => {
    const event = await appendSource("I like coffee");
    const existing = await fact("Sid likes coffee", [source(event, "I like coffee")]);
    const expiresAt = new Date(initialNow.valueOf() + 3_600_000).toISOString();
    const fingerprint = await env.DB.prepare(
      "SELECT key_fingerprint FROM device_keys WHERE device_id = ? AND principal_id = ?",
    ).bind(identity.deviceId, identity.principalId).first<string>("key_fingerprint");
    if (fingerprint === null) throw new Error("fixture key missing");
    for (let version = 1; version <= 4; version += 1) {
      const built = await snapshot(version, [existing]);
      await project(service(), built.pages[0]!);
      await project(service(), built.commit);
    }
    await env.DB.batch([
      ...[5, 6].map((version) => env.DB.prepare(
        `INSERT INTO memory_fact_projection_versions
         (principal_id, device_id, projection_version, manifest_hash, page_count, total_fact_count,
          key_id, key_fingerprint, key_generation, status, created_at, expires_at, published_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, 'staged', ?, ?, NULL)`,
      ).bind(
        identity.principalId, identity.deviceId, version, String(version).repeat(64),
        identity.keyId, fingerprint, identity.generation, initialNow.toISOString(), expiresAt,
      )),
      ...[5, 6].map((version) => env.DB.prepare(
        `INSERT INTO memory_fact_projection_pages
         (principal_id, device_id, projection_version, page_index, page_hash, fact_count, page_json, created_at)
         VALUES (?, ?, ?, 0, ?, 0, '{}', ?)`,
      ).bind(
        identity.principalId, identity.deviceId, version, String(version).repeat(64), initialNow.toISOString(),
      )),
    ]);

    await expect(env.DB.prepare(
      `INSERT INTO memory_fact_projection_commits
       (principal_id, device_id, projection_version, manifest_hash, key_id,
        key_fingerprint, key_generation, committed_at)
       VALUES (?, ?, 6, ?, ?, ?, ?, ?)`,
    ).bind(
      identity.principalId, identity.deviceId, "6".repeat(64), identity.keyId,
      fingerprint, identity.generation, initialNow.toISOString(),
    ).run()).rejects.toThrow(/memory_projection_/u);

    expect(await publishedVersion()).toBe(4);
    expect(await currentFactCount()).toBe(1);
    expect(await env.DB.prepare(
      "SELECT status FROM memory_fact_projection_versions WHERE projection_version = 6",
    ).first<string>("status")).toBe("staged");
  });

  it("rolls back publication when the head disappears after the version transition", async () => {
    const built = await snapshot(1, []);
    await project(service(), built.pages[0]!);
    const headDeleteGuard = await env.DB.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).bind("memory_fact_projection_heads_delete_guard").first<string>("sql");
    if (headDeleteGuard === null) throw new Error("projection head delete guard missing");

    await env.DB.prepare("DROP TRIGGER memory_fact_projection_heads_delete_guard").run();
    let failure: unknown;
    try {
      await env.DB.prepare(`CREATE TRIGGER test_projection_head_race
        AFTER UPDATE OF status ON memory_fact_projection_versions
        WHEN OLD.status = 'staged' AND NEW.status = 'published'
        BEGIN
          DELETE FROM memory_fact_projection_heads
          WHERE principal_id = NEW.principal_id AND device_id = NEW.device_id;
        END`).run();
      try {
        await project(service(), built.commit);
      } catch (error) {
        failure = error;
      }
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS test_projection_head_race").run();
      await env.DB.prepare(headDeleteGuard).run();
    }

    expect(String(failure)).toContain("memory_projection_head_changed");
    expect(await publishedVersion()).toBe(0);
    expect(await env.DB.prepare(
      "SELECT status FROM memory_fact_projection_versions WHERE projection_version = 1",
    ).first<string>("status")).toBe("staged");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_fact_projection_commits WHERE projection_version = 1",
    ).first<number>("count")).toBe(0);
  });

  it("reports a page-state race as retryable instead of device revocation", async () => {
    currentNow = new Date();
    const event = await appendSource("I like coffee");
    const candidate = await fact("Sid likes coffee", [source(event, "I like coffee")]);
    const built = await snapshot(1, [candidate]);
    await env.DB.prepare(`CREATE TRIGGER test_projection_page_race
      BEFORE INSERT ON memory_fact_projection_pages
      BEGIN SELECT RAISE(IGNORE); END`).run();
    try {
      const wire = await signed(built.pages[0]!);
      const response = await handleSyncRequest(new Request(`https://worker.internal${MEMORY_PROJECTION_PATH}`, {
        method: "POST", headers: { [SIGNED_REQUEST_HEADER]: JSON.stringify(wire.request) }, body: wire.rawBody,
      }), { ...env, SYNC_CONTINUATION_SECRET: base64(new Uint8Array(32).fill(7)) });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "sync_request_rejected" });
    } finally {
      await env.DB.prepare("DROP TRIGGER test_projection_page_race").run();
    }
  });

  it.each(["contentHash", "factId"] as const)("binds the fact identity's %s independently", async (field) => {
    const event = await appendSource("I like coffee");
    const valid = await fact("Likes coffee", [source(event, "I like coffee")]);
    const bad = { ...valid, [field]: field === "factId" ? `fact_${"0".repeat(32)}` : "0".repeat(64) };
    const built = await snapshot(1, [bad]);
    await expect(project(service(), built.pages[0]!)).rejects.toThrow("memory_projection_fact_identity_invalid");
    expect(await publishedVersion()).toBe(-1);
  });

  it("accepts an eligible source returned by the serialized archive reader", async () => {
    const event = await appendSource("I like coffee", identity.principalId, {}, false);
    const built = await snapshot(1, [await fact("Likes coffee", [source(event, "I like coffee")])]);
    const reader: SyncEventReader = { latestSequence: async () => 1, readRange: async () => [event] };
    await expect(project(service(reader), built.pages[0]!)).resolves.toMatchObject({ published: false });
  });

  it.each([
    { eventType: "other.event" }, { source: "other" }, { producerVersion: "other-v1" },
    { schemaCode: 2 }, { sensitivityCode: 2 }, { historyEligible: false },
    { eventType: "conversation.assistant_delivered", channelCode: 1 }, { channelCode: 3 },
  ])("rejects an ineligible source independently: %j", async (overrides) => {
    // The archive reader is a separate boundary: the live event append guard
    // must not mask the retriever's own source-eligibility checks.
    const event = await appendSource("I like coffee", identity.principalId, overrides, false);
    const built = await snapshot(1, [await fact("Likes coffee", [source(event, "I like coffee")])]);
    const reader: SyncEventReader = { latestSequence: async () => 1, readRange: async () => [event] };
    await expect(project(service(reader), built.pages[0]!)).rejects.toThrow("memory_projection_source_invalid");
    expect(await publishedVersion()).toBe(-1);
  });

  it("abandons a partially staged rejected snapshot and publishes a healthy replacement at the same version", async () => {
    const event = await appendSource("I like coffee");
    const good = await fact("Likes coffee", [source(event, "I like coffee")]);
    await publishSnapshot(1, [good]);
    // A machine credential is what the owner redactor still changes; Sid's own
    // codes and numbers are projected as they are.
    const bad = await fact(`Key sk-${"a".repeat(24)}`, [source(event, "I like coffee")]);
    const built = await snapshot(2, [good, bad], 1);
    await project(service(), built.pages[0]!);
    await expect(project(service(), built.pages[1]!)).rejects.toThrow("memory_projection_redaction_invalid");
    const abandon = { ...built.commit, operation: "abandon" } as never;
    await expect(project(service(), abandon)).resolves.toMatchObject({ published: false });
    expect(await publishedVersion()).toBe(1);
    expect(await currentFactCount()).toBe(1);
    await expect(project(service(), abandon)).resolves.toMatchObject({ published: false, replayed: true });
    await publishSnapshot(2, [good]);
    expect(await publishedVersion()).toBe(2);
  });

  it("fences a delayed page at the database after abandonment", async () => {
    const built = await snapshot(1, []);
    const target = service(events, undefined, async () => {
      await project(service(), { ...built.commit, operation: "abandon" } as never);
    });
    await expect(project(target, built.pages[0]!)).rejects.toThrow();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_fact_projection_versions").first("n")).toBe(0);
  });

  it("does not attach an old request's facts to a replacement page during the batch race", async () => {
    const event = await appendSource("I like coffee");
    const built = await snapshot(1, [
      await fact("Likes coffee", [source(event, "I like coffee")]),
      await fact("Drinks coffee", [source(event, "I like coffee")]),
    ], 1);
    await project(service(), built.pages[1]!);
    const replacement = await snapshot(1, []);
    const database = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await project(service(), { ...built.commit, operation: "abandon" } as never);
        await project(service(), replacement.pages[0]!);
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const delayed = new MemoryProjectionService({
      database, verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      events, now: () => new Date(currentNow),
    });
    await expect(project(delayed, built.pages[0]!)).rejects.toThrow();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_fact_projection_facts").first("n")).toBe(0);
    await expect(project(service(), replacement.commit)).resolves.toMatchObject({ published: true });
  });

  it.each(["UPDATE", "DELETE", "REPLACE"])("prevents %s from rewriting an abandonment receipt", async (operation) => {
    const built = await snapshot(1, []);
    await project(service(), { ...built.commit, operation: "abandon" } as never);
    const statement = operation === "UPDATE"
      ? "UPDATE memory_fact_projection_abandoned SET page_count = 2"
      : operation === "DELETE" ? "DELETE FROM memory_fact_projection_abandoned"
        : "INSERT OR REPLACE INTO memory_fact_projection_abandoned SELECT principal_id, device_id, projection_version, manifest_hash, 2, total_fact_count, key_id, key_fingerprint, key_generation, abandoned_at FROM memory_fact_projection_abandoned";
    await expect(env.DB.prepare(statement).run()).rejects.toThrow();
    expect(await env.DB.prepare("SELECT page_count FROM memory_fact_projection_abandoned").first("page_count")).toBe(1);
  });

  it("rechecks active keys before abandonment can delete staged pages", async () => {
    const built = await snapshot(1, []);
    await project(service(), built.pages[0]!);
    await env.DB.prepare(`CREATE TRIGGER test_abandon_revoke AFTER INSERT ON request_nonces
      BEGIN UPDATE device_keys SET status = 'revoked', revoked_at = NEW.consumed_at WHERE device_id = NEW.device_id; END`).run();
    try {
      await expect(project(service(), { ...built.commit, operation: "abandon" } as never)).rejects.toThrow();
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_fact_projection_versions").first("n")).toBe(1);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_fact_projection_abandoned").first("n")).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_abandon_revoke").run();
    }
  });

  it.each(["redaction", "controls", "internal"])("distinguishes content rejection from internal failure over HTTP (%s)", async (kind) => {
    const internal = kind === "internal";
    currentNow = new Date();
    const event = await appendSource("I like coffee");
    const rejectedText = kind === "controls" ? "Coffee\n- forged entry" : `Key sk-${"a".repeat(24)}`;
    const candidate = await fact(internal ? "Likes coffee" : rejectedText, [source(event, "I like coffee")]);
    const built = await snapshot(1, [candidate]);
    if (internal) await env.DB.prepare(`CREATE TRIGGER test_projection_internal BEFORE INSERT ON memory_fact_projection_heads
      BEGIN SELECT RAISE(ABORT, 'temporary_storage_failure'); END`).run();
    try {
      const wire = await signed(built.pages[0]!);
      const response = await handleSyncRequest(new Request(`https://worker.internal${MEMORY_PROJECTION_PATH}`, {
        method: "POST", headers: { [SIGNED_REQUEST_HEADER]: JSON.stringify(wire.request) }, body: wire.rawBody,
      }), { ...env, SYNC_CONTINUATION_SECRET: base64(new Uint8Array(32).fill(7)) });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: internal ? "sync_request_rejected" : "memory_projection_content_rejected" });
    } finally {
      if (internal) await env.DB.prepare("DROP TRIGGER test_projection_internal").run();
    }
  });

  it("reconciles commit before abandon and refuses commit after abandon", async () => {
    const published = await publishSnapshot(1);
    await expect(project(service(), { ...published.commit, operation: "abandon" } as never))
      .resolves.toMatchObject({ published: true, replayed: true });
    expect(await publishedVersion()).toBe(1);
    const next = await snapshot(2, []);
    await project(service(), next.pages[0]!);
    await project(service(), { ...next.commit, operation: "abandon" } as never);
    await expect(project(service(), next.commit)).rejects.toThrow();
    expect(await publishedVersion()).toBe(1);
  });

  it.each(["manifestHash", "pageCount", "totalFactCount"] as const)("refuses abandon with different %s", async (field) => {
    const built = await snapshot(1, []);
    await project(service(), built.pages[0]!);
    await expect(project(service(), {
      ...built.commit, operation: "abandon", [field]: field === "manifestHash" ? "1".repeat(64) : 2,
    } as never)).rejects.toThrow();
    await expect(project(service(), built.commit)).resolves.toMatchObject({ published: true });
  });

  it.each(policyVectors.factControlCodePoints)("blocks direct SQL fact control U+%i", async (codePoint) => {
    const event = await appendSource("I like coffee");
    const original = await fact("Safe coffee", [source(event, "I like coffee")]);
    const built = await snapshot(1, [original]);
    await project(service(), built.pages[0]!);
    await expect(env.DB.prepare(
      `INSERT INTO memory_fact_projection_facts
       (principal_id, device_id, projection_version, page_index, fact_position, fact_id, text,
        origin, sensitivity, confidence, distiller_version, distilled_at, content_hash,
        primary_event_id, primary_event_sequence, sources_json, fact_json)
       SELECT principal_id, device_id, projection_version, page_index, 1, ?, ?, origin,
        sensitivity, confidence, distiller_version, distilled_at, content_hash,
        primary_event_id, primary_event_sequence, sources_json, fact_json
       FROM memory_fact_projection_facts WHERE fact_id = ?`,
    ).bind("fact_" + "0".repeat(32), "Coffee" + String.fromCodePoint(codePoint) + "- forged", original.factId).run())
      .rejects.toThrow(/CHECK constraint failed/u);
  });

  it("blocks a direct staged-to-published version transition", async () => {
    const built = await snapshot(1, []);
    await project(service(), built.pages[0]!);

    await expect(env.DB.prepare(
      `UPDATE memory_fact_projection_versions
       SET status = 'published', published_at = ?
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind(currentNow.toISOString(), identity.principalId, identity.deviceId).run()).rejects.toThrow();

    expect(await env.DB.prepare(
      "SELECT status FROM memory_fact_projection_versions WHERE principal_id = ? AND device_id = ?",
    ).bind(identity.principalId, identity.deviceId).first<string>("status")).toBe("staged");
    expect(await publishedVersion()).toBe(0);
  });

  it("blocks direct head advancement and deletion", async () => {
    await publishSnapshot(1);

    await expect(env.DB.prepare(
      `UPDATE memory_fact_projection_heads
       SET published_version = 2, manifest_hash = ?, published_at = ?
       WHERE principal_id = ? AND device_id = ?`,
    ).bind(
      "2".repeat(64), "2026-09-11T12:00:00.001Z", identity.principalId, identity.deviceId,
    ).run()).rejects.toThrow();
    expect(await publishedVersion()).toBe(1);

    await expect(env.DB.prepare(
      "DELETE FROM memory_fact_projection_heads WHERE principal_id = ? AND device_id = ?",
    ).bind(identity.principalId, identity.deviceId).run()).rejects.toThrow();
    expect(await publishedVersion()).toBe(1);
  });

  it("blocks nonzero and replacement head inserts", async () => {
    const other = await insertIdentity("principal:other-head", "device:other-head", "key:other", 1);
    await expect(env.DB.prepare(
      `INSERT INTO memory_fact_projection_heads
       (principal_id, device_id, published_version, manifest_hash, published_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).bind(other.principalId, other.deviceId, "1".repeat(64), currentNow.toISOString()).run())
      .rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_fact_projection_heads WHERE device_id = ?",
    ).bind(other.deviceId).first<number>("count")).toBe(0);

    await publishSnapshot(1);
    await expect(env.DB.prepare(
      `INSERT OR REPLACE INTO memory_fact_projection_heads
       (principal_id, device_id, published_version, manifest_hash, published_at)
       VALUES (?, ?, 0, NULL, NULL)`,
    ).bind(identity.principalId, identity.deviceId).run()).rejects.toThrow();
    expect(await publishedVersion()).toBe(1);
  });

  it("blocks direct published-version insertion", async () => {
    const first = await snapshot(1, []);
    await project(service(), first.pages[0]!);
    const fingerprint = await keyFingerprint();
    await expect(env.DB.prepare(
      `INSERT INTO memory_fact_projection_versions
       (principal_id, device_id, projection_version, manifest_hash, page_count, total_fact_count,
        key_id, key_fingerprint, key_generation, status, created_at, expires_at, published_at)
       VALUES (?, ?, 2, ?, 1, 0, ?, ?, ?, 'published', ?, ?, ?)`,
    ).bind(
      identity.principalId, identity.deviceId, "2".repeat(64), identity.keyId, fingerprint,
      identity.generation, currentNow.toISOString(), "2026-09-11T13:00:00.000Z",
      currentNow.toISOString(),
    ).run()).rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_fact_projection_versions WHERE projection_version = 2",
    ).first<number>("count")).toBe(0);
  });

  it("blocks replacement of a published parent version", async () => {
    const built = await publishSnapshot(1);
    const fingerprint = await keyFingerprint();
    await expect(env.DB.prepare(
      `INSERT OR REPLACE INTO memory_fact_projection_versions
       (principal_id, device_id, projection_version, manifest_hash, page_count, total_fact_count,
        key_id, key_fingerprint, key_generation, status, created_at, expires_at, published_at)
       VALUES (?, ?, 1, ?, 1, 0, ?, ?, ?, 'staged', ?, ?, NULL)`,
    ).bind(
      identity.principalId, identity.deviceId, built.commit.manifestHash, identity.keyId, fingerprint,
      identity.generation, currentNow.toISOString(), "2026-09-11T13:00:00.000Z",
    ).run()).rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT status FROM memory_fact_projection_versions WHERE projection_version = 1",
    ).first<string>("status")).toBe("published");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_fact_projection_pages WHERE projection_version = 1",
    ).first<number>("count")).toBe(1);
  });

  it("blocks inserts and replacements under a published page set", async () => {
    const built = await publishSnapshot(1);
    await expect(env.DB.prepare(
      `INSERT INTO memory_fact_projection_pages
       (principal_id, device_id, projection_version, page_index, page_hash, fact_count, page_json, created_at)
       VALUES (?, ?, 1, 1, ?, 0, '{}', ?)`,
    ).bind(identity.principalId, identity.deviceId, "1".repeat(64), currentNow.toISOString()).run())
      .rejects.toThrow();
    await expect(env.DB.prepare(
      `INSERT OR REPLACE INTO memory_fact_projection_pages
       (principal_id, device_id, projection_version, page_index, page_hash, fact_count, page_json, created_at)
       VALUES (?, ?, 1, 0, ?, 0, '{}', ?)`,
    ).bind(identity.principalId, identity.deviceId, "f".repeat(64), currentNow.toISOString()).run())
      .rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT page_hash FROM memory_fact_projection_pages WHERE projection_version = 1 AND page_index = 0",
    ).first<string>("page_hash")).toBe(built.pages[0]!.pageHash);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_fact_projection_pages WHERE projection_version = 1",
    ).first<number>("count")).toBe(1);
  });

  it("blocks deletion of an empty published page", async () => {
    await publishSnapshot(1);
    await expect(env.DB.prepare(
      `DELETE FROM memory_fact_projection_pages
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1 AND page_index = 0`,
    ).bind(identity.principalId, identity.deviceId).run()).rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_fact_projection_pages WHERE projection_version = 1",
    ).first<number>("count")).toBe(1);
  });

  it("blocks fact insertion and replacement under a published version", async () => {
    const event = await appendSource("I like coffee");
    const existing = await fact("Sid likes coffee", [source(event, "I like coffee")]);
    await publishSnapshot(1, [existing]);
    await expect(env.DB.prepare(
      `INSERT INTO memory_fact_projection_facts
       (principal_id, device_id, projection_version, page_index, fact_position, fact_id, text,
        origin, sensitivity, confidence, distiller_version, distilled_at, content_hash,
        primary_event_id, primary_event_sequence, sources_json, fact_json)
       SELECT principal_id, device_id, projection_version, page_index, 1, ?, 'added directly',
        origin, sensitivity, confidence, distiller_version, distilled_at, ?,
        primary_event_id, primary_event_sequence, sources_json, fact_json
       FROM memory_fact_projection_facts WHERE fact_id = ?`,
    ).bind(`fact_${"b".repeat(32)}`, "b".repeat(64), existing.factId).run()).rejects.toThrow();
    await expect(env.DB.prepare(
      `INSERT OR REPLACE INTO memory_fact_projection_facts
       (projection_fact_rowid, principal_id, device_id, projection_version, page_index,
        fact_position, fact_id, text, origin, sensitivity, confidence, distiller_version,
        distilled_at, content_hash, primary_event_id, primary_event_sequence, sources_json, fact_json)
       SELECT projection_fact_rowid, principal_id, device_id, projection_version, page_index,
        fact_position, fact_id, 'replaced directly', origin, sensitivity, confidence, distiller_version,
        distilled_at, content_hash, primary_event_id, primary_event_sequence, sources_json, fact_json
       FROM memory_fact_projection_facts WHERE fact_id = ?`,
    ).bind(existing.factId).run()).rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT text FROM memory_fact_projection_facts WHERE fact_id = ?",
    ).bind(existing.factId).first<string>("text")).toBe(existing.text);
    expect(await currentFactCount()).toBe(1);
  });

  it("blocks a staged fact from replacing a published fact by rowid", async () => {
    const publishedEvent = await appendSource("I like coffee");
    const published = await fact("Sid likes coffee", [source(publishedEvent, "I like coffee")]);
    await publishSnapshot(1, [published]);
    const staged = await snapshot(2, []);
    await project(service(), staged.pages[0]!);
    const publishedRowid = await env.DB.prepare(
      "SELECT projection_fact_rowid FROM memory_fact_projection_facts WHERE fact_id = ?",
    ).bind(published.factId).first<number>("projection_fact_rowid");
    if (publishedRowid === null) throw new Error("published fixture fact missing");
    const replacementEvent = await appendSource("I like tea");
    const replacementSource = source(replacementEvent, "I like tea");
    const replacement = await fact("Sid likes tea", [replacementSource]);

    await expect(env.DB.prepare(
      `INSERT OR REPLACE INTO memory_fact_projection_facts
       (projection_fact_rowid, principal_id, device_id, projection_version, page_index,
        fact_position, fact_id, text, origin, sensitivity, confidence, distiller_version,
        distilled_at, content_hash, primary_event_id, primary_event_sequence, sources_json, fact_json)
       VALUES (?, ?, ?, 2, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      publishedRowid, identity.principalId, identity.deviceId, replacement.factId, replacement.text,
      replacement.origin, replacement.sensitivity, replacement.confidence,
      replacement.distillerVersion, replacement.distilledAt, replacement.contentHash,
      replacementSource.eventId, replacementSource.eventSequence,
      canonicalJson(replacement.sources as never), canonicalJson(replacement as never),
    ).run()).rejects.toThrow();

    expect(await env.DB.prepare(
      `SELECT projection_fact_rowid, text FROM memory_fact_projection_facts
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind(identity.principalId, identity.deviceId).first<{ projection_fact_rowid: number; text: string }>())
      .toEqual({ projection_fact_rowid: publishedRowid, text: published.text });
    expect(await env.DB.prepare(
      "SELECT text FROM memory_fact_projection_fts WHERE rowid = ?",
    ).bind(publishedRowid).first<string>("text")).toBe(published.text);
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_fact_projection_facts
       WHERE principal_id = ? AND device_id = ? AND projection_version = 2`,
    ).bind(identity.principalId, identity.deviceId).first<number>("count")).toBe(0);
  });

  it("blocks deletion of a published fact and its current parent version", async () => {
    const event = await appendSource("I like coffee");
    const existing = await fact("Sid likes coffee", [source(event, "I like coffee")]);
    await publishSnapshot(1, [existing]);
    await expect(env.DB.prepare(
      "DELETE FROM memory_fact_projection_facts WHERE fact_id = ?",
    ).bind(existing.factId).run()).rejects.toThrow();
    expect(await currentFactCount()).toBe(1);

    await expect(env.DB.prepare(
      `DELETE FROM memory_fact_projection_versions
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind(identity.principalId, identity.deviceId).run()).rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT status FROM memory_fact_projection_versions WHERE projection_version = 1",
    ).first<string>("status")).toBe("published");
    expect(await currentFactCount()).toBe(1);
  });

  it("refuses direct updates to a published commit receipt", async () => {
    await publishSnapshot(1);
    const receipt = env.DB.prepare(
      `SELECT * FROM memory_fact_projection_commits
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind(identity.principalId, identity.deviceId);
    const head = env.DB.prepare(
      "SELECT * FROM memory_fact_projection_heads WHERE principal_id = ? AND device_id = ?",
    ).bind(identity.principalId, identity.deviceId);
    const originalReceipt = await receipt.first();
    const originalHead = await head.first();
    expect(originalReceipt).not.toBeNull();
    expect(await publishedVersion()).toBe(1);

    // A direct UPDATE must hit commits_immutable_update, without invoking commit_publish.
    await expect(env.DB.prepare(
      `UPDATE memory_fact_projection_commits SET manifest_hash = ?, committed_at = ?
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind("f".repeat(64), "2026-09-11T12:00:00.001Z", identity.principalId, identity.deviceId).run())
      .rejects.toThrow("memory_projection_commit_immutable");
    expect(await receipt.first()).toEqual(originalReceipt);
    expect(await head.first()).toEqual(originalHead);
  });

  it("refuses direct deletion of a published commit receipt", async () => {
    await publishSnapshot(1);
    const receipt = env.DB.prepare(
      `SELECT * FROM memory_fact_projection_commits
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind(identity.principalId, identity.deviceId);
    const head = env.DB.prepare(
      "SELECT * FROM memory_fact_projection_heads WHERE principal_id = ? AND device_id = ?",
    ).bind(identity.principalId, identity.deviceId);
    const originalReceipt = await receipt.first();
    const originalHead = await head.first();
    expect(originalReceipt).not.toBeNull();
    expect(await publishedVersion()).toBe(1);

    // REPLACE can abort in commit_publish even when commits_immutable_delete is absent.
    await expect(env.DB.prepare(
      `DELETE FROM memory_fact_projection_commits
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind(identity.principalId, identity.deviceId).run()).rejects.toThrow("memory_projection_commit_immutable");
    expect(await receipt.first()).toEqual(originalReceipt);
    expect(await head.first()).toEqual(originalHead);
  });

  it("refuses direct rewriting of published fact contents", async () => {
    const event = await appendSource("I like coffee");
    const existing = await fact("Sid likes coffee", [source(event, "I like coffee")]);
    await publishSnapshot(1, [existing]);
    const stored = env.DB.prepare(
      "SELECT * FROM memory_fact_projection_facts WHERE fact_id = ?",
    ).bind(existing.factId);
    const original = await stored.first();
    expect(original).not.toBeNull();

    await expect(env.DB.prepare(
      "UPDATE memory_fact_projection_facts SET text = ? WHERE fact_id = ?",
    ).bind("forged published text", existing.factId).run()).rejects.toThrow("memory_projection_fact_immutable");
    expect(await stored.first()).toEqual(original);
    expect(await publishedVersion()).toBe(1);
  });

  it("refuses direct rewriting of a published page under its committed manifest", async () => {
    await publishSnapshot(1);
    const stored = env.DB.prepare(
      `SELECT * FROM memory_fact_projection_pages
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1 AND page_index = 0`,
    ).bind(identity.principalId, identity.deviceId);
    const original = await stored.first();
    expect(original).not.toBeNull();

    await expect(env.DB.prepare(
      `UPDATE memory_fact_projection_pages SET page_hash = ?, page_json = ?
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1 AND page_index = 0`,
    ).bind("f".repeat(64), canonicalJson({ forged: true }), identity.principalId, identity.deviceId).run())
      .rejects.toThrow("memory_projection_page_immutable");
    expect(await stored.first()).toEqual(original);
    expect(await publishedVersion()).toBe(1);
  });

  it("removes retracted fact postings from FTS when a newer commit cleans up their version", async () => {
    const event = await appendSource("I like coffee");
    const retired = await fact("Sid likes coffee", [source(event, "I like coffee")]);
    await publishSnapshot(1, [retired]);
    const retiredRowid = await env.DB.prepare(
      "SELECT projection_fact_rowid FROM memory_fact_projection_facts WHERE fact_id = ?",
    ).bind(retired.factId).first<number>("projection_fact_rowid");
    expect(retiredRowid).not.toBeNull();
    const matches = (query: string) => env.DB.prepare(
      "SELECT rowid FROM memory_fact_projection_fts WHERE memory_fact_projection_fts MATCH ? ORDER BY rowid",
    ).bind(query).all<{ rowid: number }>();
    expect((await matches("coffee")).results).toEqual([{ rowid: retiredRowid }]);

    const replacementEvent = await appendSource("I like jasmine tea");
    const replacement = await fact("Sid likes jasmine tea", [source(replacementEvent, "I like jasmine tea")]);
    await publishSnapshot(2, [replacement]);
    expect(await publishedVersion()).toBe(2);
    expect(await currentFactCount()).toBe(1);
    expect(await env.DB.prepare(
      "SELECT fact_id FROM memory_fact_projection_facts WHERE fact_id = ?",
    ).bind(retired.factId).first()).toBeNull();
    const replacementRowid = await env.DB.prepare(
      "SELECT projection_fact_rowid FROM memory_fact_projection_facts WHERE fact_id = ?",
    ).bind(replacement.factId).first<number>("projection_fact_rowid");
    expect(replacementRowid).not.toBeNull();

    // A base-table join hides stale postings, so only a direct MATCH pins facts_fts_delete.
    expect((await matches("coffee")).results).toEqual([]);
    expect((await matches("jasmine")).results).toEqual([{ rowid: replacementRowid }]);
  });

  it("rolls back a replacement of an immutable published receipt", async () => {
    const built = await publishSnapshot(1);
    const fingerprint = await keyFingerprint();
    const original = await env.DB.prepare(
      `SELECT committed_at FROM memory_fact_projection_commits
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind(identity.principalId, identity.deviceId).first<string>("committed_at");
    await expect(env.DB.prepare(
      `INSERT OR REPLACE INTO memory_fact_projection_commits
       (principal_id, device_id, projection_version, manifest_hash, key_id,
        key_fingerprint, key_generation, committed_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      identity.principalId, identity.deviceId, built.commit.manifestHash, identity.keyId,
      fingerprint, identity.generation, "2026-09-11T12:00:00.001Z",
    ).run()).rejects.toThrow();
    expect(await env.DB.prepare(
      `SELECT committed_at FROM memory_fact_projection_commits
       WHERE principal_id = ? AND device_id = ? AND projection_version = 1`,
    ).bind(identity.principalId, identity.deviceId).first<string>("committed_at")).toBe(original);
    expect(await publishedVersion()).toBe(1);
  });

  it("rejects a fact id whose 32-character suffix is not lowercase hexadecimal", async () => {
    const expiresAt = new Date(initialNow.valueOf() + 3_600_000).toISOString();
    const fingerprint = await env.DB.prepare(
      "SELECT key_fingerprint FROM device_keys WHERE device_id = ? AND principal_id = ?",
    ).bind(identity.deviceId, identity.principalId).first<string>("key_fingerprint");
    if (fingerprint === null) throw new Error("fixture key missing");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_fact_projection_heads
         (principal_id, device_id, published_version, manifest_hash, published_at)
         VALUES (?, ?, 0, NULL, NULL)`,
      ).bind(identity.principalId, identity.deviceId),
      env.DB.prepare(
        `INSERT INTO memory_fact_projection_versions
         (principal_id, device_id, projection_version, manifest_hash, page_count, total_fact_count,
          key_id, key_fingerprint, key_generation, status, created_at, expires_at, published_at)
         VALUES (?, ?, 1, ?, 1, 1, ?, ?, ?, 'staged', ?, ?, NULL)`,
      ).bind(
        identity.principalId, identity.deviceId, "1".repeat(64), identity.keyId,
        fingerprint, identity.generation, initialNow.toISOString(), expiresAt,
      ),
      env.DB.prepare(
        `INSERT INTO memory_fact_projection_pages
         (principal_id, device_id, projection_version, page_index, page_hash, fact_count, page_json, created_at)
         VALUES (?, ?, 1, 0, ?, 1, '{}', ?)`,
      ).bind(identity.principalId, identity.deviceId, "1".repeat(64), initialNow.toISOString()),
    ]);

    await expect(env.DB.prepare(
      `INSERT INTO memory_fact_projection_facts
       (principal_id, device_id, projection_version, page_index, fact_position, fact_id, text,
        origin, sensitivity, confidence, distiller_version, distilled_at, content_hash,
        primary_event_id, primary_event_sequence, sources_json, fact_json)
       VALUES (?, ?, 1, 0, 0, ?, 'safe', 'authenticated_first_person', 'normal', 1,
        'test', ?, ?, ?, 1, '[{}]', '{}')`,
    ).bind(
      identity.principalId, identity.deviceId, `fact_a${"!".repeat(31)}`,
      initialNow.toISOString(), "a".repeat(64), newUlid(),
    ).run()).rejects.toThrow();
  });
});
