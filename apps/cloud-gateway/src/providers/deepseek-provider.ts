import type {
  ModelAdapter,
  ModelAdapterStreamInput,
  ModelToken,
} from "../model/model-types.js";

/**
 * DeepSeek model adapter over the OpenAI-compatible chat completions API.
 *
 * Two bounds matter more than throughput here. `firstTokenTimeoutMs` catches a
 * provider that accepts the connection and then stalls -- on a voice call that
 * is silence the caller experiences as a dead line. `maxOutputCharacters`
 * stops a runaway generation from being streamed onward indefinitely; the
 * stream is cut at the limit rather than truncated afterwards, so the tokens
 * are never produced in the first place.
 *
 * Retrieved context is passed as system messages carrying their source event
 * ids. Every claim the model makes from memory is therefore traceable to an
 * archived event rather than appearing from nowhere.
 */

const API_ORIGIN = "https://api.deepseek.com";
const MODEL = "deepseek-v4-pro";

/** Never sent to the model. Retrieval decides what is allowed in a prompt. */
const SYSTEM_PROMPT =
  "You are Jarvis, a private personal assistant. Answer briefly and directly. "
  + "Use only the provided context and the user's message. If you do not know something, say so.";

export interface DeepSeekAdapterOptions {
  readonly apiKey: string;
  readonly fetchImplementation?: typeof fetch;
  readonly baseUrl?: string;
}

interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export class DeepSeekModelAdapter implements ModelAdapter {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: DeepSeekAdapterOptions) {
    if (options.apiKey.length === 0) throw new TypeError("deepseek_api_key_invalid");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#baseUrl = options.baseUrl ?? API_ORIGIN;
  }

  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    const messages = buildMessages(input);

    // Combine the caller's signal with our own timeout so either can stop the
    // request, and so the socket is always released.
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    const overall = setTimeout(abort, input.timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: true,
          reasoning_effort: input.reasoningEffort,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(overall);
      input.signal.removeEventListener("abort", abort);
      throw new Error("model_unavailable", { cause: error });
    }

    if (!response.ok || response.body === null) {
      clearTimeout(overall);
      input.signal.removeEventListener("abort", abort);
      throw new Error(response.status === 401 ? "model_authentication_failed" : "model_unavailable");
    }

    // Fires only until the first token arrives; a provider that connects and
    // then says nothing is the failure this exists to catch.
    let firstTokenSeen = false;
    const firstToken = setTimeout(() => {
      if (!firstTokenSeen) controller.abort();
    }, input.firstTokenTimeoutMs);

    let index = 0;
    let emitted = 0;
    try {
      for await (const data of readServerSentEvents(response.body)) {
        if (data === "[DONE]") return;
        const text = deltaTextOf(data);
        if (text === null || text.length === 0) continue;

        firstTokenSeen = true;
        clearTimeout(firstToken);

        // Cut at the boundary rather than emitting and trimming later.
        const remaining = input.maxOutputCharacters - emitted;
        if (remaining <= 0) return;
        const chunk = text.length > remaining ? text.slice(0, remaining) : text;
        emitted += chunk.length;

        yield { index, text: chunk };
        index += 1;
        if (emitted >= input.maxOutputCharacters) return;
      }
    } finally {
      clearTimeout(firstToken);
      clearTimeout(overall);
      input.signal.removeEventListener("abort", abort);
      // Releases the connection when a consumer stops iterating early.
      await response.body.cancel().catch(() => undefined);
    }
  }
}

function buildMessages(input: ModelAdapterStreamInput): readonly ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const item of input.context) {
    // The source id travels with the excerpt so an answer can be traced back
    // to the archived event it came from.
    messages.push({ role: "system", content: `Context [${item.sourceEventId}]: ${item.text}` });
  }
  messages.push({ role: "user", content: input.userText });
  return messages;
}

function deltaTextOf(data: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (delta === null || typeof delta !== "object") return null;
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

/**
 * Yields the `data:` payload of each SSE frame.
 *
 * Frames are separated by a blank line and may span chunk boundaries, so the
 * buffer is only consumed up to the last complete separator. Splitting on
 * newlines alone would emit half a JSON object whenever a chunk lands
 * mid-frame.
 */
async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
      separator = buffer.indexOf("\n\n");
    }
  }
}

/** Collects a stream into one string, for channels that reply in full. */
export async function collectStream(tokens: AsyncIterable<ModelToken>): Promise<string> {
  let text = "";
  for await (const token of tokens) text += token.text;
  return text;
}
