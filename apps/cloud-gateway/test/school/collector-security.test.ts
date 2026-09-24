import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../../packages/contracts/src/index.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";
import { collectorFixture, observedBatch, bytes, readKey } from "./collector-fixtures.js";
import { parseSchoolBatch, verifyCollectorRequest, SCHOOL_AUDIENCE, exact, identifier } from "../../src/school/collector-protocol.js";
import { SchoolCollectorPairing } from "../../src/school/collector-pairing.js";
import { DeviceRequestVerifier, decodeCanonicalBase64 } from "../../src/sync/signed-request.js";
import worker from "../../src/index.js";
import type { Env } from "../../src/env.js";

beforeAll(applyNewestRuntimeMigration);

describe("school collector security", () => {
  it("activates only the proved key after the owner confirms its exact decision", async () => {
    const f = await collectorFixture(false);
    expect((await readKey(f.key.collector_id)).status).toBe("pending");
    const decision = await f.pairing.prove(f.key, { challenge: f.key.challenge });
    expect(decision.question).toContain(f.key.pairing_code);
    expect(await f.pairing.activateFromDecision(decision.decisionId, f.identity)).toBe(false);
    await f.decisions.markDelivered(decision.decisionId);
    await f.decisions.answer({ decisionId: decision.decisionId, answeredByIdentityId: f.identity, optionKey: "confirm" });
    expect(await f.pairing.activateFromDecision(decision.decisionId, "wrong-identity")).toBe(false);
    expect(await f.pairing.activateFromDecision(decision.decisionId, f.identity)).toBe(true);
    expect(await f.pairing.activateFromDecision(decision.decisionId, f.identity)).toBe(false);
    expect((await readKey(f.key.collector_id)).status).toBe("active");
    expect(await env.DB.prepare("SELECT * FROM device_keys WHERE device_id = ?").bind(f.key.collector_id).first()).toBeNull();
  });

  it("refuses a wrong challenge, an expired pairing, a reused challenge, and a rejected tap", async () => {
    const f = await collectorFixture(false);
    await expect(f.pairing.prove(f.key, { challenge: "wrong" })).rejects.toThrow("school_challenge_invalid");
    f.setNow(new Date(f.key.expires_at));
    await expect(f.pairing.prove(f.key, { challenge: f.key.challenge })).rejects.toThrow("school_challenge_invalid");
    f.setNow(new Date(Date.parse(f.key.expires_at) - 60_000));
    const decision = await f.pairing.prove(f.key, { challenge: f.key.challenge });
    await expect(f.pairing.prove(f.key, { challenge: f.key.challenge })).rejects.toThrow("school_challenge_consumed");
    await f.decisions.markDelivered(decision.decisionId);
    await f.decisions.answer({ decisionId: decision.decisionId, answeredByIdentityId: f.identity, optionKey: "reject" });
    expect(await f.pairing.activateFromDecision(decision.decisionId, f.identity)).toBe(false);
    expect((await readKey(f.key.collector_id)).status).toBe("pending");
  });

  it("refuses a valid tap after pairing expiry and refuses a decision for a different collector", async () => {
    const f = await collectorFixture(false);
    const decision = await f.pairing.prove(f.key, { challenge: f.key.challenge });
    await f.decisions.markDelivered(decision.decisionId);
    await f.decisions.answer({ decisionId: decision.decisionId, answeredByIdentityId: f.identity, optionKey: "confirm" });
    f.setNow(new Date(f.key.expires_at));
    expect(await f.pairing.activateFromDecision(decision.decisionId, f.identity)).toBe(false);
    await expect(env.DB.prepare("UPDATE school_collector_keys SET status = 'active', activated_at = ? WHERE collector_id = ?")
      .bind(f.clock().toISOString(), f.key.collector_id).run()).rejects.toThrow("school_collector_tap_required");
    const other = await collectorFixture(false);
    expect(await other.pairing.activateFromDecision(decision.decisionId, other.identity)).toBe(false);
  });

  it("bounds public pairing and binds it to an active configured human owner", async () => {
    const f = await collectorFixture(false);
    const request = { publicKeyBase64: f.publicKeyBase64, deviceLabel: "bad\nlabel" };
    await expect(f.pairing.start(request)).rejects.toThrow("school_device_label_invalid");
    await expect(new SchoolCollectorPairing(env.DB, "missing-owner", f.clock).start({ ...request, deviceLabel: "test" }))
      .rejects.toThrow("school_pairing_unavailable");
    // Different synthetic keys exercise the durable rate bound rather than the unique key constraint.
    for (let i = 0; i < 4; i += 1) {
      const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
      const key = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer)));
      if (i < 3) await f.pairing.start({ publicKeyBase64: key, deviceLabel: "Synthetic" });
      else await expect(f.pairing.start({ publicKeyBase64: key, deviceLabel: "Synthetic" })).rejects.toThrow("school_pairing_unavailable");
    }
  });

  it("accepts a canonical signed course batch and refuses the same nonce twice", async () => {
    const f = await collectorFixture();
    const request = await f.request("/school/observations", observedBatch(f));
    const first = await f.dispatch(request.clone());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "good" });
    expect((await f.dispatch(request)).status).toBe(400);
  });

  it("refuses pending and revoked keys even with otherwise valid signatures", async () => {
    const f = await collectorFixture(false);
    const body = observedBatch(f);
    expect((await f.dispatch(await f.request("/school/observations", body))).status).toBe(400);
    await f.activate();
    expect(await f.pairing.revoke(f.key.collector_id)).toBe(true);
    expect(await f.pairing.revoke(f.key.collector_id)).toBe(false);
    expect((await f.dispatch(await f.request("/school/observations", body))).status).toBe(400);
  });

  it("stops an expired pending key from polling or growing the nonce table", async () => {
    const f = await collectorFixture(false);
    expect((await f.dispatch(await f.request("/school/pairing/status", {}))).status).toBe(200);
    f.setNow(new Date(f.key.expires_at));
    expect((await f.dispatch(await f.request("/school/pairing/status", {}))).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM school_collector_nonces WHERE collector_id = ?").bind(f.key.collector_id).first())
      .toEqual({ n: 1 });
  });

  it.each(["/sync/pull", "/sync/ack", "/memory/distill", "/sync/memory/project"])(
    "refuses a school collector signing the ordinary audience for %s", async (path) => {
      const f = await collectorFixture();
      const raw = bytes({ schemaVersion: "1.0" });
      const envelope = await f.sign(path, raw, { audience: "jarvis-local-agent" });
      await expect(new DeviceRequestVerifier({ database: env.DB, audience: "jarvis-local-agent" })
        .verify(envelope, "POST", path, {}, raw, f.clock(), (value) => value)).rejects.toThrow("device_not_active");
      const current = await f.sign(path, raw, { audience: "jarvis-local-agent", issuedAt: new Date().toISOString() });
      const response = await worker.fetch(new Request(`https://jarvis.example${path}`, { method: "POST", body: raw,
        headers: { "x-jarvis-signed-request": JSON.stringify(current) } }),
      { ...env, OWNER_PRINCIPAL_ID: f.owner, SYNC_CONTINUATION_SECRET: btoa(String.fromCharCode(...new Uint8Array(32))) } as Env,
      { waitUntil() {} } as unknown as ExecutionContext);
      expect(response.status).toBe(401);
    });

  it("refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes", async () => {
    const f = await collectorFixture();
    const path = "/school/observations";
    const raw = bytes(observedBatch(f));
    const check = async (overrides: object, target = path, payload = raw) => {
      const envelope = await f.sign(path, raw, overrides);
      await expect(verifyCollectorRequest(env.DB, f.owner, envelope, target, payload, f.clock(), "active")).rejects.toThrow();
    };
    await check({ audience: "jarvis-local-agent" });
    await check({ principalId: "other-owner" });
    await check({}, "/school/pairing/prove");
    await check({ issuedAt: new Date(f.clock().getTime() - 300_000).toISOString() });
    await check({ bodyHash: "0".repeat(64) });
    const broken = await f.sign(path, raw);
    await expect(verifyCollectorRequest(env.DB, f.owner, { ...broken, signatureBase64: btoa(String.fromCharCode(...new Uint8Array(64))) }, path, raw, f.clock(), "active"))
      .rejects.toThrow("school_signature_invalid");
    const padded = new TextEncoder().encode(" " + new TextDecoder().decode(raw));
    await expect(verifyCollectorRequest(env.DB, f.owner, await f.sign(path, padded), path, padded, f.clock(), "active")).rejects.toThrow("signed_body_noncanonical");
  });

  it("refuses oversized streaming bodies without trusting Content-Length", async () => {
    const f = await collectorFixture();
    const response = await f.dispatch(new Request("https://jarvis.example/school/observations", { method: "POST",
      headers: { "content-length": "1" }, body: new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(32_768)); controller.enqueue(new Uint8Array(32_769)); controller.close();
      } }) }));
    expect(response.status).toBe(413);
  });

  it("refuses wrong methods, unknown paths, query strings, missing owner and malformed envelopes", async () => {
    const f = await collectorFixture();
    expect((await f.dispatch(new Request("https://jarvis.example/school/observations"))).status).toBe(405);
    expect((await f.dispatch(new Request("https://jarvis.example/school/unknown", { method: "POST" }))).status).toBe(405);
    expect((await f.dispatch(await f.request("/school/observations?bypass=1", observedBatch(f)))).status).toBe(405);
    expect((await f.dispatch(new Request("https://jarvis.example/school/observations", { method: "POST", body: "{}" }))).status).toBe(400);
  });

  it("keeps collector key identity immutable and refuses key reuse in the device registry", async () => {
    const f = await collectorFixture(false);
    await expect(env.DB.prepare("UPDATE school_collector_keys SET device_label = 'changed' WHERE collector_id = ?").bind(f.key.collector_id).run())
      .rejects.toThrow("school_collector_key_immutable");
    await expect(env.DB.prepare("UPDATE school_collector_keys SET status = 'active', activated_at = ? WHERE collector_id = ?")
      .bind(f.clock().toISOString(), f.key.collector_id).run()).rejects.toThrow("school_collector_tap_required");
    await expect(env.DB.prepare(`INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 1, 'ed25519', 'active', 'Synthetic', ?, ?)`)
      .bind(`device-${f.key.collector_id}`, f.owner, `key-${f.key.collector_id}`, f.publicKeyBase64,
        await sha256Hex(decodeCanonicalBase64(f.publicKeyBase64, 32)), "0".repeat(64), f.clock().toISOString()).run()).rejects.toThrow("school_collector_scope_conflict");
    await f.pairing.revoke(f.key.collector_id);
    await expect(env.DB.prepare("UPDATE school_collector_keys SET status = 'pending' WHERE collector_id = ?").bind(f.key.collector_id).run())
      .rejects.toThrow("school_collector_key_immutable");
  });

  it("rejects malformed manifest, routes, source bindings and observation times", async () => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    const bad = [
      { ...batch, extra: true }, { ...batch, schemaVersion: "2" }, { ...batch, host: "evil.invalid" },
      { ...batch, readId: "x/y" }, { ...batch, courseIds: [] }, { ...batch, courseIds: ["elsewhere"] },
      { ...batch, courseIds: [f.courseId, ...Array.from({ length: 128 }, (_, i) => `extra-${i}`)] },
      { ...batch, courseIds: [f.courseId, f.courseId] }, { ...batch, enrollmentComplete: "true" },
      { ...batch, startedAt: new Date(f.clock().getTime() + 1).toISOString() },
      { ...batch, routes: [{ ...batch.routes[0], route: "/d2l/api/le/1.82/other/dropbox/folders/" }] },
      { ...batch, routes: [{ ...batch.routes[0], route: `/d2l/api/le/1.82/${f.courseId}/users/` }] },
      { ...batch, routes: [batch.routes[0], batch.routes[0]] },
      { ...batch, routes: Array.from({ length: 257 }, (_, i) => ({ ...batch.routes[0], route: `/d2l/api/le/1.82/${f.courseId}/dropbox/folders/${i}/submissions/` })) },
      { ...batch, routes: [{ ...batch.routes[0], status: -1 }] },
      { ...batch, routes: [{ ...batch.routes[0], complete: 1 }] },
      { ...batch, routes: [{ ...batch.routes[0], fetchedAt: new Date(f.clock().getTime() - 1).toISOString() }] },
    ];
    for (const input of bad) expect(() => parseSchoolBatch(input, f.clock())).toThrow();
    expect(() => exact([], [])).toThrow();
    expect(() => identifier("a\nb")).toThrow();
    expect(parseSchoolBatch(batch, f.clock())).toEqual(batch);
    expect(SCHOOL_AUDIENCE).toBe("jarvis-school-collector");
  });

  it("refuses directly inserted active keys and malformed public keys at the database boundary", async () => {
    const f = await collectorFixture(false);
    const insert = (suffix: string, status: string, publicKey: string) => env.DB.prepare(`INSERT INTO school_collector_keys
      (collector_id, principal_id, public_key_base64, device_label, status, challenge, pairing_code, created_at, expires_at)
      VALUES (?, ?, ?, 'Synthetic', ?, 'synthetic-challenge', 'synthetic-code', ?, ?)`)
      .bind(f.key.collector_id + suffix, f.owner, publicKey, status, f.clock().toISOString(), f.key.expires_at).run();
    await expect(insert("active", "active", "A".repeat(43) + "=")).rejects.toThrow("school_collector_insert_refused");
    await expect(insert("short", "pending", "short")).rejects.toThrow("CHECK constraint failed");
    await expect(insert("status", "invented", "B".repeat(43) + "=")).rejects.toThrow();
  });

  it("refuses a collector key during ordinary device rotation and refuses an existing device key for pairing", async () => {
    const f = await collectorFixture(false);
    const devicePublic = "C".repeat(43) + "=";
    const fingerprint = await sha256Hex(new Uint8Array(32).fill(3));
    const deviceId = `device-${f.key.collector_id}`;
    await env.DB.prepare(`INSERT INTO device_keys
      (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 1, 'ed25519', 'active', 'Synthetic', ?, ?)`)
      .bind(deviceId, f.owner, `key-${deviceId}`, devicePublic, fingerprint, "0".repeat(64), f.clock().toISOString()).run();
    await expect(env.DB.prepare(`UPDATE device_keys SET public_key_base64 = ?, key_fingerprint = ?, key_generation = 2, key_id = ? WHERE device_id = ?`)
      .bind(f.publicKeyBase64, await sha256Hex(decodeCanonicalBase64(f.publicKeyBase64, 32)), `rotated-${deviceId}`, deviceId).run())
      .rejects.toThrow("school_collector_scope_conflict");
    await expect(env.DB.prepare(`INSERT INTO school_collector_keys
      (collector_id, principal_id, public_key_base64, device_label, status, challenge, pairing_code, created_at, expires_at)
      VALUES (?, ?, ?, 'Synthetic', 'pending', 'synthetic', 'synthetic', ?, ?)`)
      .bind(`collector-${deviceId}`, f.owner, devicePublic, f.clock().toISOString(), f.key.expires_at).run())
      .rejects.toThrow("school_collector_insert_refused");
  });
});
