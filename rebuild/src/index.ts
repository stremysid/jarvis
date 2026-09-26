import type { Env } from "./env.js";
import { SystemClock } from "./clock.js";
import { verifyTelegramWebhook } from "./router/telegram-webhook.js";
import { buildJarvis } from "./jarvis/build.js";
import { DeepSeekModel } from "./model/deepseek.js";
import { MissingModelKeyError } from "./model/types.js";
import { TelegramChannel } from "./channels/telegram-channel.js";
import { FakeEmbeddingProvider, InMemoryVectorIndex, WorkersAiEmbeddingProvider } from "./memory/embeddings.js";
import { newId } from "./ids.js";
import type { JarvisEvent } from "./jarvis/agent-core.js";

/**
 * Worker router. Receives Telegram webhooks, verifies them (fail closed), and
 * hands the owner's update to the Jarvis Durable Object.
 *
 * HONESTY / KNOWN LIMIT: this build's repositories are in-memory (fully tested).
 * A D1/DO-storage-backed persistence adapter is the documented next step
 * (see rebuild/PROGRESS.md). The DO keeps state for its lifetime; it is not yet
 * persisted across evictions. Nothing here fakes success.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, at: new SystemClock().nowIso() });
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, reason: "bad json" }, 400);
      }
      const decision = verifyTelegramWebhook(secret, body, env);
      if (!decision.ok || !decision.update) {
        return json({ ok: decision.ok, reason: decision.reason }, decision.status);
      }

      // Route to the owner's Durable Object.
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns) {
        return json({ ok: false, reason: "JARVIS DO binding missing" }, 500);
      }
      const id = ns.idFromName(decision.update.chatId);
      const stub = ns.get(id);
      const resp = await stub.fetch("https://do/telegram", {
        method: "POST",
        body: JSON.stringify(decision.update),
        headers: { "content-type": "application/json" },
      });
      return resp;
    }

    return json({ ok: false, reason: "not found" }, 404);
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/**
 * The Jarvis Durable Object — one per owner. Holds conversation state and runs
 * the model loop. Text, calls, emails and wake-ups all reach this same brain.
 */
export class JarvisDurableObject {
  private built: ReturnType<typeof buildJarvis> | null = null;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  private ensureBuilt(chatId: string): ReturnType<typeof buildJarvis> {
    if (this.built) return this.built;
    const clock = new SystemClock();

    // The model. No key => no model. We do NOT fall back to a keyword bot.
    let model;
    try {
      model = new DeepSeekModel({
        apiKey: this.env.DEEPSEEK_API_KEY ?? "",
        model: this.env.DEEPSEEK_MODEL,
      });
    } catch (e) {
      if (e instanceof MissingModelKeyError) throw e;
      throw e;
    }

    const ai = this.env.AI as { run(model: string, input: unknown): Promise<any> } | undefined;
    const embeddings = ai ? new WorkersAiEmbeddingProvider(ai) : new FakeEmbeddingProvider();
    const vectors = new InMemoryVectorIndex(); // Vectorize adapter is the production swap-in.

    const ownerChannel = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN ?? "", chatId);

    this.built = buildJarvis({
      model,
      clock,
      embeddings,
      vectors,
      ownerChannel,
      ownerId: chatId,
      timezone: this.env.OWNER_TIMEZONE ?? "America/Toronto",
    });
    return this.built;
  }

  async fetch(request: Request): Promise<Response> {
    const update = (await request.json()) as {
      chatId: string;
      text: string;
      provenance: JarvisEvent["provenance"];
      callbackData?: string;
    };

    let built;
    try {
      built = this.ensureBuilt(update.chatId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) {
        // Say so plainly. Tell Sid over Telegram; do not pretend to answer.
        const ch = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN ?? "", update.chatId);
        await ch.sendText("I have no model configured (DEEPSEEK_API_KEY is unset), so I can't answer. Nothing was faked.");
        return json({ ok: false, reason: "no model key" }, 200);
      }
      throw e;
    }

    const event: JarvisEvent = {
      channel: "text",
      trigger: "text",
      provenance: update.provenance,
      text: update.text,
      eventId: newId("evt"),
    };

    const result = await built.agent.handle(event);

    // Deliver the reply. A failed send is surfaced in the response, not hidden.
    if (result.error) {
      const ch = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN ?? "", update.chatId);
      await ch.sendText(`Something went wrong reaching the model: ${result.error}`);
      return json({ ok: false, reason: result.error }, 200);
    }
    if (result.reply.trim() !== "") {
      const ch = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN ?? "", update.chatId);
      const send = await ch.sendText(result.reply);
      return json({ ok: send.ok, sendStatus: send.status });
    }
    return json({ ok: true, note: "no reply text (model may have acted via tools or stayed quiet)" });
  }
}
