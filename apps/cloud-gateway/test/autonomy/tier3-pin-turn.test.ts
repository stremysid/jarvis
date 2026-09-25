import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { createOwnerPipelineModels } from "../../src/agent/owner-pipelines.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { D1ToolConfirmationStore } from "../../src/autonomy/tool-confirmations.js";
import {
  CHANNEL_REFUSED,
  ToolAutonomyGate,
  type ToolAutonomyGateContract,
  type ToolChannelAuthorization,
  type ToolChannelAuthorizationRequest,
} from "../../src/autonomy/tool-gate.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentProvider,
  ModelAgentStreamChunk,
  ModelAgentStreamInput,
  ModelAgentStreamProvider,
} from "../../src/providers/provider-types.js";
import { SchoolCollectorPairing } from "../../src/school/collector-pairing.js";
import { Redactor } from "../../src/security/redaction.js";
import { OwnerVoiceAgentAdapter } from "../../src/voice/voice-agent.js";
import { applyAutonomyToolCapabilitiesMigration, applyNewestRuntimeMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const REVOKE = "school_collector_revoke";
let serial = 0;

/** A provider that asks for one tool call, then speaks one sentence. */
class ToolThenStopProvider implements ModelAgentProvider, ModelAgentStreamProvider {
  readonly requests: ModelAgentCompletionInput[] = [];
  readonly #completions: ModelAgentCompletion[];

  constructor(collectorId: string) {
    this.#completions = [
      Object.freeze({
        content: null,
        toolCalls: Object.freeze([{ id: "revoke-1", name: REVOKE, arguments: JSON.stringify({ collectorId }) }]),
        finishReason: "tool_calls" as const,
      }),
      Object.freeze({ content: "Done.", toolCalls: Object.freeze([]), finishReason: "stop" as const }),
    ];
  }

  async completeAgent(): Promise<ModelAgentCompletion> { throw new Error("voice_must_stream"); }

  async *streamAgent(input: ModelAgentStreamInput): AsyncIterable<ModelAgentStreamChunk> {
    this.requests.push(input);
    const completion = this.#completions.shift();
    if (completion === undefined) throw new Error("unexpected_agent_call");
    if (completion.content !== null) yield { type: "text", text: completion.content };
    yield { type: "completed", completion };
  }
}

async function seedPrincipal(principalId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'PIN turn fixture', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
}

interface TurnResult {
  readonly spoken: string;
  readonly error: unknown;
}

/**
 * One owner voice turn that calls the tier-3 `school_collector_revoke`, with a
 * real `AutonomyService` and D1 behind the gate. Only the channel port (the
 * PIN question) and the model are fakes.
 */
async function runTurn(input: {
  readonly channel?: (request: ToolChannelAuthorizationRequest, turn: AbortController) => Promise<ToolChannelAuthorization>;
  readonly autonomy?: (turn: AbortController) => ToolAutonomyGateContract;
  readonly turnTimeoutMs?: number;
}): Promise<TurnResult & { readonly principalId: string }> {
  serial += 1;
  const principalId = `principal:pin-turn-${serial}`;
  await seedPrincipal(principalId);
  const turn = new AbortController();
  const autonomy = input.autonomy?.(turn) ?? new ToolAutonomyGate(
    new AutonomyService({ repository: new AutonomyRepository(env.DB), now: () => new Date(NOW) }),
    new D1ToolConfirmationStore(env.DB, () => new Date(NOW)),
    input.channel === undefined
      ? null
      : { authorizeToolCall: (request) => input.channel!(request, turn) },
  );
  const adapter = new OwnerVoiceAgentAdapter({
    provider: new ToolThenStopProvider(newUlid()),
    database: env.DB,
    archive: env.ARCHIVE,
    ownerPrincipalId: principalId,
    directOwnerText: true,
    targets: { async findControlTargets() { return []; } },
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB) }),
    autonomy,
    now: () => new Date(NOW),
    ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: input.turnTimeoutMs }),
    ...createOwnerPipelineModels(env, { async *stream() {} }, new Redactor(), principalId, true, () => new Date(NOW)),
  });
  const pieces: string[] = [];
  let error: unknown = null;
  try {
    for await (const token of adapter.stream({
      correlationId: newUlid(), principalId, channel: "voice", userText: "Revoke the laptop collector.",
      context: [], contextTokenBudget: 24_000, firstTokenTimeoutMs: 8_000, timeoutMs: 30_000,
      maxOutputCharacters: 4_096, reasoningEffort: "low", signal: turn.signal,
    })) pieces.push(token.text);
  } catch (caught) {
    error = caught;
  }
  return { spoken: pieces.join(""), error, principalId };
}

