import test from "node:test";
import assert from "node:assert/strict";
import { delivery, QUEUE_PER_COURSE, QUEUE_MAX_BYTES, FLUSH_ATTEMPTS } from "../delivery.js";
import { createKey, canonical } from "../protocol.js";
import { controller } from "../controller.js";
import { format } from "../popup.js";
import { batch, clock, memory, fakeApi, json, versions, page, D2L } from "./fixtures.js";

function courseBatch(id, host = "ldsb.elearningontario.ca", readId = "synthetic-read") {
  const value = batch();
  value.course.id = String(id); value.courseIds = [String(id)]; value.host = host; value.readId = readId;
  value.routes = value.routes.map((route) => ({ ...route,
    route: route.route.replace("/1/", `/${id}/`).replace("orgUnitIdsCSV=1", `orgUnitIdsCSV=${id}`) }));
  return value;
}
const active = async () => ({ pairing: { status: "active", collectorId: "synthetic", principalId: "synthetic-owner" }, keys: await createKey() });
function measuredStore(initial = {}) {
  const base = memory(initial); const writes = [];
  return { ...base, writes, set: async (key, value) => { if (key === "queue") writes.push(structuredClone(value)); await base.set(key, value); } };
}

test("It bounds a week of unavailable delivery to the newest two reads of each board and course.", async () => {
  assert.equal(QUEUE_PER_COURSE, 2);
  const store = measuredStore(); const client = delivery({ store, clock });
  let evictions = 0;
  for (let hour = 0; hour < 168; hour += 1) {
    for (const host of ["ldsb.elearningontario.ca", "durham.elearningontario.ca"]) {
      for (let id = 1; id <= 8; id += 1) await client.enqueue(courseBatch(id, host, `hour-${hour}`));
    }
    assert.equal(store.writes.length, hour);
    const receipt = await client.flush(); evictions += receipt.evicted;
    assert.equal(receipt.queued, hour ? 32 : 16);
    assert.equal(store.writes.length, hour + 1);
  }
  const queue = await store.get("queue");
  assert.equal(evictions, 2656);
  assert.equal(queue.length, 32);
  assert.ok(queue.every((entry) => ["hour-166", "hour-167"].includes(entry.readId)));
  assert.equal(queue.filter((entry) => entry.courseId === "1").length, 4);
});

test("It bounds serialized queue bytes and exposes every eviction in the popup.", async () => {
  assert.equal(QUEUE_MAX_BYTES, 1048576);
  const store = measuredStore(); const client = delivery({ store, clock });
  for (let id = 1; id <= 30; id += 1) {
    const value = courseBatch(id); value.routes[0].body = "é".repeat(22000);
    await client.enqueue(value);
  }
  assert.equal(store.writes.length, 0);
  const receipt = await client.flush();
  const queue = await store.get("queue");
  assert.ok(Buffer.byteLength(JSON.stringify(queue)) <= QUEUE_MAX_BYTES);
  assert.ok(receipt.evicted > 0); assert.equal(receipt.evicted, 30 - queue.length);
  assert.equal(queue.at(-1).courseId, "30");
  assert.equal(store.writes.length, 1);
  assert.match(format({ delivery: receipt }), new RegExp(`queue-evicted-${receipt.evicted}\\b`));
  assert.doesNotMatch(format({ delivery: { queued: 0, evicted: 0, error: null } }), /queue-evicted/);
  // Existing installations may already have an oversized queue; no enqueue is
  // needed before the upgrade must reclaim it and report the evictions.
  await store.set("queue", Array.from({ length: 200 }, (_, id) => ({ ...queue[0], courseId: String(id) })));
  const upgraded = await delivery({ store, clock }).flush();
  assert.ok(upgraded.evicted > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(await store.get("queue"))) <= QUEUE_MAX_BYTES);
});

