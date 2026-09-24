import { env } from "cloudflare:test";
import { canonicalize, newUlid, sha256Hex, type JsonValue, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { SchoolCollectorPairing } from "../../src/school/collector-pairing.js";
import { SCHOOL_AUDIENCE, type CollectorKey, type SchoolBatch } from "../../src/school/collector-protocol.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import { encodeBase64Url, signatureText } from "../../src/sync/signed-request.js";
import { handleSchoolRequest } from "../../src/http/school-routes.js";
import type { Env } from "../../src/env.js";

let sequence = 0;
export const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
export const bytes = (value: unknown): Uint8Array => canonicalize(value as JsonValue);

export async function collectorFixture(active = true) {
  const suffix = ++sequence;
  let now = new Date(Date.UTC(2026, 8, 23, 12 + suffix));
  const owner = `principal:collector-${suffix}`;
  const identity = `identity:collector-${suffix}`;
  const telegramUser = String(990_000_000 + suffix);
  await env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
    VALUES (?, 'human', 'active', 'Synthetic owner', ?, ?)`).bind(owner, now.toISOString(), now.toISOString()).run();
  await env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
    VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`).bind(identity, owner, telegramUser, now.toISOString(), now.toISOString()).run();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKeyBase64 = base64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer));
  const clock = () => new Date(now);
  const pairing = new SchoolCollectorPairing(env.DB, owner, clock);
  const key = await pairing.start({ publicKeyBase64, deviceLabel: "Synthetic laptop" });
  const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now: clock });
  const activate = async (candidate = key, option = "confirm") => {
    const decision = await pairing.prove(candidate, { challenge: candidate.challenge });
    await decisions.markDelivered(decision.decisionId);
    await decisions.answer({ decisionId: decision.decisionId, answeredByIdentityId: identity, optionKey: option });
    return { decision, activated: await pairing.activateFromDecision(decision.decisionId, identity) };
  };
  if (active) await activate();
  const sign = async (path: string, raw: Uint8Array, overrides: Partial<SignedRequestV1> = {}) => {
    const unsigned = { schemaVersion: "1.0" as const, deviceId: key.collector_id, principalId: owner, audience: SCHOOL_AUDIENCE,
      issuedAt: now.toISOString(), nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))), bodyHash: await sha256Hex(raw), signatureBase64: "", ...overrides };
    return { ...unsigned, signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, signatureText(unsigned, "POST", path)))) };
  };
  const request = async (path: string, body: unknown, overrides: Partial<SignedRequestV1> = {}) => {
    const raw = bytes(body);
    return new Request(`https://jarvis.example${path}`, { method: "POST", body: raw,
      headers: { "x-jarvis-signed-request": JSON.stringify(await sign(path, raw, overrides)) } });
  };
  const dispatch = (request: Request) => handleSchoolRequest(request, { ...env, OWNER_PRINCIPAL_ID: owner } as Env, { now: clock, notify: async () => undefined });
  return { owner, identity, telegramUser, key, pairing, decisions, clock, sign, request, dispatch, activate, publicKeyBase64,
    setNow: (value: Date) => { now = value; }, courseId: `course-${suffix}` };
}

export type CollectorFixture = Awaited<ReturnType<typeof collectorFixture>>;

/** Synthetic values, field shapes from PR 161 sections 2.2, 2.5, 2.6, 2.7. No school payload was copied. */
export function observedBatch(f: CollectorFixture, courseId = f.courseId): SchoolBatch {
  const prefix = `/d2l/api/le/1.82/${courseId}/`;
  const at = f.clock().toISOString();
  return { schemaVersion: "1.0", host: "ldsb.elearningontario.ca", readId: newUlid(f.clock()), startedAt: at,
    courseIds: [courseId], enrollmentComplete: true, course: { id: courseId, name: "Synthetic course" }, routes: [
      { route: prefix + "dropbox/folders/", status: 200, fetchedAt: at, complete: true, body: [
        { Id: 17, Name: "Synthetic essay", DueDate: null, TotalUsersWithSubmissions: -1, GradeItemId: 9, ActivityId: "synthetic-17", CustomInstructions: { Text: "Read the fictional passage", Html: "" } },
        { Id: 18, Name: "Undated practice", DueDate: null, TotalUsersWithSubmissions: -1 },
      ] },
      { route: prefix + "content/toc", status: 200, fetchedAt: at, complete: true, body: {
        Modules: [{ ModuleId: 31, Title: "Synthetic module", StartDateTime: "2026-09-01T00:00:00Z", EndDateTime: "2026-09-24T03:59:00Z", Modules: [],
          Topics: [{ TopicId: 41, Title: "Synthetic essay", ToolItemId: 17, ActivityId: "synthetic-17", Url: "/untrusted", TypeIdentifier: "Dropbox", CompletionType: 1 }] }],
      } },
      { route: prefix + "grades/values/myGradeValues/", status: 200, fetchedAt: at, complete: true, body: [] },
      { route: prefix + "dropbox/folders/17/submissions/mysubmissions/", status: 200, fetchedAt: at, complete: true, body: [] },
      { route: prefix + "dropbox/folders/18/submissions/mysubmissions/", status: 200, fetchedAt: at, complete: true, body: [] },
    ] };
}

export async function readKey(collectorId: string): Promise<CollectorKey> {
  return (await env.DB.prepare("SELECT * FROM school_collector_keys WHERE collector_id = ?").bind(collectorId).first<CollectorKey>())!;
}
