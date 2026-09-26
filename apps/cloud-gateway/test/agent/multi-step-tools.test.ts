/**
 * Jarvis may use several tools in one turn, on calls and on Telegram alike.
 *
 * The model calls tools, sees every result and decides the next step until it
 * answers. What bounds a turn is its deadline and a runaway cap; what guards an
 * action is the same tier gate every single call goes through. These tests
 * drive the real owner agents (real D1, real tier gate) with a scripted model.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newUlid, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { MAX_TOOL_ROUNDS } from "../../src/agent/owner-agent-core.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { D1ToolConfirmationStore } from "../../src/autonomy/tool-confirmations.js";
import {
  ToolAutonomyGate,
  type ToolAutonomyGateContract,
  type ToolChannelAuthorizationRequest,
} from "../../src/autonomy/tool-gate.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import { EmailInbox, storeInboundEmail } from "../../src/email/email-inbox.js";
import type { ModelAdapter, ModelAdapterStreamInput } from "../../src/model/model-types.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentProvider,
  ModelAgentStreamChunk,
  ModelAgentStreamInput,
  ModelAgentStreamProvider,
  ModelFunctionCall,
} from "../../src/providers/provider-types.js";
import { SchoolCollectorPairing } from "../../src/school/collector-pairing.js";
import { ProjectRepository } from "../../src/projects/project-repository.js";
import { assertAgentToolHistory } from "../../src/providers/deepseek-provider.js";
import { OwnerVoiceAgentAdapter } from "../../src/voice/voice-agent.js";
import { argumentTurn } from "../channels/argument-tool-fixture.js";
import { voiceArgumentTurn } from "../channels/voice-argument-fixture.js";
import { resetDeadlineTables } from "../deadlines/deadline-fixture.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";
import { applyAutonomyToolCapabilitiesMigration, applyNewestRuntimeMigration } from "../persistence/migration.js";

type Channel = "telegram" | "voice";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const REVOKE = "school_collector_revoke";
const encoder = new TextEncoder();
let serial = 0;

const FALLBACK: ModelAdapter = {
  async *stream() { yield Object.freeze({ index: 0, text: "No saved action." }); },
};

function call(id: string, name: string, args: Record<string, unknown> = {}): ModelFunctionCall {
  return Object.freeze({ id, name, arguments: JSON.stringify(args) });
}

function tools(...calls: ModelFunctionCall[]): ModelAgentCompletion {
  return Object.freeze({ content: null, toolCalls: Object.freeze(calls), finishReason: "tool_calls" as const });
}

/** A final answer in the shape each channel's prompt asks for. */
function answer(channel: Channel, text: string): ModelAgentCompletion {
  return Object.freeze({
    content: channel === "telegram" ? JSON.stringify({ reply: text, claimedActions: [] }) : text,
    toolCalls: Object.freeze([]),
    finishReason: "stop" as const,
  });
}

/**
 * The model, as a script: each request gets the next completion. Telegram asks
 * with `completeAgent`, a call streams with `streamAgent`; both record requests.
 */
class ScriptedModel implements ModelAgentProvider, ModelAgentStreamProvider {
  readonly requests: ModelAgentCompletionInput[] = [];

  constructor(private readonly next: (index: number) => ModelAgentCompletion) {}

  async completeAgent(input: ModelAgentCompletionInput): Promise<ModelAgentCompletion> {
    // Every request is checked the way the real provider checks it, so each
    // chain test proves its history would be accepted on the wire.
    assertAgentToolHistory(input);
    this.requests.push(input);
    return this.next(this.requests.length - 1);
  }

  async *streamAgent(input: ModelAgentStreamInput): AsyncIterable<ModelAgentStreamChunk> {
    assertAgentToolHistory(input);
    this.requests.push(input);
    const completion = this.next(this.requests.length - 1);
    if (completion.content !== null) yield { type: "text", text: completion.content };
    yield { type: "completed", completion };
  }
}

function scripted(completions: readonly ModelAgentCompletion[]): ScriptedModel {
  return new ScriptedModel((index) => {
    const completion = completions[index];
    if (completion === undefined) throw new Error("unexpected_agent_call");
    return completion;
  });
}

