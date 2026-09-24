export const AUDIENCE = "jarvis-school-collector";
export const GATEWAY = "";
export const PATHS = Object.freeze(["/school/pairing/start", "/school/pairing/prove", "/school/pairing/status", "/school/observations"]);
const encoder = new TextEncoder();
const base64 = (value) => btoa(String.fromCharCode(...new Uint8Array(value)));

// These are the receiver's canonical JSON and structural bounds, not course filters.
export function canonical(value) {
  let items = 0;
  const string = (text) => {
    if (!text.isWellFormed()) throw new Error("invalid-unicode");
    return JSON.stringify(text.normalize("NFC"));
  };
  function visit(node, depth) {
    items += 1;
    if (items > 4096) throw new Error("batch-structure-too-large");
    if (node === null || typeof node === "boolean") return JSON.stringify(node);
    if (typeof node === "string") return string(node);
    if (typeof node === "number" && Number.isFinite(node)) return JSON.stringify(node);
    if (typeof node !== "object" || depth >= 32) throw new Error("invalid-batch-structure");
    if (Array.isArray(node)) return `[${node.map((entry) => visit(entry, depth + 1)).join(",")}]`;
    const keys = Object.keys(node).map((key) => [key.normalize("NFC"), key]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (new Set(keys.map(([key]) => key)).size !== keys.length) throw new Error("duplicate-normalized-key");
    items += keys.length;
    return `{${keys.map(([key, original]) => `${string(key)}:${visit(node[original], depth + 1)}`).join(",")}}`;
  }
  const text = visit(value, 0);
  if (encoder.encode(text).length >= 65536) throw new Error("batch-too-large");
  return text;
}
export async function createKey(cryptoImpl = crypto) {
  return cryptoImpl.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
}
export async function publicKeyBase64(pair, cryptoImpl = crypto) {
  return base64(await cryptoImpl.subtle.exportKey("raw", pair.publicKey));
}
export async function sign(path, body, pair, identity, issuedAt, cryptoImpl = crypto) {
  if (!PATHS.slice(1).includes(path)) throw new Error("invalid-signed-path");
  const bytes = encoder.encode(body);
  const hash = await cryptoImpl.subtle.digest("SHA-256", bytes);
  const envelope = { schemaVersion: "1.0", deviceId: identity.collectorId, principalId: identity.principalId,
    audience: AUDIENCE, issuedAt,
    nonce: base64(cryptoImpl.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
    bodyHash: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  const message = encoder.encode(["POST", path, envelope.deviceId, envelope.principalId, envelope.audience,
    envelope.issuedAt, envelope.nonce, envelope.bodyHash].join("\n"));
  envelope.signatureBase64 = base64(await cryptoImpl.subtle.sign("Ed25519", pair.privateKey, message));
  return envelope;
}
export async function post(path, body, envelope, fetchImpl = globalThis.fetch.bind(globalThis)) {
  if (!PATHS.includes(path)) throw new Error("invalid-gateway-path");
  if (encoder.encode(body).length >= 65536) throw new Error("batch-too-large");
  const response = await fetchImpl(`${GATEWAY}${path}`, {
    method: "POST", credentials: "omit", redirect: "manual", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(envelope ? { "x-jarvis-signed-request": JSON.stringify(envelope) } : {}) },
    body, signal: AbortSignal.timeout(15000),
  });
  if (response.status === 0 || response.redirected || response.status >= 300 && response.status < 400) throw new Error("gateway-redirect-refused");
  if (!response.ok) throw new Error(`gateway-refused-${response.status}`);
  return response.json();
}

export function courseBody(batch) {
  try {
    if (batch.routes.length > 256) throw new Error("batch-route-limit");
    return { body: canonical(batch), error: null };
  } catch {
    // Never truncate to a successful course. A compact failure is accepted by the
    // receiver's evidence model and leaves previous good observations untouched.
    const failure = { ...batch, routes: batch.routes.slice(0, 6).map((route) => ({ ...route,
      status: 0, complete: false, body: { collectorFailure: "batch-exceeds-wire-limits" } })) };
    return { body: canonical(failure), error: "batch-exceeds-wire-limits" };
  }
}
