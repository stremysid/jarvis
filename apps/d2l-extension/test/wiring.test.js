import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readdirSync } from "node:fs";
import { load, plain, json, root, source, fakeApi, enrollment } from "./helpers.js";

test("It grants only the LDSB host and storage in Manifest V3.", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://ldsb.elearningontario.ca/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[0].world, "ISOLATED");
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src https:\/\/ldsb\.elearningontario\.ca$/);
  for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts[0].js]) {
    assert.ok(existsSync(new URL(file, root)), file);
  }
});

test("It contains no cookie, DOM scraping, alternate network or dynamic execution path.", () => {
  for (const file of ["probe.js", "controller.js", "worker.js", "content.js"]) {
    assert.doesNotMatch(source(file), /document\.|innerHTML|localStorage|\.cookies|XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function|console\./);
  }
  assert.doesNotMatch(source("popup.js"), /innerHTML|console\./);
});

test("It permits only the probe read fetch call across every runtime script and popup asset.", () => {
  const runtimeFiles = readdirSync(root).filter((file) => /\.(?:[cm]?js|html|css)$/.test(file));
  assert.ok(runtimeFiles.includes("popup.js") && runtimeFiles.includes("popup.html"));
  const callSites = [];
  for (const file of runtimeFiles) {
    let text = source(file);
    // The transport and its worker injector bind fetch without making a request.
    // Removing only these exact expressions leaves any added API use visible.
    if (file === "probe.js" || file === "worker.js") {
      text = text.replace("globalThis.fetch.bind(globalThis)", "BOUND_TRANSPORT");
    }
    for (const match of text.matchAll(/\b(?:fetch|fetchImpl)\s*\(/g)) callSites.push({ file, call: match[0] });
    if (file === "probe.js") text = text.replace("response = await fetchImpl(url, {", "response = await ALLOWED_READ(url, {");
    if (file === "worker.js") text = text.replace('importScripts("probe.js", "controller.js");', "");
    assert.doesNotMatch(text,
      /\bfetch\b|\bfetchImpl\s*\(|\b(?:XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b|\bimportScripts\s*\(/,
      file);
  }
  assert.deepEqual(callSites, [{ file: "probe.js", call: "fetchImpl(" }]);
});

test("It runs background reads only with no D2L tabs and persists shapes rather than bodies.", async () => {
  const { api, state, calls } = fakeApi();
  const context = load();
  let fetchCalls = 0;
  await context.D2LController.createController(api, async (url) => {
    fetchCalls += 1;
    return json(url.includes("myenrollments") ? { Items: [] } : [{ Name: "SYNTHETIC_PRIVATE_BODY" }]);
  }).run();
  assert.equal(fetchCalls, 2);
  assert.equal(state.background.state, "finished");
  assert.equal(state.content, undefined);
  assert.equal(state.background.rows.length, 2);
  assert.ok(calls.every(([type, query]) => type === "query" && query.url === context.D2LProbe.MATCH));
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_PRIVATE|"body"/);
});

test("It runs open-tab requests through the content script and retains the background comparison.", async () => {
  const { api, state, calls } = fakeApi([{ id: 11, active: false }, { id: 22, active: true }]);
  state.background = { state: "finished", rows: [] };
  const context = load();
  await context.D2LController.createController(api, async () => { assert.fail("Background fetch must not run with a D2L tab open."); }).run();
  assert.equal(state.content.state, "finished");
  assert.equal(state.background.state, "finished");
  const messages = calls.filter(([type]) => type === "message");
  assert.equal(messages.length, 2);
  assert.ok(messages.every(([, id, message, options]) => id === 22 && message.type === "D2L_READ" && options.frameId === 0));
});

test("It interrupts a background pass when a D2L tab opens before a request.", async () => {
  const { api, state } = fakeApi();
  let queries = 0;
  api.tabs.query = async () => ++queries === 1 ? [] : [{ id: 11 }];
  let fetchCalls = 0;
  await load().D2LController.createController(api, async () => { fetchCalls += 1; return json([]); }).run();
  assert.equal(fetchCalls, 0);
  assert.match(state.background.state, /^interrupted/);
});

test("It interrupts a background pass when a D2L tab opens during a request.", async () => {
  const { api, state } = fakeApi();
  let queries = 0;
  api.tabs.query = async () => ++queries < 3 ? [] : [{ id: 11 }];
  let fetchCalls = 0;
  await load().D2LController.createController(api, async () => { fetchCalls += 1; return json([]); }).run();
  assert.equal(fetchCalls, 1);
  assert.match(state.background.state, /^interrupted/);
  assert.equal(state.background.rows.length, 0);
});

test("It prevents a duplicate click from starting a second concurrent pass.", async () => {
  const { api } = fakeApi();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  const controller = load().D2LController.createController(api, async (url) => {
    requests += 1; await held; return json(url.includes("myenrollments") ? { Items: [] } : []);
  });
  const first = controller.run();
  const second = controller.run();
  release();
  await Promise.all([first, second]);
  assert.equal(requests, 2);
});

test("It stores an explicit interruption when a tab closes or its content script is unavailable.", async () => {
  const { api, state } = fakeApi([{ id: 11 }]);
  api.tabs.sendMessage = async () => { throw new Error("SYNTHETIC_PRIVATE_TAB_ERROR"); };
  await load().D2LController.createController(api).run();
  assert.match(state.content.state, /^interrupted/);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_PRIVATE/);
});

test("It rejects a failed tab preflight instead of presenting an old report as a completed pass.", async () => {
  const { api, state } = fakeApi();
  state.background = { state: "finished", rows: [] };
  api.tabs.query = async () => { throw new Error("SYNTHETIC_PRIVATE_PREFLIGHT"); };
  const controller = load().D2LController.createController(api, async () => assert.fail());
  await assert.rejects(controller.run(), /probe-unavailable/);
  const reply = await new Promise((resolve) => controller.onMessage({ type: "RUN_PROBE" }, {
    id: api.runtime.id, url: api.runtime.getURL("popup.html"),
  }, resolve));
  assert.equal(reply.done, false);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_PRIVATE/);
});

test("It accepts probe commands only from this extension popup.", async () => {
  const { api } = fakeApi();
  const controller = load().D2LController.createController(api, async (url) => json(url.includes("myenrollments") ? { Items: [] } : []));
  for (const sender of [{ id: "other", url: api.runtime.getURL("popup.html") }, { id: api.runtime.id, url: "https://ldsb.elearningontario.ca/" }]) {
    assert.equal(controller.onMessage({ type: "RUN_PROBE" }, sender, () => assert.fail()), false);
  }
  const sender = { id: api.runtime.id, url: api.runtime.getURL("popup.html") };
  assert.equal(controller.onMessage({ type: "OTHER" }, sender, () => assert.fail()), false);
  const result = await new Promise((resolve) => {
    assert.equal(controller.onMessage({ type: "RUN_PROBE" }, sender, resolve), true);
  });
  assert.deepEqual(plain(result), { done: true });
});

test("It accepts content reads only from its extension and never from a tab sender.", async () => {
  let listener;
  let requests = 0;
  const chrome = { runtime: { id: "test-extension", onMessage: { addListener(fn) { listener = fn; } } } };
  const context = load({ chrome, fetch: async () => { requests += 1; return json([]); } });
  vm.runInContext(source("content.js"), context);
  for (const sender of [{ id: "other" }, { id: "test-extension", tab: { id: 1 } }]) {
    assert.equal(listener({ type: "D2L_READ", route: "versions" }, sender, () => assert.fail()), false);
  }
  assert.equal(listener({ type: "OTHER" }, { id: "test-extension" }, () => assert.fail()), false);
  const result = await new Promise((resolve) => assert.equal(listener({ type: "D2L_READ", route: "versions" }, { id: "test-extension" }, resolve), true));
  assert.equal(result.status, 200);
  assert.equal(requests, 1);
  const invalid = await new Promise((resolve) => listener({ type: "D2L_READ", route: "https://invalid.example" }, { id: "test-extension" }, resolve));
  assert.equal(invalid.error, "invalid-route");
  assert.equal(requests, 1);
});

test("It wires the real worker entry point to the controller with no automatic probe.", () => {
  let listener;
  const { api } = fakeApi();
  api.runtime.onMessage = { addListener(fn) { listener = fn; } };
  const context = vm.createContext({ chrome: api, URL, AbortSignal, fetch: async () => assert.fail("No automatic request is allowed.") });
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(source(file), context); };
  vm.runInContext(source("worker.js"), context);
  assert.equal(typeof listener, "function");
});