async function seedPrincipal(): Promise<string> {
  const principalId = `principal:multi-step-${++serial}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Multi-step fixture', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  return principalId;
}

function realGate(channel?: (request: ToolChannelAuthorizationRequest) => Promise<string | null>): ToolAutonomyGate {
  return new ToolAutonomyGate(
    new AutonomyService({ repository: new AutonomyRepository(env.DB), now: () => new Date(NOW) }),
    new D1ToolConfirmationStore(env.DB, () => new Date(NOW)),
    channel === undefined ? null : { authorizeToolCall: channel },
  );
}

interface TurnOptions {
  readonly autonomy?: (turn: AbortController) => ToolAutonomyGateContract;
  readonly turnTimeoutMs?: number;
  readonly userText?: string;
}

/** One owner turn through the real channel adapter; what Sid would read or hear. */
async function runTurn(channel: Channel, model: ScriptedModel, options: TurnOptions = {}) {
  const principalId = await seedPrincipal();
  const turn = new AbortController();
  const userText = options.userText ?? "Check my inbox and my collectors, then sort it out.";
  const shared = {
    provider: model,
    database: env.DB,
    archive: env.ARCHIVE,
    ownerPrincipalId: principalId,
    directOwnerText: true,
    targets: { async findControlTargets() { return Object.freeze([]); } },
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => new Date(NOW) }),
    autonomy: options.autonomy?.(turn) ?? await testToolGate(env.DB),
    schoolModel: FALLBACK,
    universityModel: FALLBACK,
    studyCoachModel: FALLBACK,
    turnTimeoutMs: options.turnTimeoutMs ?? 20_000,
    now: () => new Date(NOW),
  };
  const adapter = channel === "telegram"
    ? new OwnerTelegramAgentAdapter({ ...shared, authorityText: userText })
    : new OwnerVoiceAgentAdapter(shared);
  const input: ModelAdapterStreamInput = {
    correlationId: newUlid(), principalId, channel, userText, context: [], reasoningEffort: "low",
    contextTokenBudget: 24_000, firstTokenTimeoutMs: 8_000, timeoutMs: 30_000, maxOutputCharacters: 4_096,
    signal: turn.signal,
  };
  const pieces: string[] = [];
  let error: unknown = null;
  try {
    for await (const token of adapter.stream(input)) pieces.push(token.text);
  } catch (caught) {
    error = caught;
  }
  return { text: pieces.join(""), error, principalId };
}

function resultStatus(content: string): string {
  return (JSON.parse(content) as { status: string }).status;
}

async function decisionCount(principalId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS count FROM decision_items WHERE principal_id = ?")
    .bind(principalId).first<{ count: number }>();
  return row?.count ?? 0;
}

/** A delivered message, as the Email Worker hands it over. */
function inboundMessage(raw: string): ForwardableEmailMessage {
  const headers = new Headers();
  for (const line of raw.split(/\r?\n\r?\n/u)[0]!.split(/\r?\n/u)) {
    const index = line.indexOf(":");
    if (index > 0) headers.append(line.slice(0, index), line.slice(index + 1).trim());
  }
  const bytes = encoder.encode(raw);
  return {
    from: "forwarder@example.test", to: "school@onesid.ca", headers, rawSize: bytes.byteLength,
    raw: new Blob([bytes]).stream(), setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

async function seedEmail(ownerPrincipalId: string, body: string): Promise<string> {
  const subject = `Lab-${newUlid()}`;
  const raw = `From: Teacher <teacher@example.test>\r\nTo: school@onesid.ca\r\nSubject: ${subject}\r\n`
    + `Date: Thu, 24 Sep 2026 04:00:00 +0000\r\nMessage-ID: <${subject}@example.test>\r\n`
    + `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  const stored = await storeInboundEmail(inboundMessage(raw), {
    ...env, OWNER_PRINCIPAL_ID: ownerPrincipalId,
  } as typeof env & { OWNER_PRINCIPAL_ID: string }, () => NOW);
  return stored.emailId;
}

beforeAll(async () => {
  await applyNewestRuntimeMigration();
  await applyAutonomyToolCapabilitiesMigration();
  // Since 0051 only Sid's five actions are tier 3, and none of them has a tool
  // the agent dispatches yet. This file proves a tier-3 action inside a chain is
  // gated exactly as a lone one is, so it promotes the collector revoke to tier
  // 3. Its production tier is pinned in five-confirmed-actions.test.ts.
  await env.DB.prepare("UPDATE capability_tiers SET tier = 3 WHERE capability = 'school.collector.revoke'").run();
}, 120_000);

