import { permittedOutboundControls } from "../../../apps/cloud-gateway/test/policy/outbound-controls-fixture.js";
import { env } from "cloudflare:test";
import { CallRepository } from "../../../apps/cloud-gateway/src/persistence/call-repository.js";
import { DeviceRepository } from "../../../apps/cloud-gateway/src/persistence/device-repository.js";
import { EventRepository } from "../../../apps/cloud-gateway/src/persistence/event-repository.js";
import { PolicyEngine } from "../../../apps/cloud-gateway/src/policy/policy-engine.js";
import { PolicyService } from "../../../apps/cloud-gateway/src/policy/policy-service.js";
import { FakeTwilioProvider } from "../../../apps/cloud-gateway/src/providers/fake-twilio-provider.js";
import { OutboundCallDispatcher } from "../../../apps/cloud-gateway/src/calls/outbound-call-dispatcher.js";
import { Redactor } from "../../../apps/cloud-gateway/src/security/redaction.js";
import { D1TelegramCallCommands } from "../../../apps/cloud-gateway/src/channels/telegram/telegram-call-command.js";
import { runCommand } from "../../../apps/cloud-gateway/src/channels/telegram/command-handler.js";
import { parseCommand } from "../../../apps/cloud-gateway/src/channels/telegram/telegram-commands.js";
import { TelegramRateLimiter } from "../../../apps/cloud-gateway/src/channels/telegram/telegram-rate-limit.js";
import { handleTelegramWebhook, type AcceptedTelegramUpdate } from "../../../apps/cloud-gateway/src/channels/telegram/telegram-webhook.js";
import { createFakeCallingSystem } from "./voice-call-system.js";

const NOW = "2026-08-30T12:00:00.000Z";
export const FAKE_TELEGRAM_WEBHOOK_SECRET = "webhook-secret-value";

/** Real ingress, event-backed origin, policy and dispatcher; only Twilio and mutable policy inputs are fake. */
export async function createFakeTelegramCallingSystem(ownerPrincipalId = "principal:owner") {
  const base = await createFakeCallingSystem({ ownerPrincipalId });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES ('principal:telegram-guest', 'human', 'active', 'Fixture guest', ?, ?)`).bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES ('identity:telegram-owner', ?, 'telegram', '12345', 'active', ?, ?)`).bind(ownerPrincipalId, NOW, NOW),
    env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES ('identity:telegram-guest', 'principal:telegram-guest', 'telegram', '54321', 'active', ?, ?)`).bind(NOW, NOW),
  ]);
  let clock = new Date(NOW);
  const commands = () => new D1TelegramCallCommands({ database: env.DB, ownerPrincipalId,
    ownerVoiceIdentityId: "identity:voice", botUsername: "jarvis_sid_bot" });
  const state = { quiet: false, killSwitch: false };
  const events = new EventRepository(env.DB);
  const policy = new PolicyEngine({ database: env.DB, events, context: {
    get killSwitch() { return state.killSwitch; }, now: () => new Date(clock), isQuietHours: () => state.quiet,
    activeOutboundCalls: async (principalId) => (await env.DB.prepare(`SELECT count(*) AS count FROM call_sessions
      WHERE principal_id = ? AND direction = 'outbound' AND phase NOT IN ('completed', 'failed', 'rejected', 'expired')`)
      .bind(principalId).first<{ count: number }>())?.count ?? 0,
    outboundCallsForUtcPolicyDay: async (principalId, day) => (await env.DB.prepare(`SELECT count(*) AS count
      FROM outbound_call_attempts WHERE principal_id = ? AND substr(created_at, 1, 10) = ?`)
      .bind(principalId, day).first<{ count: number }>())?.count ?? 0,
    authenticatedOrigin: (commandId) => commands().authenticatedOrigin(commandId),
  } });
  const twilio = new FakeTwilioProvider();
  const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} }, policy, twilio, repository: new CallRepository(env.DB, events),
    publicBaseUrl: new URL("https://jarvis.example/"), now: () => new Date(clock) });
  const dispatch = { policy, dispatcher };
  const accepted: AcceptedTelegramUpdate[] = [];
  const replies: string[] = [];
  const pending: Promise<void>[] = [];
  const limiter = new TelegramRateLimiter();
  const ingest = async (text: string, input: {
    updateId?: number; messageId?: number; chatId?: number; callerId?: number; secret?: string; execute?: boolean;
  } = {}): Promise<Response> => {
    const request = new Request("https://worker.internal/telegram/webhook", { method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": input.secret ?? FAKE_TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify({ update_id: input.updateId ?? 1, message: { message_id: input.messageId ?? 900,
        from: { id: input.callerId ?? 12345 }, chat: { id: input.chatId ?? 44 }, text } }),
    });
    const response = await handleTelegramWebhook(request, { webhookSecret: FAKE_TELEGRAM_WEBHOOK_SECRET,
      policy: new PolicyService(new DeviceRepository(env.DB)), events, limiter, redactor: new Redactor(), now: () => new Date(clock),
      onAccepted: (update) => {
        accepted.push(update);
        const parsed = parseCommand(update.text, "jarvis_sid_bot");
        if (input.execute === false || parsed.kind !== "command") return;
        pending.push((async () => {
          const result = await runCommand(parsed.name, parsed.argument, { principalId: update.principalId,
            now: () => new Date(clock), calls: { request: () => commands().request(update, dispatch) } });
          replies.push(...result.map((reply) => reply.text));
        })());
      },
    });
    await Promise.all(pending);
    return response;
  };
  return { ingest, accepted, replies, commands, policy, dispatcher, twilio, state, destination: base.destination,
    setNow: (value: string) => { clock = new Date(value); }, cleanup: () => base.cleanup() };
}
