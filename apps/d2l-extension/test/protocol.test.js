import test from "node:test";
import assert from "node:assert/strict";
import { createHash, verify, KeyObject } from "node:crypto";
import { canonical, courseBody, createKey, publicKeyBase64, sign, post, uploadBlock, AUDIENCE, GATEWAY, PATHS } from "../protocol.js";
import { delivery } from "../delivery.js";
import { clock, batch, memory, json } from "./fixtures.js";

test("It canonicalizes JSON with the receiver ordering, Unicode rules, and structural bounds.", () => {
  assert.equal(canonical({ z: "e\u0301", a: { "2": true, "10": null }, n: -0 }), '{"a":{"10":null,"2":true},"n":0,"z":"é"}');
  assert.throws(() => canonical({ "é": 1, "e\u0301": 2 }));
  for (const value of ["\ud800", Infinity, undefined, Array(4097).fill(0)]) assert.throws(() => canonical(value));
  let deep = []; for (let i = 0; i < 33; i += 1) deep = [deep];
  assert.throws(() => canonical(deep));
  assert.throws(() => canonical({ x: "é".repeat(32768) }));
  assert.throws(() => canonical("x".repeat(65534)));
});
test("It generates a non-extractable Ed25519 private key and signs the receiver exact envelope.", async () => {
  const keys = await createKey();
  assert.equal(keys.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", keys.privateKey));
  assert.equal(Buffer.from(await publicKeyBase64(keys), "base64").length, 32);
  const body = canonical(batch());
  const identity = { collectorId: "synthetic-collector", principalId: "synthetic-owner" };
  const signed = await sign("/school/observations", body, keys, identity, clock());
  assert.deepEqual(Object.keys(signed).sort(), ["schemaVersion", "deviceId", "principalId", "audience", "issuedAt", "nonce", "bodyHash", "signatureBase64"].sort());
  assert.equal(AUDIENCE, "jarvis-school-collector"); assert.equal(signed.audience, "jarvis-school-collector");
  assert.equal(signed.schemaVersion, "1.0"); assert.equal(signed.deviceId, identity.collectorId); assert.equal(signed.principalId, identity.principalId);
  assert.equal(signed.issuedAt, clock()); assert.match(signed.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(signed.bodyHash, createHash("sha256").update(body).digest("hex"));
  // Exact signatureText layout from #169 at 5abba944, signed-request.ts. Node's
  // independent verifier catches changed line order, method, path, or encoding.
  const receiverText = Buffer.from(["POST", "/school/observations", signed.deviceId, signed.principalId,
    "jarvis-school-collector", signed.issuedAt, signed.nonce, signed.bodyHash].join("\n"));
  assert.equal(verify(null, receiverText, KeyObject.from(keys.publicKey), Buffer.from(signed.signatureBase64, "base64")), true);
  assert.equal(verify(null, Buffer.concat([receiverText, Buffer.from("changed")]), KeyObject.from(keys.publicKey), Buffer.from(signed.signatureBase64, "base64")), false);
  const retry = await sign("/school/observations", body, keys, identity, clock());
  assert.notEqual(signed.nonce, retry.nonce); assert.equal(signed.bodyHash, retry.bodyHash);
  await assert.rejects(sign("/school/pairing/start", body, keys, identity, clock()));
});
test("It sends only pinned gateway POSTs without ambient credentials or redirect following.", async () => {
  const calls = [];
  const transport = async (...args) => { calls.push(args); return json({ status: "pending" }); };
  await post("/school/pairing/start", "{}", undefined, transport);
  await post("/school/pairing/status", "{}", { synthetic: true }, transport);
  assert.equal(calls[0][0], "https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev/school/pairing/start");
  assert.equal(calls[0][1].method, "POST"); assert.equal(calls[0][1].credentials, "omit");
  assert.equal(calls[0][1].redirect, "manual"); assert.equal(calls[0][1].cache, "no-store");
  assert.equal(calls[0][1].headers["x-jarvis-signed-request"], undefined);
  assert.equal(calls[1][1].headers["x-jarvis-signed-request"], '{"synthetic":true}');
  await assert.rejects(post("https://evil.invalid", "{}", undefined, transport));
  await assert.rejects(post(PATHS[0], "x".repeat(65536), undefined, transport));
  assert.equal(calls.length, 2);
  for (const response of [{ status: 0 }, { status: 302 }, { status: 200, redirected: true }]) await assert.rejects(post(PATHS[0], "{}", undefined, async () => response), /gateway-redirect-refused/);
  await assert.rejects(post(PATHS[0], "{}", undefined, async () => json({}, 403)), /gateway-refused-403/);
});
test("It replaces oversized course bodies with explicit failure evidence under sixty-four KiB.", () => {
  const small = courseBody(batch()); assert.equal(small.error, null);
  assert.equal(JSON.parse(small.body).routes[0].complete, true);
  for (const kind of ["bytes", "structure", "routes"]) {
    const b = batch();
    if (kind === "bytes") b.routes[0].body = { Text: "é".repeat(65536) };
    if (kind === "structure") b.routes[0].body = Array(4100).fill(null);
    if (kind === "routes") b.routes = [...b.routes, ...Array.from({ length: 253 }, (_, id) => ({ ...b.routes[0], route: `/d2l/api/le/1.82/1/dropbox/folders/${id}/submissions/mysubmissions/` }))];
    const result = courseBody(b); assert.equal(result.error, "batch-exceeds-wire-limits");
    assert.ok(Buffer.byteLength(result.body) < 65536);
    assert.ok(JSON.parse(result.body).routes.every((route) => route.status === 0 && !route.complete && route.body.collectorFailure === "batch-exceeds-wire-limits"));
  }
});
const identity = { collectorId: "synthetic-collector", principalId: "synthetic-owner", challenge: "synthetic-challenge", code: "FAKECODE1", expiresAt: "2026-09-23T20:10:00.000Z" };
test("It persists the key before pairing and proves only the server-issued challenge.", async () => {
  const store = memory(); const calls = [];
  const client = delivery({ store, clock, send: async (path, body, envelope) => {
    calls.push({ path, body: JSON.parse(body), envelope });
    assert.equal((await store.get("keys")).privateKey.extractable, false);
    return path.endsWith("start") ? identity : { status: "pending" };
  } });
  assert.equal((await client.pair("Synthetic PC")).status, "pending");
  assert.deepEqual(calls.map((call) => call.path), [PATHS[0], PATHS[1], PATHS[2]]);
  assert.equal(calls[0].envelope, undefined);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["deviceLabel", "publicKeyBase64"]);
  assert.deepEqual(calls[1].body, { challenge: identity.challenge });
  assert.equal(calls[1].envelope.deviceId, identity.collectorId);
  await client.pair("Synthetic PC");
  assert.equal(calls.filter((call) => call.path === PATHS[0]).length, 1);
});
test("It refuses invalid pairing labels, malformed responses, and invented pairing states.", async () => {
  for (const label of ["", "x".repeat(65), "bad\nlabel"]) {
    const client = delivery({ store: memory(), clock, send: async () => assert.fail("No network") });
    await assert.rejects(client.pair(label), /invalid-device-label/);
  }
  await assert.rejects(delivery({ store: memory(), clock, send: async () => ({}) }).pair("Synthetic"), /invalid-pairing-response/);
  const store = memory({ pairing: { ...identity, status: "pending" }, keys: await createKey() });
  await assert.rejects(delivery({ store, clock, send: async () => ({ status: "revoked-maybe" }) }).status());
  assert.deepEqual(await delivery({ store: memory(), clock }).status(), { status: "unpaired" });
});
test("It retains failed batches across restarts and retries identical bytes with fresh nonces.", async () => {
  const store = memory({ pairing: { ...identity, status: "active" }, keys: await createKey() });
  const calls = [];
  let fail = true;
  const send = async (path, body, envelope) => { calls.push({ path, body, envelope }); if (fail) throw Error(); return { batchId: "synthetic-batch", outcome: "failed" }; };
  const first = delivery({ store, clock, send });
  await first.enqueue(batch());
  assert.equal((await first.flush()).queued, 1);
  fail = false;
  const second = delivery({ store, clock, send });
  assert.equal((await second.flush()).queued, 0);
  assert.equal(calls[0].body, calls[1].body);
  assert.notEqual(calls[0].envelope.nonce, calls[1].envelope.nonce);
  assert.deepEqual(await store.get("queue"), []);
});
test("It requires active pairing and a valid receipt before removing queued evidence.", async () => {
  for (const pairing of [undefined, { ...identity, status: "pending" }]) {
    const store = memory({ pairing, keys: await createKey() });
    let sends = 0;
    const client = delivery({ store, clock, send: async () => { sends += 1; return { batchId: "synthetic", outcome: "good" }; } });
    await client.enqueue(batch()); assert.equal((await client.flush()).queued, 1);
    assert.equal(sends, 0);
  }
  for (const receipt of [{}, { batchId: "synthetic", outcome: "pending" }]) {
    const store = memory({ pairing: { ...identity, status: "active" }, keys: await createKey() });
    const client = delivery({ store, clock, send: async () => receipt });
    await client.enqueue(batch()); assert.equal((await client.flush()).queued, 1);
  }
});
test("It continues delivering other courses when one queued batch is refused.", async () => {
  const store = memory({ pairing: { ...identity, status: "active" }, keys: await createKey() });
  const calls = [];
  const client = delivery({ store, clock, send: async (_, body) => {
    const value = JSON.parse(body); calls.push(value.course.id);
    if (value.course.id === "1") throw Error();
    return { batchId: "synthetic", outcome: "good" };
  } });
  await client.enqueue(batch());
  const second = batch();
  second.course = { id: "2", name: "Synthetic second" }; second.courseIds = ["2"];
  second.routes = second.routes.map((route) => ({ ...route,
    route: route.route.replace("/1/", "/2/").replace("orgUnitIdsCSV=1", "orgUnitIdsCSV=2") }));
  await client.enqueue(second);
  assert.equal((await client.flush()).queued, 1); assert.deepEqual(calls, ["1", "2"]);
  assert.equal((await store.get("queue"))[0].courseId, "1");
});
test("It retains an ambiguous proof for retry and stops pushing after a refused status check.", async () => {
  const store = memory(); let proofCount = 0; let unavailable = false;
  const client = delivery({ store, clock, send: async (path) => {
    if (path.endsWith("start")) return identity;
    if (path.endsWith("prove") && ++proofCount === 1) throw Error("Synthetic dropped response");
    if (path.endsWith("status") && unavailable) throw Error("Synthetic refusal");
    return { status: "active" };
  } });
  assert.equal((await client.pair("Synthetic PC")).code, identity.code);
  await client.prove(); await client.prove(); assert.equal(proofCount, 2);
  unavailable = true;
  await assert.rejects(client.status(), /pairing-unavailable-or-refused/);
  await client.enqueue(batch());
  assert.equal((await client.flush()).error, "pairing-required");
});
test("It preserves an approved key through temporary receiver failures and later setup retries.", async () => {
  const store = memory(); let unavailable = false; let starts = 0; let time = clock();
  const client = delivery({ store, clock: () => time, send: async (path) => {
    if (path.endsWith("start")) { starts += 1; return identity; }
    if (unavailable) throw Error("Synthetic offline receiver");
    return { status: "active" };
  } });
  await client.pair("Synthetic PC");
  const original = await publicKeyBase64(await store.get("keys"));
  unavailable = true; time = "2026-09-24T20:00:00.000Z";
  await assert.rejects(client.status()); await assert.rejects(client.pair("Synthetic PC"));
  assert.equal(starts, 1); assert.equal(await publicKeyBase64(await store.get("keys")), original);
});
test("It retains incompatible board and tool evidence without sending an invalid receiver batch.", async () => {
  const store = memory({ pairing: { ...identity, status: "active" }, keys: await createKey() });
  let sends = 0;
  const client = delivery({ store, clock, send: async () => { sends += 1; return { batchId: "synthetic", outcome: "good" }; } });
  const cases = [
    { ...batch(), host: "durham.elearningontario.ca" },
    ...["news/", "quizzes/", "../2/content/toc"].map((suffix) => ({ ...batch(), routes: [...batch().routes,
      { ...batch().routes[0], route: `/d2l/api/le/1.82/1/${suffix}` }] })),
    { ...batch(), routes: [{ ...batch().routes[0], route: "/d2l/api/le/1.82/2/content/toc" }] },
  ];
  for (const value of cases) {
    await store.set("queue", []);
    const entry = await client.enqueue(value);
    assert.equal(entry.error, value.host === "durham.elearningontario.ca" ? "receiver-contract-host-unsupported" : "receiver-contract-route-unsupported");
    assert.deepEqual(JSON.parse(entry.body), value);
    assert.equal((await client.flush()).error, "receiver-contract-incompatible");
    assert.equal((await store.get("queue")).length, 1);
  }
  assert.equal(sends, 0);
  assert.equal(uploadBlock(batch()), null);
});
