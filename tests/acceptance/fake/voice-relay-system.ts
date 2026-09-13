import { env, runInDurableObject } from "cloudflare:test";
import type { Ulid } from "../../../packages/contracts/src/index.js";
import { D1ContextRetriever } from "../../../apps/cloud-gateway/src/conversation/context-retriever.js";
import { ConversationRepository } from "../../../apps/cloud-gateway/src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../../apps/cloud-gateway/src/conversation/conversation-service.js";
import { DefaultModelAdapter } from "../../../apps/cloud-gateway/src/model/model-adapter.js";
import type { CallRepository } from "../../../apps/cloud-gateway/src/persistence/call-repository.js";
import { EventRepository } from "../../../apps/cloud-gateway/src/persistence/event-repository.js";
import { VoiceAccessRepository } from "../../../apps/cloud-gateway/src/persistence/voice-access-repository.js";
import { FakeModelProvider, type FakeModelProviderOptions } from "../../../apps/cloud-gateway/src/providers/fake-model-provider.js";
import { Redactor } from "../../../apps/cloud-gateway/src/security/redaction.js";
import {
  CallSession,
  CallSessionCore,
  type CallSessionInitialization,
  type CallSessionTermination,
  type CallSessionTerminationResult,
  type CallSessionTerminalPhase,
} from "../../../apps/cloud-gateway/src/voice/call-session-do.js";
import { CapabilityRegistry } from "../../../apps/cloud-gateway/src/voice/capability-registry.js";
import { DurableObjectCallSessionTerminator } from "../../../apps/cloud-gateway/src/voice/call-session-terminator.js";
import { VoiceAccessAuthorityService } from "../../../apps/cloud-gateway/src/voice/voice-access-authority.js";

export const FAKE_ACCOUNT_SID = `AC${"6".repeat(32)}`;
export const FAKE_PROVIDER_SESSION_ID = `VX${"5".repeat(32)}`;

export interface RelayTextFrame {
  readonly type: "text";
  readonly token: string;
  readonly last: boolean;
}

export interface FakeRelayCall {
  readonly sessionId: Ulid;
  readonly callSid: string;
  readonly upgradeStatus: number;
  setup(): Promise<void>;
  prompt(text: string): Promise<void>;
  interrupt(): Promise<void>;
  sendFrame(frame: string | ArrayBuffer): Promise<void>;
  modelRequests(): Promise<readonly { principalId: string; userText: string; context: readonly { text: string }[] }[]>;
  emitToken(text: string): Promise<void>;
  completeModel(): Promise<void>;
  frames(): readonly RelayTextFrame[];
  closeCodes(): readonly number[];
  phase(): Promise<string | undefined>;
  turns(): Promise<readonly {
    state: string;
    sent_assistant_event_id: string | null;
    delivered_assistant_event_id: string | null;
  }[]>;
  close(): Promise<void>;
  terminate(phase: CallSessionTerminalPhase): Promise<CallSessionTerminationResult>;
}

type SessionStub = ReturnType<typeof env.CALL_SESSION.get>;
interface InitializedRelay {
  readonly stub: SessionStub;
  readonly object: CallSession;
  readonly initialization: Readonly<CallSessionInitialization>;
  readonly model: FakeModelProvider;
  client: WebSocket | null;
  server: WebSocket | null;
  readonly frames: RelayTextFrame[];
  readonly closeCodes: number[];
}

/**
 * The event-delivery seam is fake; D1, DO storage/upgrade, frame parsing,
 * authentication, conversation commits and output WebSocket are real.
 * It deliberately supplies the existing runtime seam without activating the Worker.
 */
