import { env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";
import { collectorFixture, observedBatch, bytes, readKey } from "./collector-fixtures.js";
import worker, { answerFromTap } from "../../src/index.js";
import { handleSchoolRequest } from "../../src/http/school-routes.js";
import { encodeDecisionCallbackData } from "../../src/decisions/telegram-keyboard.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { SchoolCollectorRepository } from "../../src/school/collector-repository.js";
import type { ModelAgentCompletionInput } from "../../src/providers/provider-types.js";
import type { Env } from "../../src/env.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";
import { assembleDigest } from "../../src/jobs/digest-job.js";
import { D1ToolConfirmationStore, TIER3_TOOL_ORIGIN, TIER3_CONFIRM_OPTION } from "../../src/autonomy/tool-confirmations.js";
import { ToolAutonomyGate } from "../../src/autonomy/tool-gate.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";

beforeAll(applyNewestRuntimeMigration);

it("receives a signed course batch through the production worker router", async () => {
  const f = await collectorFixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(f.clock());
  try {
    const response = await worker.fetch(await f.request("/school/observations", observedBatch(f)) as Request<unknown, IncomingRequestCfProperties>, { ...env, OWNER_PRINCIPAL_ID: f.owner } as Env,
      { waitUntil() {} } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "good" });
  } finally { vi.useRealTimers(); }
});

it("delivers the proved pairing decision and activates it through the real Telegram tap handler", async () => {
  const f = await collectorFixture(false);
  const messages: string[] = [];
  const response = await handleSchoolRequest(await f.request("/school/pairing/prove", { challenge: f.key.challenge }),
    { ...env, OWNER_PRINCIPAL_ID: f.owner } as Env, { now: f.clock, notify: async (decision) => { messages.push(decision.question); } });
  expect(response.status).toBe(202);
  const body = await response.json() as { decisionId: string };
  expect(messages[0]).toContain(f.key.pairing_code);
  expect((await readKey(f.key.collector_id)).status).toBe("pending");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(f.clock());
  try {
    await answerFromTap({ ...env, OWNER_PRINCIPAL_ID: f.owner } as Env, {
      eventId: newUlid(), principalId: f.owner, telegramUserId: f.telegramUser, chatId: "synthetic-chat", callbackQueryId: "synthetic-callback",
      messageId: 1, data: encodeDecisionCallbackData(body.decisionId, "confirm"),
    }, async (_chat, text) => { messages.push(text); });
  } finally { vi.useRealTimers(); }
  expect((await readKey(f.key.collector_id)).status).toBe("active");
  expect(messages.at(-1)).toBe("School collector activated.");
  expect((await f.dispatch(await f.request("/school/pairing/status", {}))).status).toBe(200);
});

it("does not advertise activation when delivery fails", async () => {
  const f = await collectorFixture(false);
  const request = await f.request("/school/pairing/prove", { challenge: f.key.challenge });
  const response = await handleSchoolRequest(request, { ...env, OWNER_PRINCIPAL_ID: f.owner } as Env,
    { now: f.clock, notify: async () => { throw new Error("synthetic delivery failure"); } });
  expect(response.status).toBe(400);
  expect((await readKey(f.key.collector_id)).status).toBe("pending");
  const key = await readKey(f.key.collector_id);
  expect(await env.DB.prepare("SELECT status FROM decision_items WHERE decision_id = ?").bind(key.decision_id).first()).toEqual({ status: "open" });
  expect((await handleSchoolRequest(await f.request("/school/observations", observedBatch(f)), { ...env, OWNER_PRINCIPAL_ID: "" } as Env)).status).toBe(503);
});

