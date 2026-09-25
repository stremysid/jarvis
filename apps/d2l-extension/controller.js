import { collectHost, HOSTS } from "./collector.js";
import { sessions, validateHop } from "./sessions.js";
import { delivery } from "./delivery.js";

export function controller({ api, store, clock = () => new Date().toISOString(), makeId = () => crypto.randomUUID(), fetchImpl, send, sleep, now }) {
  let busy = false;
  const push = delivery({ store, clock, send });
  async function publish(status) {
    await store.set("status", status);
    await api.storage.local.set({ status });
  }
  async function run(backgroundOnly = false) {
    if (busy) return;
    busy = true;
    let status = { running: true, error: null };
    try {
      status = { ...(await store.get("status") ?? {}), ...status };
      await publish(status);
      const settings = await store.get("settings") ?? {};
      const session = sessions({ api, fetchImpl, hop: settings.hop, sleep, now });
      const hosts = [];
      for (const host of HOSTS) {
        if (backgroundOnly) {
          const result = await session.request(host, "enrollments", {}, true);
          hosts.push({ host, status: result.status, error: result.error ?? (result.complete ? null : "refused") });
          continue;
        }
        const summary = await collectHost({ host, request: session.request, store, emit: push.enqueue, clock, readId: makeId() });
        const lastGood = summary.lastGoodRead ?? await store.get(`lastGood:${host}`) ?? null;
        await store.set(`lastGood:${host}`, lastGood);
        hosts.push({ ...summary, lastGoodRead: lastGood, context: session.contexts[host] });
        status = { ...status, hosts };
        await publish(status);
      }
      if (backgroundOnly) status.backgroundTest = { at: clock(), hosts };
      else {
        try { status.pairing = await push.status(); }
        catch { status.pairing = { status: "unavailable-or-refused" }; }
      }
    } catch { status.error = "collector-interrupted-or-storage-unavailable"; }
    finally {
      try {
        if (!backgroundOnly) status.delivery = await push.flush(!status.error);
      } catch { status.error = "collector-interrupted-or-storage-unavailable"; }
      busy = false;
      await publish({ ...status, running: false });
    }
  }
  async function setup(message) {
    if (busy) throw new Error("collector-busy");
    busy = true;
    try {
      await store.set("settings", { hop: validateHop(message.hop) });
      const pairing = await push.pair(message.deviceLabel);
      await publish({ ...(await store.get("status") ?? {}), pairing });
    } finally { busy = false; }
  }
  async function pollPairing() {
    if (busy) return;
    busy = true;
    try {
      await push.prove().catch(() => {});
      let pairing;
      try { pairing = await push.status(); }
      catch { pairing = { status: "unavailable-or-refused" }; }
      const receipt = await push.flush();
      await publish({ ...(await store.get("status") ?? {}), pairing, delivery: receipt });
    } finally { busy = false; }
  }
  function onMessage(message, sender, reply) {
    // A content script cannot control pairing, retrieve the queue, or start reads.
    if (sender.id !== api.runtime.id || sender.tab !== undefined || sender.url !== api.runtime.getURL("popup.html")) return false;
    if (message?.type === "SYNC" || message?.type === "BACKGROUND_TEST") {
      void run(message.type === "BACKGROUND_TEST");
      reply({ accepted: true });
      return false;
    }
    const action = message?.type === "SETUP" ? () => setup(message) : message?.type === "PAIRING_STATUS" ? pollPairing : null;
    if (!action) return false;
    void action().then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
  return { run, onMessage, setup, pollPairing };
}
