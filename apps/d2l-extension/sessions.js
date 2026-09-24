import "./probe.js";
const { HOSTS, read, failed, needsSession } = globalThis.D2L;
export function validateHop(value) {
  if (value === "") return "";
  const url = new URL(value);
  if (!HOSTS.includes(url.origin) || url.username || url.password) throw new Error("invalid-hop");
  return url.href;
}

export function sessions({ api, fetchImpl, hop = "", sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  let lastRequest = -Infinity;
  const renewed = new Set();
  const contexts = {};
  async function paced(action) {
    await sleep(Math.max(0, 1000 - (now() - lastRequest)));
    lastRequest = now();
    return action();
  }
  const background = (host, route, args) => paced(() => read(host, route, args, fetchImpl));
  async function inTab(host, route, args, targetUrl = `${host}/d2l/home`) {
    let owned;
    try {
      const tabs = targetUrl === `${host}/d2l/home` ? await api.tabs.query({ url: `${host}/*` }) : [];
      const tab = tabs[0] ?? (owned = await api.tabs.create({ url: targetUrl, active: false }));
      // A new page must install its isolated script before it can answer.
      for (let attempt = 0; attempt < 15; attempt += 1) {
        try {
          const result = await paced(() => api.tabs.sendMessage(tab.id,
            { type: "D2L_READ", host, route, args }, { frameId: 0 }));
          if (result && typeof result.status === "number") return result;
        } catch { /* A loading page has no listener yet. */ }
        await sleep(1000);
      }
      return failed(0, "session-expired");
    } catch {
      return failed(0, "in-tab-unavailable");
    } finally {
      if (owned) await api.tabs.remove(owned.id).catch(() => {});
    }
  }
  async function ldsbLive() {
    let result = await background(HOSTS[0], "enrollments", {});
    if (needsSession(result)) result = await inTab(HOSTS[0], "enrollments", {});
    return result.status === 200 && result.complete;
  }
  async function request(host, route, args = {}, backgroundOnly = false) {
    let result = await background(host, route, args);
    contexts[host] = "background";
    if (!needsSession(result) || backgroundOnly) return result;
    if (host === HOSTS[0]) {
      contexts[host] = "content";
      return inTab(host, route, args);
    }
    // A refused tool must not repeatedly launch federation for the rest of the course.
    if (renewed.has(host)) return result;
    renewed.add(host);
    if (!await ldsbLive()) return failed(result.status, "ldsb-session-required");
    if (!hop) return failed(result.status, "durham-hop-required");
    contexts[host] = "federated-content";
    result = await inTab(host, route, args, validateHop(hop));
    const retry = await background(host, route, args);
    if (needsSession(retry) && needsSession(result)) return failed(retry.status, "durham-session-renewal-failed");
    return retry.complete ? retry : result;
  }
  return { request, contexts };
}
