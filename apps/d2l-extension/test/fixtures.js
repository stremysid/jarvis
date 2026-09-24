import { readFileSync } from "node:fs";
import "../probe.js";
export const D2L = globalThis.D2L;
export const root = new URL("../", import.meta.url);
export const source = (file) => readFileSync(new URL(file, root), "utf8");
export const clock = () => "2026-09-23T20:00:00.000Z";
export const good = (body = []) => ({ status: 200, complete: true, body });
export const json = (body = [], status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const versions = [{ ProductCode: "lp", SupportedVersions: ["1.43"] }, { ProductCode: "le", SupportedVersions: ["1.82"] }];
export const course = (id = 1) => ({ OrgUnit: { Id: id, Name: `Synthetic course ${id}`, Type: { Id: 3 } }, Access: { CanAccess: true, IsActive: true } });
export const page = (items = [course()], hasMore = false, bookmark = null) => ({ Items: items, PagingInfo: { HasMoreItems: hasMore, Bookmark: bookmark } });
export function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, get: async (key) => structuredClone(data.get(key)), set: async (key, value) => { data.set(key, structuredClone(value)); } };
}
export function fixture() {
  const store = memory();
  const batches = [];
  const calls = [];
  const request = async (host, route, args = {}) => {
    calls.push({ host, route, args });
    return good(route === "versions" ? versions : route === "enrollments" ? page() : route === "toc" ? { Modules: [] } : route === "items" ? { Objects: [], Next: null } : []);
  };
  return { host: D2L.HOSTS[0], request, store, emit: async (batch) => { batches.push(batch); return {}; }, clock, readId: "synthetic-read", calls, batches };
}
export function batch() {
  return { schemaVersion: "1.0", host: "ldsb.elearningontario.ca", readId: "synthetic-read", startedAt: clock(), courseIds: ["1"],
    enrollmentComplete: true, course: { id: "1", name: "Synthetic course" },
    routes: ["items", "toc", "folders", "grades", "news", "quizzes"].map((route) => ({
      route: D2L.routeUrl(D2L.HOSTS[0], route, { course: 1 }).slice(D2L.HOSTS[0].length), status: 200, fetchedAt: clock(), complete: true, body: [],
    })) };
}
export function fakeApi() {
  const events = [];
  const state = {};
  const api = {
    runtime: { id: "synthetic-extension", getURL: (file) => `chrome-extension://synthetic-extension/${file}` },
    storage: { local: { set: async (update) => Object.assign(state, structuredClone(update)), get: async () => state } },
    tabs: {
      query: async (query) => { events.push(["query", query]); return []; },
      create: async (options) => { events.push(["create", options]); return { id: 42 }; },
      remove: async (id) => { events.push(["remove", id]); },
      sendMessage: async (...args) => { events.push(["message", ...args]); return good(page()); },
    },
  };
  return { api, events, state };
}
