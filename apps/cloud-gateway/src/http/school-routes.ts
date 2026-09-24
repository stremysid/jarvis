import type { Env } from "../env.js";
import { SchoolCollectorPairing } from "../school/collector-pairing.js";
import { SchoolCollectorRepository } from "../school/collector-repository.js";
import { exact, parseSchoolBatch, SCHOOL_BODY_LIMIT, verifyCollectorRequest } from "../school/collector-protocol.js";
import { decodeCanonicalRawBody } from "../sync/signed-request.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import { TelegramRestProvider } from "../providers/telegram-provider.js";
import { buildDecisionKeyboard } from "../decisions/telegram-keyboard.js";
import type { DecisionItem } from "../decisions/decision-types.js";

const PATHS = ["/school/pairing/start", "/school/pairing/prove", "/school/pairing/status", "/school/observations"];
export function isSchoolPath(path: string): boolean { return PATHS.includes(path); }

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function boundedBody(request: Request): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > SCHOOL_BODY_LIMIT) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function handleSchoolRequest(request: Request, env: Env, options: {
  now?: () => Date;
  notify?: (decision: DecisionItem) => Promise<void>;
} = {}): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || !isSchoolPath(url.pathname) || url.search !== "") return reply(405, { error: "school_target_refused" });
  const owner = env.OWNER_PRINCIPAL_ID;
  if (!owner) return reply(503, { error: "school_not_configured" });
  const raw = await boundedBody(request);
  if (raw === null) return reply(413, { error: "school_batch_too_large" });
  const now = options.now ?? (() => new Date());
  const pairing = new SchoolCollectorPairing(env.DB, owner, now);
  try {
    if (url.pathname === "/school/pairing/start") {
      const key = await pairing.start(decodeCanonicalRawBody(raw));
      return reply(201, { collectorId: key.collector_id, principalId: key.principal_id, challenge: key.challenge,
        code: key.pairing_code, expiresAt: key.expires_at });
    }
    const header = JSON.parse(request.headers.get("x-jarvis-signed-request") ?? "null") as unknown;
    if (url.pathname === "/school/pairing/status") {
      // A pending key can read only its own pairing state, never school evidence.
      const body = decodeCanonicalRawBody(raw);
      exact(body, []);
      let result;
      try { result = await verifyCollectorRequest(env.DB, owner, header, url.pathname, raw, now(), "pending"); }
      catch { result = await verifyCollectorRequest(env.DB, owner, header, url.pathname, raw, now(), "active"); }
      return reply(200, { status: result.key.status });
    }
    const verified = await verifyCollectorRequest(env.DB, owner, header, url.pathname, raw, now(),
      url.pathname === "/school/pairing/prove" ? "pending" : "active");
    if (url.pathname === "/school/pairing/prove") {
      const decision = await pairing.prove(verified.key, verified.body);
      const notify = options.notify ?? (async (item: DecisionItem) => {
        const chatId = await new DeviceRepository(env.DB).findOwnerTelegramChat(owner);
        if (chatId === null || !env.TELEGRAM_BOT_TOKEN) throw new Error("school_pair_notice_unavailable");
        await new TelegramRestProvider({ botToken: env.TELEGRAM_BOT_TOKEN }).sendMessage({
          chatId, text: item.question, replyMarkup: buildDecisionKeyboard(item), idempotencyKey: item.decisionId,
        });
      });
      await notify(decision);
      await pairing.markDelivered(decision.decisionId);
      return reply(202, { status: "pending", decisionId: decision.decisionId });
    }
    const batch = parseSchoolBatch(verified.body, now());
    return reply(200, await new SchoolCollectorRepository(env.DB, owner, now).ingest(verified.key.collector_id, batch, verified.bodyHash));
  } catch {
    // Neither parser failures nor database errors may echo keys or school content.
    return reply(400, { error: "school_request_refused" });
  }
}
