import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import vm from "node:vm";
import { controller } from "../controller.js";
import { format } from "../popup.js";
import { GATEWAY } from "../protocol.js";
import { database } from "../database.js";
import { source, root, fakeApi, memory, versions, page, json, clock, D2L } from "./fixtures.js";

test("It grants only the two literal D2L hosts, the pinned gateway, alarms, and storage.", () => {
  assert.match(GATEWAY, /^https:\/\/[^/]+$/);
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["alarms", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://ldsb.elearningontario.ca/*", "https://durham.elearningontario.ca/*", `${GATEWAY}/*`]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://ldsb.elearningontario.ca/*", "https://durham.elearningontario.ca/*"]);
  assert.equal(manifest.content_scripts[0].all_frames, false); assert.equal(manifest.content_scripts[0].world, "ISOLATED");
  assert.equal(manifest.background.type, "module");
  for (const key of ["optional_permissions", "optional_host_permissions", "externally_connectable", "web_accessible_resources"]) assert.equal(manifest[key], undefined);
  assert.equal(manifest.content_security_policy.extension_pages, `script-src 'self'; object-src 'none'; connect-src https://ldsb.elearningontario.ca https://durham.elearningontario.ca ${GATEWAY}`);
  for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts[0].js]) assert.ok(existsSync(new URL(file, root)));
});
test("It allows one D2L read call site and one gateway push call site across every runtime asset.", () => {
  const files = readdirSync(root).filter((file) => /\.(?:[cm]?js|html|css)$/.test(file));
  const calls = [];
  assert.ok(files.includes("popup.html") && files.includes("popup.js"));
  for (const file of files) {
    let text = source(file);
    if (["probe.js", "protocol.js"].includes(file)) text = text.replace("globalThis.fetch.bind(globalThis)", "BOUND_TRANSPORT");
    for (const match of text.matchAll(/\b(?:fetch|fetchImpl)\s*\(/g)) calls.push({ file, call: match[0] });
    if (file === "probe.js") text = text.replace("response = await fetchImpl(url, {", "response = await ALLOWED_READ(url, {");
    if (file === "protocol.js") text = text.replace("const response = await fetchImpl(`${GATEWAY}${path}`, {", "const response = await ALLOWED_PUSH(`${GATEWAY}${path}`, {");
    assert.doesNotMatch(text, /\bfetch\b|\bfetchImpl\s*\(|\b(?:XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b|importScripts\s*\(|\bimport\s*(?:\(|[^;]*from\s*)["']https?:/);
    assert.doesNotMatch(text, /\.cookies\b|document\.cookie|\beval\s*\(|new Function|innerHTML|console\./);
    if (file !== "popup.js") assert.doesNotMatch(text, /document\.|querySelector|\.innerText|\.textContent/);
  }
  assert.deepEqual(calls, [{ file: "probe.js", call: "fetchImpl(" }, { file: "protocol.js", call: "fetchImpl(" }]);
});
test("It rejects control messages from content scripts and from non-popup extension pages.", () => {
  const f = fakeApi(); const app = controller({ ...f, store: memory() });
  const sender = { id: f.api.runtime.id, url: f.api.runtime.getURL("popup.html") };
  for (const altered of [{ ...sender, id: "foreign" }, { ...sender, tab: { id: 1 } }, { ...sender, url: "https://ldsb.elearningontario.ca" }, { ...sender, url: f.api.runtime.getURL("other.html") }]) {
    assert.equal(app.onMessage({ type: "SETUP" }, altered, () => assert.fail("No reply")), false);
  }
  assert.equal(app.onMessage({ type: "unknown" }, sender, () => assert.fail("No reply")), false);
});
test("It restricts content reads to worker messages for the current D2L origin.", async () => {
  let listener; let calls = 0;
  const sandbox = vm.createContext({ chrome: { runtime: { id: "own", onMessage: { addListener: (fn) => { listener = fn; } } } },
    location: { origin: D2L.HOSTS[0] }, D2L: { read: async () => { calls += 1; return { status: 200 }; }, failed: D2L.failed } });
  vm.runInContext(source("content.js"), sandbox);
  const message = { type: "D2L_READ", host: D2L.HOSTS[0], route: "versions", args: {} };
  for (const [value, sender] of [[message, { id: "foreign" }], [message, { id: "own", tab: {} }], [{ ...message, host: D2L.HOSTS[1] }, { id: "own" }], [{ ...message, type: "unknown" }, { id: "own" }]]) assert.equal(listener(value, sender, () => assert.fail()), false);
  await new Promise((resolve) => { assert.equal(listener(message, { id: "own" }, resolve), true); });
  assert.equal(calls, 1);
});
test("It wires hourly alarms and browser startup to the collector without widening permissions.", async () => {
  const listeners = {}; const calls = [];
  const event = (key) => ({ addListener: (fn) => { listeners[key] = fn; } });
  const sandbox = vm.createContext({
    controller: () => ({ run: async () => { calls.push("run"); }, onMessage: () => {} }), database: () => ({}),
    chrome: { runtime: { onInstalled: event("install"), onStartup: event("startup"), onMessage: event("message") },
      storage: { local: { setAccessLevel: async (value) => { calls.push(value); } } },
      alarms: { create: async (...args) => { calls.push(args); }, onAlarm: event("alarm") } },
  });
  vm.runInContext(source("worker.js").replace(/^import .*;\r?\n/gm, ""), sandbox);
  listeners.startup(); await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ accessLevel: "TRUSTED_CONTEXTS" }, ["d2l-hourly", { periodInMinutes: 60 }], "run"]);
  listeners.alarm({ name: "other" }); assert.equal(calls.length, 3);
  listeners.alarm({ name: "d2l-hourly" }); assert.equal(calls.length, 4);
  listeners.install(); await new Promise(setImmediate); assert.equal(calls.filter((call) => call === "run").length, 3);
});
test("It serializes sync runs and persists only course names and fixed status fields for the popup.", async () => {
  const f = fakeApi(); const store = memory(); let release; let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const app = controller({ ...f, store, clock, sleep: async () => {}, fetchImpl: async (url) => {
    calls += 1;
    if (calls === 1) await blocked;
    return json(url.endsWith("/versions/") ? versions : url.includes("myenrollments") ? page() : url.endsWith("/folders/") ? [] : { collectorFailure: "PRIVATE BODY", Grade: "PRIVATE GRADE", Text: "PRIVATE TEXT" });
  } });
  const first = app.run(); await new Promise(setImmediate); await app.run(); assert.equal(calls, 1);
  release(); await first;
  assert.equal(f.state.status.running, false); assert.equal(f.state.status.hosts.length, 2);
  assert.doesNotMatch(JSON.stringify(f.state.status), /PRIVATE|body|Grade|Text/);
  assert.match(format(f.state.status), /Synthetic course 1/);
  assert.equal((await store.get("queue")).length, 2);
  assert.equal(f.state.status.delivery.error, "pairing-required");
});
test("It preserves the last good timestamp when a later read expires and keeps raw failures out of the popup.", async () => {
  const f = fakeApi(); const store = memory({ [`lastGood:${D2L.HOSTS[0]}`]: clock(), [`courses:${D2L.HOSTS[0]}`]: [{ id: "1", name: "Synthetic course" }] });
  f.api.tabs.sendMessage = async () => D2L.failed(200, "session-expired");
  const app = controller({ ...f, store, clock, sleep: async () => {}, fetchImpl: async () => new Response("PRIVATE LOGIN HTML", { headers: { "content-type": "text/html" } }) });
  await app.run();
  assert.equal(f.state.status.hosts[0].lastGoodRead, clock());
  assert.match(format(f.state.status), /session-expired/); assert.doesNotMatch(format(f.state.status), /PRIVATE LOGIN/);
  assert.ok(JSON.parse((await store.get("queue"))[0].body).routes.every((route) => !route.complete));
  await app.run(true); assert.equal(f.state.status.backgroundTest.hosts[0].error, "session-expired");
});
test("It waits for IndexedDB transaction completion and rejects rollback instead of claiming durable storage.", async () => {
  let openRequest; let transaction; const request = { result: "synthetic" };
  const db = { createObjectStore: () => {}, transaction: () => (transaction = { objectStore: () => ({ get: () => request, put: () => request }) }) };
  const store = database({ open: () => (openRequest = { result: db }) });
  openRequest.onupgradeneeded(); openRequest.onsuccess();
  let done = false; const pending = store.set("keys", {}).then(() => { done = true; });
  await new Promise(setImmediate); assert.equal(done, false);
  transaction.oncomplete(); await pending; assert.equal(done, true);
  const aborted = store.set("queue", []); await new Promise(setImmediate); transaction.onabort(); await assert.rejects(aborted);
  const opened = database({ open: () => (openRequest = {}) });
  const read = opened.get("keys"); openRequest.onerror(); await assert.rejects(read);
});