async function tier3Decisions(principalId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS count FROM decision_items WHERE principal_id = ?")
    .bind(principalId).first<{ count: number }>();
  return row?.count ?? 0;
}

describe("a PIN'd action and the turn that asked for it", () => {
  beforeAll(async () => {
    await applyNewestRuntimeMigration();
    await applyAutonomyToolCapabilitiesMigration();
  }, 120_000);

  afterEach(() => { vi.restoreAllMocks(); });

  it("never runs the action when the turn ends while the PIN question is open, even if the PIN then arrives", async () => {
    const revoke = vi.spyOn(SchoolCollectorPairing.prototype, "revoke");
    // The call hangs up (or the turn is cancelled) mid-question, and a correct
    // PIN is still handed back afterwards: the reviewer's Probe A.
    const result = await runTurn({
      channel: async (_request, turn) => {
        turn.abort();
        return "pin-authorization-after-abort";
      },
    });
    expect(revoke).not.toHaveBeenCalled();
    expect(result.spoken).not.toContain("revoked");
  });

  it("refuses at the tool body when the turn aborts after the gate has already permitted", async () => {
    // The gate itself is bypassed here so this proves the agent core's own
    // re-check, not the gate's: a permit that arrives after the turn ended
    // must still not reach the body.
    const revoke = vi.spyOn(SchoolCollectorPairing.prototype, "revoke");
    const inner = new ToolAutonomyGate(
      new AutonomyService({ repository: new AutonomyRepository(env.DB), now: () => new Date(NOW) }),
    );
    await runTurn({
      autonomy: (turn) => ({
        async evaluateToolCall(request) {
          const decision = await inner.evaluateToolCall({ ...request, toolName: "school_d2l_status" });
          turn.abort();
          return Object.freeze({ ...decision, verdict: "permit" as const });
        },
      }),
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("holds the turn deadline while the PIN question is open, so a slow answer still runs the action", async () => {
    const revoke = vi.spyOn(SchoolCollectorPairing.prototype, "revoke").mockResolvedValue(true);
    // The turn budget is 150 ms and Sid takes 400 ms to answer. Without the
    // hold the turn clock, not the PIN question, would decide.
    const result = await runTurn({
      turnTimeoutMs: 150,
      channel: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return "pin-authorization-slow";
      },
    });
    expect(revoke).toHaveBeenCalledOnce();
    expect(result.spoken).toContain("School collector revoked.");
  });

  it("does not also raise a Telegram confirmation for an action Sid declined at the PIN", async () => {
    const revoke = vi.spyOn(SchoolCollectorPairing.prototype, "revoke");
    const result = await runTurn({ channel: async () => CHANNEL_REFUSED });
    expect(revoke).not.toHaveBeenCalled();
    expect(await tier3Decisions(result.principalId)).toBe(0);
    expect(result.spoken).not.toContain("/queue");
  });

  it("still offers the Telegram route when the call cannot take a PIN at all", async () => {
    const revoke = vi.spyOn(SchoolCollectorPairing.prototype, "revoke");
    const result = await runTurn({ channel: async () => null });
    expect(revoke).not.toHaveBeenCalled();
    expect(await tier3Decisions(result.principalId)).toBe(1);
    expect(result.spoken).toContain("/queue");
  });
});