afterEach(() => { vi.restoreAllMocks(); });

describe.each<Channel>(["telegram", "voice"])("the owner tool loop on %s", (channel) => {
  it("runs every call the model makes in one step and hands all their results back together", async () => {
    const model = scripted([
      tools(call("inbox", "email_inbox_list"), call("status", "school_d2l_status", {
        cursor: "", limit: 10, staleAfterMs: 60_000,
      })),
      answer(channel, "Nothing new."),
    ]);
    const turn = await runTurn(channel, model);
    expect(turn.error).toBeNull();
    expect(model.requests).toHaveLength(2);
    const results = model.requests[1]!.toolResults ?? [];
    expect(results.map((result) => result.name)).toEqual(["email_inbox_list", "school_d2l_status"]);
    expect(results.map((result) => resultStatus(result.content))).toEqual(["completed", "completed"]);
    // Tools stay on after a result, so the model could have taken another step.
    expect(model.requests[1]!.toolChoice).toBe("auto");
  });

  it("hands the model project facts with no receipt and no stalled verdict", async () => {
    const repository = new ProjectRepository(env.DB);
    const projectId = `project:${newUlid()}`;
    await repository.trackProject({
      projectId, owner: "sid", repository: projectId, displayName: "Jarvis",
      staleAfterDays: 7, createdAt: NOW.toISOString(),
    });
    await repository.recordObservation({
      observationId: newUlid(), projectId, observedAt: NOW.toISOString(),
      headSha: "b".repeat(40), lastCommitAt: "2026-08-01T12:00:00.000Z",
      documents: [{
        documentId: newUlid(), path: "NEXT_STEPS.md",
        contentHash: "c".repeat(64) as Sha256Hex,
        excerpt: "Ship the pricing report by 2026-09-05",
      }],
    });
    const model = scripted([
      tools(call("facts", "project_facts")),
      answer(channel, "Here are the facts."),
    ]);

    const turn = await runTurn(channel, model);

    expect(turn.error).toBeNull();
    expect(model.requests[0]!.tools.find((tool) => tool.name === "project_facts")?.description)
      .toContain("You decide whether a project needs Sid");
    const result = JSON.parse(model.requests[1]!.toolResults?.[0]?.content ?? "{}") as {
      status: string; receiptId: string | null; receipt: string;
    };
    expect(result.status).toBe("completed");
    // Evidence for the reply, not an action: no receipt id to prove a claim with.
    expect(result.receiptId).toBeNull();
    expect(result.receipt).toContain('"nextStepsDates":["2026-09-05"]');
    expect(result.receipt).toContain("daysSinceLastCommit");
    // The facts carry no verdict; that judgment is the model's.
    expect(result.receipt).not.toContain("stalled");
    expect(result.receipt).not.toContain("escalate");
  });

  it("refuses a call id reused from an earlier step and still answers", async () => {
    // The real provider rejects a history whose call id was already used, so a
    // refusal that replayed the reused id would kill the follow-up request and
    // the turn would end on a fallback instead of telling the model.
    const model = scripted([
      tools(call("reused", "email_inbox_list")),
      tools(call("reused", "email_inbox_list")),
      answer(channel, "Recovered."),
    ]);
    const turn = await runTurn(channel, model);
    expect(turn.error).toBeNull();
    expect(model.requests).toHaveLength(3);
    const refusal = model.requests[2]!.toolResults![0]!;
    expect(resultStatus(refusal.content)).toBe("refused");
    expect(JSON.parse(refusal.content).receipt).toContain("malformed");
    // The refusal carries a fresh id, so the provider accepts this history.
    expect(model.requests[2]!.previousToolCalls![0]!.id).not.toBe("reused");
    expect(() => assertAgentToolHistory(model.requests[2]!)).not.toThrow();
    expect(turn.text).toContain("Recovered.");
  });

  it("refuses a declaration past the store's bound and tells the model", async () => {
    // Code records what the model declares; it must not trim the list to fit.
    // Nine ids is past the store's bound of eight, so the whole declaration is
    // refused back to the model with the bound named.
    const model = scripted([
      tools(call("declare-too-many", "declare_memory_references", {
        itemIds: Array.from({ length: 9 }, () => newUlid()),
      })),
      answer(channel, "Trying again."),
    ]);
    const turn = await runTurn(channel, model);
    expect(turn.error).toBeNull();
    const refusal = model.requests[1]!.toolResults![0]!;
    expect(resultStatus(refusal.content)).toBe("refused");
    expect(JSON.parse(refusal.content).receipt).toContain("one to 8");
    expect(turn.text).toContain("Trying again.");
  });

  it("refuses a declared memory id the turn never showed the model", async () => {
    const model = scripted([
      tools(call("declare-unseen", "declare_memory_references", { itemIds: [newUlid()] })),
      answer(channel, "Nothing to name."),
    ]);
    const turn = await runTurn(channel, model);
    expect(turn.error).toBeNull();
    const refusal = model.requests[1]!.toolResults![0]!;
    expect(resultStatus(refusal.content)).toBe("refused");
    expect(JSON.parse(refusal.content).receipt).toContain("not shown to you this turn");
    expect(turn.text).toContain("Nothing to name.");
  });

  it("asks for a tier-3 action inside a chain exactly as it would on its own", async () => {
    const revoke = vi.spyOn(SchoolCollectorPairing.prototype, "revoke").mockResolvedValue(true);
    const asked: string[] = [];
    const model = scripted([
      tools(call("inbox", "email_inbox_list")),
      tools(call("revoke", REVOKE, { collectorId: newUlid() })),
      answer(channel, "Handled."),
    ]);
    // A call has a PIN surface; Telegram has none here, so it raises a tap.
    const turn = await runTurn(channel, model, {
      autonomy: () => realGate(channel === "voice"
        ? async (request) => { asked.push(request.toolName); return "pin-authorization"; }
        : undefined),
    });
    expect(turn.error).toBeNull();
    expect(model.requests).toHaveLength(3);
    const revokeResult = model.requests[2]!.toolResults![0]!;
    expect(revokeResult.name).toBe(REVOKE);
    if (channel === "voice") {
      expect(asked).toEqual([REVOKE]);
      expect(revoke).toHaveBeenCalledOnce();
      expect(resultStatus(revokeResult.content)).toBe("completed");
      expect(turn.text).toContain("School collector revoked.");
    } else {
      expect(revoke).not.toHaveBeenCalled();
      expect(resultStatus(revokeResult.content)).toBe("pending_confirmation");
      expect(await decisionCount(turn.principalId)).toBe(1);
    }
  });

  it("stops the loop when the turn ends mid-step and never asks the gate about a later call", async () => {
    const revoke = vi.spyOn(SchoolCollectorPairing.prototype, "revoke").mockResolvedValue(true);
    const gated: string[] = [];
    const model = scripted([
      tools(call("inbox", "email_inbox_list"), call("revoke", REVOKE, { collectorId: newUlid() })),
      answer(channel, "Late answer."),
    ]);
    // Sid hangs up, barges in or cancels while the first call is in the gate.
    const turn = await runTurn(channel, model, {
      autonomy: (controller) => {
        const inner = realGate(async () => "pin-authorization");
        return {
          async evaluateToolCall(request) {
            gated.push(request.toolName);
            const decision = await inner.evaluateToolCall(request);
            controller.abort();
            return decision;
          },
        };
      },
    });
    expect(gated).toEqual(["email_inbox_list"]);
    expect(revoke).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
    expect(turn.text).not.toContain("revoked");
  });

  it("stops at the turn deadline instead of taking another step", async () => {
    const revoke = vi.spyOn(SchoolCollectorPairing.prototype, "revoke").mockResolvedValue(true);
    const model = scripted([
      tools(call("inbox", "email_inbox_list")),
      tools(call("revoke", REVOKE, { collectorId: newUlid() })),
      answer(channel, "Late answer."),
    ]);
    // The first step outlives the 100 ms turn budget.
    const turn = await runTurn(channel, model, {
      turnTimeoutMs: 100,
      autonomy: () => {
        const inner = realGate(async () => "pin-authorization");
        return {
          async evaluateToolCall(request) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            return inner.evaluateToolCall(request);
          },
        };
      },
    });
    expect(model.requests).toHaveLength(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(turn.text).toContain(channel === "telegram" ? "before the deadline" : "I couldn't finish that reply.");
  });

  it("makes the model answer once the runaway cap is reached, and runs no tool past it", async () => {
    const listed = vi.spyOn(EmailInbox.prototype, "list");
    // A model that never stops asking for tools. It gives up after far more
    // steps than the cap, so a loop with no cap fails the count, not a timeout.
    const model = new ScriptedModel((index) => index < MAX_TOOL_ROUNDS * 3
      ? tools(call(`loop-${index}`, "email_inbox_list"))
      : answer(channel, "Finally."));
    const turn = await runTurn(channel, model);
    expect(model.requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(model.requests.slice(0, -1).every((request) => request.toolChoice === "auto")).toBe(true);
    expect(model.requests.at(-1)!.toolChoice).toBe("none");
    expect(model.requests.at(-1)!.earlierToolRounds).toHaveLength(MAX_TOOL_ROUNDS - 1);
    // The provider ignored "none" and asked again; that request is refused, not run.
    expect(turn.text).toContain(channel === "telegram"
      ? "I couldn't safely finish that reply."
      : "I couldn't finish that reply.");
    expect(listed).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
  }, 30_000);
});

describe("a search, read and record chain in one turn", () => {
  beforeEach(resetDeadlineTables);

  const deadline = {
    course: "Chemistry", title: "Lab report", dueAt: "2026-09-25T15:30:00-04:00",
  };

  /** Search history, read the email it points at, record the deadline, then answer. */
  function chain(channel: Channel) {
    let emailId = "";
    return async (input: ModelAgentCompletionInput, index: number): Promise<ModelAgentCompletion> => {
      if (index === 0) {
        emailId = await seedEmail(input.principalId, "CHAIN-BODY-7731: the lab report is due Friday at 3:30 pm.");
        return tools(call("step-search", "history_search", { query: "chemistry lab report" }));
      }
      if (index === 1) return tools(call("step-read", "email_inbox_read", { email_id: emailId }));
      if (index === 2) return tools(call("step-record", "deadline_record", deadline));
      const sentence = "I recorded that deadline.";
      return channel === "telegram"
        ? Object.freeze({
          content: JSON.stringify({ reply: sentence, claimedActions: [{ sentence, receiptIds: ["receipt:step-record"] }] }),
          toolCalls: Object.freeze([]), finishReason: "stop" as const,
        })
        : answer(channel, `[[claim ${JSON.stringify({ toolName: "deadline_record", receiptIds: ["receipt:step-record"] })}]]${sentence}[[/claim]]`);
    };
  }

  it.each<Channel>(["telegram", "voice"])("runs all three steps on %s, each step seeing every earlier result", async (channel) => {
    const text = "Find what my chem teacher said about the lab report and put the deadline in.";
    const turn = channel === "telegram"
      ? await argumentTurn(text, call("unused", "deadline_record"), { script: chain(channel) })
      : await voiceArgumentTurn(text, call("unused", "deadline_record"), { script: chain(channel) });
    const requests = turn.requests;
    expect(requests).toHaveLength(4);
    expect(requests[1]!.toolResults!.map((result) => result.name)).toEqual(["history_search"]);
    // The read step sees the search; the answer step sees search and read too.
    expect(requests[2]!.earlierToolRounds!.map((round) => round.calls[0]!.name)).toEqual(["history_search"]);
    expect(requests[2]!.toolResults![0]!.content).toContain("CHAIN-BODY-7731");
    expect(requests[3]!.earlierToolRounds!.map((round) => round.calls[0]!.name))
      .toEqual(["history_search", "email_inbox_read"]);
    expect(resultStatus(requests[3]!.toolResults![0]!.content)).toBe("completed");
    const rows = await env.DB.prepare("SELECT course, title, due_at FROM deadlines").all();
    expect(rows.results).toEqual([{ course: "Chemistry", title: "Lab report", due_at: "2026-09-25T19:30:00.000Z" }]);
    const delivered = "replies" in turn ? turn.replies.join(" ") : turn.spoken;
    expect(delivered).toContain('Created "Chemistry": "Lab report"');
    expect(delivered).toContain("I recorded that deadline.");
  });
});