export class FakeRelaySessions {
  private readonly sessions = new Map<Ulid, InitializedRelay>();
  private readonly authority = new VoiceAccessAuthorityService(
    new VoiceAccessRepository(env.DB),
    new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] }),
  );

  constructor(
    private readonly repository: CallRepository,
    private readonly modelOptions: FakeModelProviderOptions,
    private readonly now: () => Date,
  ) {}

  async initialize(initialization: Readonly<CallSessionInitialization>): Promise<void> {
    const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(initialization.sessionId));
    await stub.initialize(initialization);
    if (this.sessions.has(initialization.sessionId)) return;
    await runInDurableObject(stub, async (_instance, state) => {
      const model = new FakeModelProvider(this.modelOptions);
      const conversation = new DefaultConversationService({
        repository: new ConversationRepository(env.DB, new EventRepository(env.DB)),
        model: new DefaultModelAdapter(model),
        context: new D1ContextRetriever(env.DB),
        dispatcher: { async dispatch(): Promise<never> { throw new Error("voice_outbox_dispatch_forbidden"); } },
        redactor: new Redactor(),
        now: this.now,
      });
      const object = new CallSession(state, env, (input) => new CallSessionCore({
        session: input.session,
        expectedAccountSid: FAKE_ACCOUNT_SID,
        repository: this.repository,
        authority: this.authority,
        conversation,
        relay: input.relay,
        ...(input.initialization.binding.direction === "outbound" && "preAuthentication" in input.initialization
          ? { preAuthentication: input.initialization.preAuthentication }
          : {}),
        now: this.now,
      }));
      this.sessions.set(initialization.sessionId, {
        stub, object, initialization, model, client: null, server: null, frames: [], closeCodes: [],
      });
    });
  }

  async upgrade(request: Request, sessionId: Ulid): Promise<Response> {
    const session = this.requireSession(sessionId);
    let response: Response | undefined;
    await runInDurableObject(session.stub, async (_instance, state) => {
      response = await session.object.fetch(request);
      if (response.status !== 101 || response.webSocket === null) return;
      session.client = response.webSocket;
      session.server = state.getWebSockets()[0] ?? null;
      session.client.accept();
      session.client.addEventListener("message", (event) => {
        if (typeof event.data !== "string") throw new Error("fake_relay_binary_output");
        session.frames.push(JSON.parse(event.data) as RelayTextFrame);
      });
      session.client.addEventListener("close", (event) => { session.closeCodes.push(event.code); });
    });
    if (response === undefined) throw new Error("fake_relay_upgrade_missing");
    return response;
  }

  call(sessionId: Ulid, upgradeStatus: number): FakeRelayCall {
    const session = this.requireSession(sessionId);
    const sendFrame = (frame: string | ArrayBuffer): Promise<void> => runInDurableObject(
      session.stub,
      async () => {
        if (session.server === null) throw new Error("fake_relay_not_open");
        await session.object.webSocketMessage(session.server, frame);
      },
    );
    return Object.freeze({
      sessionId,
      callSid: session.initialization.binding.callSid,
      upgradeStatus,
      setup: () => sendFrame(JSON.stringify({
        type: "setup",
        sessionId: FAKE_PROVIDER_SESSION_ID,
        accountSid: FAKE_ACCOUNT_SID,
        callSid: session.initialization.binding.callSid,
        direction: session.initialization.binding.direction === "outbound" ? "outbound-api" : "inbound",
        customParameters: { relayNonce: session.initialization.binding.relayNonce },
      })),
      prompt: (text: string) => sendFrame(JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en-US", last: true })),
      interrupt: () => sendFrame(JSON.stringify({
        type: "interrupt", utteranceUntilInterrupt: "This response must stop", durationUntilInterruptMs: 100,
      })),
      sendFrame,
      modelRequests: () => runInDurableObject(session.stub, async () => session.model.requests
        .filter((request) => request.operation === "streamText")
        .map((request) => ({
          principalId: request.principalId, userText: request.userText,
          context: request.context.map((item) => ({ text: item.text })),
        }))),
      emitToken: (text: string) => runInDurableObject(session.stub, async () => { session.model.emitToken(text); }),
      completeModel: () => runInDurableObject(session.stub, async () => { session.model.complete(); }),
      frames: () => [...session.frames],
      closeCodes: () => [...session.closeCodes],
      phase: async () => (await this.repository.getCallSession(sessionId))?.phase,
      turns: async () => (await env.DB.prepare(`SELECT state, sent_assistant_event_id, delivered_assistant_event_id
        FROM conversation_turns WHERE session_id = ? ORDER BY rowid`).bind(sessionId)
        .all<{ state: string; sent_assistant_event_id: string | null; delivered_assistant_event_id: string | null }>()).results,
      close: () => this.close(session),
      terminate: (phase: CallSessionTerminalPhase) => this.terminate({ sessionId, phase, reason: "provider_callback" }),
    });
  }

  async cleanup(): Promise<void> {
    for (const session of this.sessions.values()) {
      // Assertions have finished. Recover stale in-memory state as well so
      // teardown cannot replace a useful failed assertion with a CAS error.
      const stored = await this.repository.getCallSession(session.initialization.sessionId);
      if (stored !== null && ["ending", "completed", "failed", "rejected", "expired"].includes(stored.phase)) {
        await this.terminate({ sessionId: stored.sessionId, phase: stored.phase === "failed" ? "failed" : "completed",
          reason: "provider_callback" });
      }
      await this.close(session);
      await runInDurableObject(session.stub, async (_instance, state) => { await state.storage.deleteAll(); });
    }
  }

  terminate(input: CallSessionTermination): Promise<CallSessionTerminationResult> {
    return new DurableObjectCallSessionTerminator({
      idFromName: (name) => env.CALL_SESSION.idFromName(name),
      get: (id) => {
        const session = this.requireSession(id.name as Ulid);
        return { terminate: (request) => runInDurableObject(session.stub, async () => session.object.terminate(request)) };
      },
    }).terminate(input);
  }

  private async close(session: InitializedRelay): Promise<void> {
    await runInDurableObject(session.stub, async () => {
      if (session.server !== null) await session.object.webSocketClose(session.server, 1000, "", true);
      session.client?.close(1000, "fixture complete");
      session.client = null;
      session.server = null;
    });
  }

  private requireSession(sessionId: Ulid): InitializedRelay {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("fake_relay_not_initialized");
    return session;
  }
}