it("hands the model D2L evidence through the real tool dispatcher without an action receipt", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  await new SchoolCollectorRepository(env.DB, f.owner, f.clock).ingest(f.key.collector_id, batch, await sha256Hex(bytes(batch)));
  const requests: ModelAgentCompletionInput[] = [];
  const adapter = new OwnerTelegramAgentAdapter({ database: env.DB, archive: env.ARCHIVE,
    provider: { async completeAgent(input) {
      requests.push(input);
      return requests.length === 1
        ? { content: null, toolCalls: [{ id: "school-status", name: "school_d2l_status", arguments: JSON.stringify({ cursor: "", limit: 10, staleAfterMs: 43_200_000 }) }], finishReason: "tool_calls" }
        : { content: JSON.stringify({ reply: "There is undated practice in the evidence.", claimedActions: [] }), toolCalls: [], finishReason: "stop" };
    } }, ownerPrincipalId: f.owner, directOwnerText: true, directPipelineText: true, authorityText: "Read my school evidence",
    targets: { async findControlTargets() { return []; } }, decisions: f.decisions, autonomy: await testToolGate(env.DB),
    schoolModel: { async *stream() { throw new Error("unexpected pipeline"); } }, universityModel: { async *stream() {} }, studyCoachModel: { async *stream() {} }, now: f.clock,
  });
  let reply = "";
  for await (const token of adapter.stream({ correlationId: newUlid(), principalId: f.owner, channel: "telegram", userText: "Read my school evidence", context: [],
    reasoningEffort: "none", firstTokenTimeoutMs: 8_000, timeoutMs: 30_000, contextTokenBudget: 16_000, maxOutputCharacters: 8_000, signal: new AbortController().signal })) reply += token.text;
  expect(requests.length).toBe(2);
  expect(JSON.stringify(requests[0]!.tools)).toContain("school_d2l_status");
  expect(JSON.stringify(requests[1])).toContain("Undated practice");
  expect(JSON.stringify(requests[1])).toContain("lastGoodReadAt");
  expect(reply).toContain("undated practice");
  expect(reply).not.toContain("Saved");
});

it("keeps an unavailable collector status visible in the digest", async () => {
  const f = await collectorFixture();
  const digest = await assembleDigest("daily", { clock: { now: f.clock }, timeZone: "America/Toronto", delivery: { send: async () => undefined }, sources: {
    readCatchupActions: async () => [], readApplicationItems: async () => [], readDeadlines: async () => [], readDeadlineSources: async () => [],
    readProjectStatuses: async () => [], readOpenDecisions: async () => [], readD2lStatus: async () => { throw new Error("synthetic unavailable"); },
  } });
  expect(digest.text).toContain("collector status unavailable");
  expect(digest.text.toLowerCase()).not.toContain("nothing due");
});

it("revokes through the owner tool only after its tier-three confirmation tap", async () => {
  const f = await collectorFixture();
  const autonomy = new ToolAutonomyGate(new AutonomyService({ repository: new AutonomyRepository(env.DB), now: f.clock }), new D1ToolConfirmationStore(env.DB));
  const run = async () => {
    const requests: ModelAgentCompletionInput[] = [];
    const adapter = new OwnerTelegramAgentAdapter({ database: env.DB, archive: env.ARCHIVE,
      provider: { async completeAgent(input) {
        requests.push(input);
        return requests.length === 1
          ? { content: null, toolCalls: [{ id: "revoke-school", name: "school_collector_revoke", arguments: JSON.stringify({ collectorId: f.key.collector_id }) }], finishReason: "tool_calls" }
          : { content: JSON.stringify({ reply: "I checked the collector.", claimedActions: [] }), toolCalls: [], finishReason: "stop" };
      } }, ownerPrincipalId: f.owner, directOwnerText: true, directPipelineText: true, authorityText: "Revoke my school collector",
      targets: { async findControlTargets() { return []; } }, decisions: f.decisions, autonomy,
      schoolModel: { async *stream() {} }, universityModel: { async *stream() {} }, studyCoachModel: { async *stream() {} }, now: f.clock,
    });
    for await (const _token of adapter.stream({ correlationId: newUlid(), principalId: f.owner, channel: "telegram", userText: "Revoke my school collector", context: [],
      reasoningEffort: "none", firstTokenTimeoutMs: 8_000, timeoutMs: 30_000, contextTokenBudget: 16_000, maxOutputCharacters: 8_000, signal: new AbortController().signal })) {}
    return requests;
  };
  const pending = await run();
  expect((await readKey(f.key.collector_id)).status).toBe("active");
  expect(JSON.stringify(pending[1])).toContain("pending_confirmation");
  const decision = await env.DB.prepare("SELECT decision_id FROM decision_items WHERE principal_id = ? AND origin = ?")
    .bind(f.owner, TIER3_TOOL_ORIGIN).first<{ decision_id: string }>();
  expect(decision).not.toBeNull();
  await f.decisions.markDelivered(decision!.decision_id);
  await f.decisions.answer({ decisionId: decision!.decision_id, answeredByIdentityId: f.identity, optionKey: TIER3_CONFIRM_OPTION });
  const confirmed = await run();
  expect(JSON.stringify(confirmed[1])).toContain("School collector revoked.");
  expect((await readKey(f.key.collector_id)).status).toBe("revoked");
});
