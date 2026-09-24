import { readFileSync } from "node:fs";
import vm from "node:vm";

export const root = new URL("../", import.meta.url);
export const source = (name) => readFileSync(new URL(name, root), "utf8");
export function load(extra = {}) {
  const sandbox = vm.createContext({ URL, AbortSignal, ...extra });
  vm.runInContext(source("probe.js"), sandbox);
  vm.runInContext(source("controller.js"), sandbox);
  return sandbox;
}
export const plain = (value) => JSON.parse(JSON.stringify(value));
export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
export const enrollment = (id, access = true, type = 4) => ({
  OrgUnit: { Id: id, Name: "SYNTHETIC_PRIVATE_COURSE", Type: { Id: type } },
  Access: { CanAccess: access, IsActive: false },
});

export function fakeApi(openTabs = []) {
  const state = {};
  const calls = [];
  const api = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}` },
    storage: { session: {
      async set(update) { Object.assign(state, plain(update)); },
      async get() { return plain(state); },
    } },
    tabs: {
      async query(query) { calls.push(["query", plain(query)]); return openTabs; },
      async sendMessage(id, message, options) {
        calls.push(["message", id, plain(message), plain(options)]);
        return { status: 200, body: message.route === "enrollments" ? { Items: [] } : [] };
      },
    },
  };
  return { api, state, calls };
}