test("It traverses the real content listener from the controller and stores only shapes.", async () => {
  const { api, state } = fakeApi([{ id: 11 }]);
  let listener;
  const requested = [];
  const content = load({ chrome: { runtime: { id: api.runtime.id,
    onMessage: { addListener(fn) { listener = fn; } },
  } }, fetch: async (url, init) => {
    requested.push({ url, method: init.method });
    if (url.includes("myenrollments")) return json({ Items: [enrollment("101")] });
    if (url.endsWith("/folders/")) return json([{ Id: "202", Name: "SYNTHETIC_PRIVATE_FOLDER" }]);
    return json({ Objects: [{ Grade: 98.765, Name: "SYNTHETIC_PRIVATE_CONTENT" }], Next: null });
  } });
  vm.runInContext(source("content.js"), content);
  api.tabs.sendMessage = async (_id, message) => await new Promise((resolve) => {
    assert.equal(listener(message, { id: api.runtime.id }, resolve), true);
  });
  await load().D2LController.createController(api, async () => assert.fail("Only the content transport may fetch.")).run();
  assert.equal(state.content.state, "finished");
  assert.equal(requested.length, 9);
  assert.ok(requested.every((request) => request.method === "GET"));
  assert.ok(requested.at(-1).url.endsWith("/202/submissions/mysubmissions/"));
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_PRIVATE|98\.765|"body"|\/101\/|\/202\//);
});

test("It renders and copies the shape report and provides a clipboard fallback without extra permission.", async () => {
  const elements = Object.fromEntries(["run", "copy", "status", "summary"].map((id) => [id, {
    value: "", textContent: "", listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; },
    focus() { this.focused = true; }, select() { this.selected = true; },
  }]));
  let copied;
  let rejectClipboard = false;
  let changed;
  const context = load({ document: { getElementById: (id) => elements[id] },
    navigator: { clipboard: { async writeText(value) { if (rejectClipboard) throw new Error("blocked"); copied = value; } } },
    chrome: {
      storage: { session: { async get() { return { background: { state: "finished", rows: [] } }; } }, onChanged: { addListener(fn) { changed = fn; } } },
      runtime: { async sendMessage(message) { assert.equal(message.type, "RUN_PROBE"); return { done: true }; } },
    },
  });
  vm.runInContext(source("popup.js"), context);
  await elements.run.listeners.click();
  assert.equal(elements.run.disabled, false);
  assert.match(elements.summary.value, /background: finished/);
  await elements.copy.listeners.click();
  assert.equal(copied, elements.summary.value);
  rejectClipboard = true;
  await elements.copy.listeners.click();
  assert.equal(elements.summary.selected, true);
  assert.match(elements.status.textContent, /Ctrl\+C/);
  assert.equal(typeof changed, "function");
});
