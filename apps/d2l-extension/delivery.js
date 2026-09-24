import { canonical, courseBody, createKey, publicKeyBase64, sign, post, uploadBlock } from "./protocol.js";

export const QUEUE_PER_COURSE = 2;
export const QUEUE_MAX_BYTES = 1024 * 1024;
export const FLUSH_ATTEMPTS = 8;
const queueBytes = (queue) => new TextEncoder().encode(JSON.stringify(queue)).length;

export function delivery({ store, clock, send = post, cryptoImpl = crypto }) {
  let pending = [];
  async function signed(path, body, identity, pair) {
    return send(path, body, await sign(path, body, pair, identity, clock(), cryptoImpl));
  }
  async function pair(deviceLabel) {
    const existing = await store.get("pairing");
    if (existing && (existing.approved || existing.status === "active" || existing.expiresAt > clock())) return status();
    if (typeof deviceLabel !== "string" || !deviceLabel.trim() || deviceLabel.length > 64 || /\p{C}/u.test(deviceLabel)) throw new Error("invalid-device-label");
    const keys = await createKey(cryptoImpl);
    // Persist before any outbound proof. Service-worker termination must never
    // leave an approved public key with its private half lost in memory.
    await store.set("keys", keys);
    const identity = await send("/school/pairing/start", canonical({ publicKeyBase64: await publicKeyBase64(keys, cryptoImpl), deviceLabel }));
    if (!["collectorId", "principalId", "challenge", "code", "expiresAt"].every((key) => typeof identity[key] === "string" && identity[key])) throw new Error("invalid-pairing-response");
    await store.set("pairing", { ...identity, status: "pending", proved: false });
    // A lost proof response is ambiguous: retain the key and code so a later
    // check can retry the single-use proof or observe an already approved key.
    await prove().catch(() => {});
    return status();
  }
  async function prove() {
    const identity = await store.get("pairing");
    if (!identity || identity.proved) return;
    await signed("/school/pairing/prove", canonical({ challenge: identity.challenge }), identity, await store.get("keys"));
    await store.set("pairing", { ...identity, proved: true });
  }
  async function status() {
    const identity = await store.get("pairing");
    if (!identity) return { status: "unpaired" };
    let result;
    try {
      result = await signed("/school/pairing/status", "{}", identity, await store.get("keys"));
      if (!["pending", "active"].includes(result.status)) throw new Error("invalid-pairing-status");
    }
    catch {
      await store.set("pairing", { ...identity, status: "unavailable-or-refused" });
      throw new Error("pairing-unavailable-or-refused");
    }
    await store.set("pairing", { ...identity, status: result.status, approved: identity.approved || result.status === "active" });
    return { status: result.status, code: identity.code, expiresAt: identity.expiresAt };
  }
  async function enqueue(batch) {
    const entry = courseBody(batch);
    entry.error = uploadBlock(JSON.parse(entry.body)) ?? entry.error;
    pending.push({ ...entry, readId: batch.readId, host: batch.host, courseId: batch.course.id });
    return entry;
  }
  async function flush(sendPending = true) {
    const combined = [...(await store.get("queue") ?? []), ...pending];
    const counts = new Map();
    // New reads supersede old reads of the same course, on the same board only.
    // Bound old queues too, so upgrading after an outage cannot preserve growth.
    const queue = combined.toReversed().filter((entry) => {
      const key = JSON.stringify([entry.host, entry.courseId]);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count <= QUEUE_PER_COURSE;
    }).reverse();
    let bytes = queueBytes(queue);
    while (bytes > QUEUE_MAX_BYTES) {
      bytes -= queueBytes(queue.shift()) + (queue.length ? 1 : 0);
    }
    const evicted = combined.length - queue.length;
    const identity = await store.get("pairing");
    let blocked = false;
    let attempts = 0;
    if (sendPending && identity?.status === "active") {
      const keys = await store.get("keys");
      for (const entry of [...queue]) {
        if (uploadBlock(JSON.parse(entry.body))) { blocked = true; continue; }
        if (attempts >= FLUSH_ATTEMPTS) break;
        attempts += 1;
        try {
          // The body stays byte-identical on retry; the signature gets a new nonce.
          const receipt = await signed("/school/observations", entry.body, identity, keys);
          if (!receipt.batchId || !["good", "failed"].includes(receipt.outcome)) throw new Error("invalid-receipt");
        } catch { continue; }
        queue.splice(queue.indexOf(entry), 1);
      }
    }
    // One atomic replacement per run avoids rewriting every preceding course.
    // Keep pending reads until commit succeeds so a failed write can be retried.
    await store.set("queue", queue);
    pending = [];
    return { queued: queue.length, evicted, error: !sendPending ? "read-interrupted" : identity?.status !== "active" ? "pairing-required"
      : blocked ? "receiver-contract-incompatible" : queue.length ? "push-refused-or-unavailable" : null };
  }
  return { pair, prove, status, enqueue, flush };
}