test("It retains held Durham evidence when a mixed queue delivers an LDSB batch.", async () => {
  const store = measuredStore(await active()); const calls = [];
  const client = delivery({ store, clock, send: async (_, body) => { calls.push(JSON.parse(body).host); return { batchId: "synthetic", outcome: "good" }; } });
  const held = await client.enqueue(courseBatch(1, "durham.elearningontario.ca"));
  await client.enqueue(courseBatch(1));
  const result = await client.flush();
  assert.deepEqual(calls, ["ldsb.elearningontario.ca"]);
  assert.equal(result.queued, 1); assert.equal(result.evicted, 0);
  assert.equal(result.error, "receiver-contract-incompatible");
  assert.equal((await store.get("queue"))[0].body, held.body);
  assert.equal(store.writes.length, 1);
});

test("It limits each flush to eight attempts and commits the queue once for success or refusal.", async () => {
  assert.equal(FLUSH_ATTEMPTS, 8);
  for (const refused of [false, true]) {
    const store = measuredStore(await active()); let calls = 0;
    const client = delivery({ store, clock, send: async () => { calls += 1; if (refused) throw Error("Synthetic offline"); return { batchId: "synthetic", outcome: "good" }; } });
    for (let id = 1; id <= 12; id += 1) await client.enqueue(courseBatch(id));
    const result = await client.flush();
    assert.equal(calls, 8); assert.equal(result.queued, refused ? 12 : 4); assert.equal(store.writes.length, 1);
    if (!refused) { assert.equal((await client.flush()).queued, 0); assert.equal(calls, 12); assert.equal(store.writes.length, 2); }
  }
});

test("It retains pending evidence if the single queue commit fails and retries it without duplication.", async () => {
  const base = memory(); let fail = true;
  const store = { ...base, set: async (key, value) => { if (key === "queue" && fail) throw Error("Synthetic quota failure"); await base.set(key, value); } };
  const client = delivery({ store, clock });
  await client.enqueue(courseBatch(1)); await assert.rejects(client.flush(), /quota failure/);
  assert.equal(await base.get("queue"), undefined);
  fail = false;
  assert.equal((await client.flush()).queued, 1);
  assert.equal((await client.flush()).queued, 1);
});

test("It commits collected evidence once when a later host interrupts the run without uploading it.", async () => {
  const f = fakeApi(); const store = measuredStore({ ...await active(), queue: [{ body: canonical(courseBatch(2)), host: "ldsb.elearningontario.ca", courseId: "2" }] }); let sends = 0;
  const baseGet = store.get;
  store.get = async (key) => { if (key === `courses:${D2L.HOSTS[1]}`) throw Error("Synthetic storage interruption"); return baseGet(key); };
  const app = controller({ ...f, store, clock, sleep: async () => {}, send: async () => { sends += 1; return {}; },
    fetchImpl: async (url) => json(url.endsWith("/versions/") ? versions : url.includes("myenrollments") ? page() : []) });
  await app.run();
  assert.equal(store.writes.length, 1); assert.equal((await store.get("queue")).length, 2);
  assert.equal(sends, 0); assert.equal(f.state.status.delivery.error, "read-interrupted");
  assert.equal(f.state.status.running, false);
});

test("It revalidates a hop loaded directly from settings before creating any tab for it.", async () => {
  const f = fakeApi(); const store = memory({ settings: { hop: "https://untrusted.invalid/hop" } });
  const app = controller({ ...f, store, clock, sleep: async () => {}, fetchImpl: async (url) =>
    url.startsWith(D2L.HOSTS[1]) ? json({}, 401) : json(url.endsWith("/versions/") ? versions : url.includes("myenrollments") ? page() : []) });
  await app.run();
  assert.equal(f.events.filter(([type]) => type === "create").length, 0);
  assert.equal(f.state.status.error, "collector-interrupted-or-storage-unavailable");
  assert.doesNotMatch(format(f.state.status), /untrusted\.invalid/);
});
