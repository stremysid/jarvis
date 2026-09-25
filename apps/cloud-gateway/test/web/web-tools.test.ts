/**
 * web_read and web_search, with the network and Workers AI stubbed.
 *
 * Every test goes through `runWebTool` against the real D1 schema, so the
 * receipt row each call must write is asserted alongside what the model sees.
 * The channel tests at the end run both real owner adapters, because "the same
 * tools on calls and Telegram" is a property of the two catalogues and the
 * shared core, not of this module.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import { AGENT_MAX_TOOLS } from "../../src/providers/deepseek-provider.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import type { ModelFunctionCall } from "../../src/providers/provider-types.js";
import type { ToolAutonomyGateContract, ToolGateDecision } from "../../src/autonomy/tool-gate.js";
import {
  EXA_MCP_ENDPOINT,
  runWebTool,
  UNTRUSTED_WEB_NOTICE,
  WEB_LIMITS,
  WEB_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  webToolsFromEnv,
  type WebMarkdownConverter,
  type WebToolsDependencies,
} from "../../src/web/web-tools.js";
import type { Env } from "../../src/env.js";
import { argumentTurn } from "../channels/argument-tool-fixture.js";
import { voiceArgumentTurn } from "../channels/voice-argument-fixture.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-24T22:00:00.000Z");
const PRINCIPAL = "principal:web-tools-test";
const OWN_HOST = "jarvis-gateway.example.net";

type FetchStub = ReturnType<typeof vi.fn<typeof fetch>>;

interface ReceiptRow {
  readonly tool_name: string;
  readonly target: string;
  readonly final_url: string | null;
  readonly method: string;
  readonly outcome: string;
  readonly http_status: number | null;
  readonly bytes: number;
  readonly returned_characters: number;
  readonly truncated: number;
  readonly detail: string | null;
  readonly principal_id: string;
  readonly turn_id: string;
}

function dependencies(overrides: Partial<WebToolsDependencies> = {}): WebToolsDependencies {
  return {
    ai: null,
    fetch: vi.fn<typeof fetch>(async () => { throw new Error("unexpected_fetch"); }),
    ownHost: OWN_HOST,
    browserRendering: null,
    exaApiKey: null,
    ...overrides,
  };
}

function converter(data: string): WebMarkdownConverter & { toMarkdown: ReturnType<typeof vi.fn> } {
  return { toMarkdown: vi.fn(async () => ({ format: "markdown", data })) };
}

function toolCall(name: string, args: unknown): ModelFunctionCall {
  return { id: `call_${newUlid()}`, name, arguments: JSON.stringify(args) };
}

async function run(web: WebToolsDependencies | undefined, call: ModelFunctionCall) {
  const turnId = newUlid();
  const input = { correlationId: turnId, principalId: PRINCIPAL, signal: new AbortController().signal } as
    unknown as Readonly<ModelAdapterStreamInput>;
  const result = await runWebTool({ web, database: env.DB, input, call, now: () => NOW });
  const content = JSON.parse(result.providerResult.content) as Record<string, unknown>;
  const rows = await env.DB.prepare("SELECT * FROM web_tool_receipts WHERE turn_id = ?").bind(turnId).all<ReceiptRow>();
  return { result, content, rows: rows.results, turnId };
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function jsonRpc(result: unknown, contentType = "application/json"): Response {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result });
  return new Response(contentType.includes("event-stream") ? `event: message\ndata: ${body}\n\n` : body,
    { status: 200, headers: { "content-type": contentType } });
}

const SEARCH_TEXT = [
  "Title: Computer Science | University of Waterloo",
  "URL: https://uwaterloo.ca/future-students/programs/computer-science",
  "Published: N/A",
  "Author: N/A",
  "Highlights:\nApply through OUAC by the published deadline.",
].join("\n");

beforeAll(async () => {
  await applyNewestRuntimeMigration();
});

describe("web_read", () => {
  it("reads a page after a redirect, converts it with Workers AI, and returns the text, final URL and title with a receipt row", async () => {
    const html = "<html><head><title>Waterloo CS &amp; Math</title></head><body><h1>Admissions</h1></body></html>";
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/programs/cs" } }))
      .mockResolvedValueOnce(htmlResponse(html));
    const ai = converter("# Admissions\n\nApply through OUAC.");
    const { result, content, rows } = await run(dependencies({ fetch: fetcher, ai }),
      toolCall(WEB_READ_TOOL_NAME, { url: "https://uwaterloo.ca/cs" }));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://uwaterloo.ca/programs/cs");
    expect(ai.toMarkdown).toHaveBeenCalledTimes(1);
    expect((ai.toMarkdown.mock.calls[0]?.[0] as { name: string }).name).toBe("page.html");
    expect(content).toMatchObject({
      status: "completed",
      receiptId: `receipt:${result.providerResult.toolCallId}`,
      untrustedWebContent: true,
      notice: UNTRUSTED_WEB_NOTICE,
      url: "https://uwaterloo.ca/cs",
      finalUrl: "https://uwaterloo.ca/programs/cs",
      title: "Waterloo CS & Math",
      httpStatus: 200,
      text: "# Admissions\n\nApply through OUAC.",
      truncated: false,
      more: null,
      javascriptRendering: "not_configured",
      redirectsChecked: true,
    });
    expect(result.receipt).toBe("Read uwaterloo.ca.");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool_name: "web_read", target: "https://uwaterloo.ca/cs", final_url: "https://uwaterloo.ca/programs/cs",
      method: "direct", outcome: "completed", http_status: 200, bytes: new TextEncoder().encode(html).byteLength,
      returned_characters: 33, truncated: 0, detail: null, principal_id: PRINCIPAL,
    });
  });

  it("flags a cut page as truncated and says which offset reads the next part, instead of cutting silently", async () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const web = dependencies({
      fetch: vi.fn<typeof fetch>(async () => htmlResponse("<p>long</p>")),
      ai: converter(alphabet),
      limits: { maxReturnedCharacters: 10 },
    });

    const first = await run(web, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/long" }));
    expect(first.content).toMatchObject({ text: "abcdefghij", truncated: true, offset: 0, totalCharacters: 26 });
    expect(String(first.content.more)).toContain("offset 10");
    expect(first.rows[0]).toMatchObject({ outcome: "completed", truncated: 1, returned_characters: 10 });

    const second = await run(web, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/long", offset: 10 }));
    expect(second.content).toMatchObject({ text: "klmnopqrst", truncated: true });
    expect(String(second.content.more)).toContain("offset 20");

    const last = await run(web, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/long", offset: 20 }));
    expect(last.content).toMatchObject({ text: "uvwxyz", truncated: false, more: null });
  });

  it("flags a source that was stopped at the download cap even when all of its text fits in the reply", async () => {
    const web = dependencies({
      fetch: vi.fn<typeof fetch>(async () => new Response("0123456789ABCDEFGHIJ", { headers: { "content-type": "text/plain" } })),
      limits: { maxSourceBytes: 12 },
    });
    const { content, rows } = await run(web, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/notes.txt" }));
    expect(content).toMatchObject({ text: "0123456789AB", truncated: true });
    expect(String(content.more)).toContain("first 12 bytes");
    expect(rows[0]).toMatchObject({ bytes: 12, truncated: 1 });
  });

  it("refuses a non-http scheme without fetching anything and records the refusal", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.org/file"]) {
      const web = dependencies();
      const { result, content, rows } = await run(web, toolCall(WEB_READ_TOOL_NAME, { url }));
      expect(web.fetch).not.toHaveBeenCalled();
      expect(content.status).toBe("refused");
      expect(String(content.error)).toMatch(/^scheme_refused:/u);
      expect(result.receiptId).toBeNull();
      expect(rows[0]).toMatchObject({ target: url, outcome: "refused", method: "none", bytes: 0 });
    }
  });

  it("refuses the gateway's own origin, directly or through a redirect", async () => {
    const direct = dependencies();
    const refused = await run(direct, toolCall(WEB_READ_TOOL_NAME, { url: `https://${OWN_HOST.toUpperCase()}./telegram` }));
    expect(direct.fetch).not.toHaveBeenCalled();
    expect(String(refused.content.error)).toMatch(/^own_origin_refused:/u);

    const redirected = dependencies({
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { location: `https://${OWN_HOST}/admin` } })),
    });
    const hop = await run(redirected, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/bounce" }));
    expect(redirected.fetch).toHaveBeenCalledTimes(1);
    expect(hop.content.status).toBe("refused");
    expect(String(hop.content.error)).toMatch(/^redirect_refused: own_origin_refused:/u);
    expect(hop.rows[0]).toMatchObject({ outcome: "refused", http_status: 307, final_url: "https://example.org/bounce" });
  });

  it("stops a read that runs past the fetch timeout and reports the timeout to the model", async () => {
    const hanging = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
    }));
    const { content, rows } = await run(dependencies({ fetch: hanging, limits: { fetchTimeoutMs: 25 } }),
      toolCall(WEB_READ_TOOL_NAME, { url: "https://slow.example.org/" }));
    expect(content.status).toBe("failed");
    expect(String(content.error)).toMatch(/^timed_out: fetching the page took longer than 25 ms/u);
    expect(content.untrustedWebContent).toBe(true);
    expect(rows[0]).toMatchObject({ outcome: "failed", method: "direct" });
  });

  it("reports an HTTP error status to the model instead of converting the error page", async () => {
    const ai = converter("never");
    const { content, rows } = await run(dependencies({ fetch: vi.fn<typeof fetch>(async () => htmlResponse("gone", 404)), ai }),
      toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/missing" }));
    expect(ai.toMarkdown).not.toHaveBeenCalled();
    expect(content).toMatchObject({ status: "failed", httpStatus: 404 });
    expect(String(content.error)).toMatch(/^http_404:/u);
    expect(rows[0]).toMatchObject({ outcome: "failed", http_status: 404 });
  });

  it("says JavaScript rendering is not configured when asked for it without the Browser Rendering secrets", async () => {
    const web = dependencies();
    const { content, rows } = await run(web, toolCall(WEB_READ_TOOL_NAME, { url: "https://app.example.org/", renderJavaScript: true }));
    expect(web.fetch).not.toHaveBeenCalled();
    expect(content.status).toBe("failed");
    expect(String(content.error)).toMatch(/^javascript_rendering_not_configured:/u);
    expect(rows[0]).toMatchObject({ outcome: "failed" });
  });

  it("renders through the Browser Rendering markdown endpoint when its secrets are configured", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: "# Rendered app" }));
    const { result, content, rows } = await run(dependencies({
      fetch: fetcher, browserRendering: { accountId: "acct123", apiToken: "synthetic-token" },
    }), toolCall(WEB_READ_TOOL_NAME, { url: "https://app.example.org/", renderJavaScript: true }));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/browser-rendering/markdown");
    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-token");
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://app.example.org/" });
    // Cloudflare's browser follows redirects where this code cannot re-check
    // them, so the result must not look like a checked direct read.
    expect(content).toMatchObject({
      status: "completed", method: "browser_rendering", text: "# Rendered app", untrustedWebContent: true,
      finalUrl: null, redirectsChecked: false,
    });
    expect(result.providerResult.content).not.toContain("synthetic-token");
    expect(rows[0]).toMatchObject({ method: "browser_rendering", outcome: "completed" });
  });

  it("applies the URL and argument caps from the limits seam like every other bound", async () => {
    const tightUrl = dependencies({ limits: { maxUrlCharacters: 20 } });
    const longUrl = await run(tightUrl, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/a-longer-path" }));
    expect(tightUrl.fetch).not.toHaveBeenCalled();
    expect(String(longUrl.content.error)).toBe("url_length: a URL must be 1 to 20 characters.");

    const tightArguments = dependencies({ limits: { maxArgumentBytes: 16 } });
    const bigArguments = await run(tightArguments, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/" }));
    expect(tightArguments.fetch).not.toHaveBeenCalled();
    expect(String(bigArguments.content.error)).toBe("arguments_too_large: arguments are limited to 16 bytes.");
  });

  it("tells the model when the web tools were not wired rather than returning an empty page", async () => {
    const { content, rows } = await run(undefined, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/" }));
    expect(content.status).toBe("failed");
    expect(String(content.error)).toMatch(/^web_tools_not_wired:/u);
    expect(rows[0]).toMatchObject({ outcome: "failed", method: "none" });
  });
});

describe("web_search", () => {
  it("returns titles, URLs and highlights from Exa's keyless MCP endpoint over plain JSON-RPC", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonRpc({ content: [{ type: "text", text: SEARCH_TEXT }] }));
    const { result, content, rows } = await run(dependencies({ fetch: fetcher }),
      toolCall(WEB_SEARCH_TOOL_NAME, { query: "Waterloo computer science application deadline", numResults: 3 }));

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(EXA_MCP_ENDPOINT);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.has("x-api-key")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "web_search_exa", arguments: { query: "Waterloo computer science application deadline", numResults: 3 } },
    });
    expect(content).toMatchObject({
      status: "completed", untrustedWebContent: true, notice: UNTRUSTED_WEB_NOTICE,
      query: "Waterloo computer science application deadline", keyless: true, text: SEARCH_TEXT, truncated: false,
    });
    expect(result.receipt).toBe("Searched the web for \"Waterloo computer science application deadline\".");
    expect(rows[0]).toMatchObject({ tool_name: "web_search", method: "exa_mcp", outcome: "completed", http_status: 200 });
  });

  it("reads the reply from an SSE stream and sends the Exa key as a header when one is configured", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonRpc({ content: [{ type: "text", text: SEARCH_TEXT }] }, "text/event-stream"));
    const { content } = await run(dependencies({ fetch: fetcher, exaApiKey: "synthetic-exa-key" }),
      toolCall(WEB_SEARCH_TOOL_NAME, { query: "OUAC deadline" }));
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe("synthetic-exa-key");
    expect(content).toMatchObject({ status: "completed", text: SEARCH_TEXT, keyless: false });
  });

  it("surfaces a search provider's rate limit to the model as a failure, not as an empty result", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("You've hit Exa's free MCP rate limit.", { status: 429 }));
    const { result, content, rows } = await run(dependencies({ fetch: fetcher }), toolCall(WEB_SEARCH_TOOL_NAME, { query: "anything" }));
    expect(content.status).toBe("failed");
    expect(String(content.error)).toMatch(/^search_provider_http_429:/u);
    expect(String(content.error)).toContain("EXA_API_KEY");
    expect(String(content.error)).toContain("free MCP rate limit");
    expect(content).not.toHaveProperty("text");
    expect(result.receiptId).toBeNull();
    expect(rows[0]).toMatchObject({ outcome: "failed", http_status: 429, method: "exa_mcp" });
  });

  it("names the search reply's own byte cap, not the page cap, when a search reply is cut short", async () => {
    const complete = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: SEARCH_TEXT }] } })}\n\n`;
    const cap = new TextEncoder().encode(complete).byteLength + 16;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(`${complete}event: message\ndata: ${"x".repeat(400)}`,
      { status: 200, headers: { "content-type": "text/event-stream" } }));
    const { content, rows } = await run(dependencies({ fetch: fetcher, limits: { maxSearchResponseBytes: cap } }),
      toolCall(WEB_SEARCH_TOOL_NAME, { query: "OUAC deadline" }));
    expect(content).toMatchObject({ status: "completed", text: SEARCH_TEXT, truncated: true });
    expect(String(content.more)).toContain(`larger than ${cap} bytes, so only its first ${cap} bytes`);
    expect(String(content.more)).not.toContain(String(WEB_LIMITS.maxSourceBytes));
    expect(rows[0]).toMatchObject({ outcome: "completed", truncated: 1, bytes: cap });
  });

  it("surfaces a tool error, a JSON-RPC error and a reply with no content as failures", async () => {
    const cases: Array<[Response, RegExp]> = [
      [jsonRpc({ isError: true, content: [{ type: "text", text: "Exa API error: invalid query" }] }), /^search_provider_error: Exa API error/u],
      [Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool" } }), /^search_provider_error: Unknown tool/u],
      [jsonRpc({ content: [] }), /^search_provider_empty:/u],
      [new Response("<html>not json</html>", { headers: { "content-type": "text/html" } }), /^search_provider_protocol:/u],
    ];
    for (const [response, expected] of cases) {
      const { content, rows } = await run(dependencies({ fetch: vi.fn<typeof fetch>(async () => response) }),
        toolCall(WEB_SEARCH_TOOL_NAME, { query: "anything" }));
      expect(content.status).toBe("failed");
      expect(String(content.error)).toMatch(expected);
      expect(rows[0]).toMatchObject({ outcome: "failed" });
    }
  });
});

describe("webToolsFromEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fromEnv(publicOrigin: string | undefined): WebToolsDependencies {
    return webToolsFromEnv({ PUBLIC_ORIGIN: publicOrigin } as unknown as Env);
  }

  it("refuses every web_read and fetches nothing when PUBLIC_ORIGIN is missing, blank, not a URL or has no web host", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected_fetch"); });
    for (const origin of [undefined, "", "   ", "jarvis gateway", "mailto:ops@example.org", "ftp://files.example.org"]) {
      const web = fromEnv(origin);
      expect(web.ownHost).toBeNull();
      const { result, content, rows } = await run(web, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/page" }));
      expect(content.status).toBe("refused");
      expect(String(content.error)).toMatch(/^own_origin_unknown: nothing was fetched\./u);
      expect(String(content.error)).toContain("PUBLIC_ORIGIN");
      expect(result.receiptId).toBeNull();
      expect(rows[0]).toMatchObject({ tool_name: "web_read", outcome: "refused", method: "none", bytes: 0 });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps web_search working without PUBLIC_ORIGIN, because the own-origin limit is about fetching pages", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonRpc({ content: [{ type: "text", text: SEARCH_TEXT }] }));
    const { content } = await run(fromEnv(undefined), toolCall(WEB_SEARCH_TOOL_NAME, { query: "OUAC deadline" }));
    expect(String(network.mock.calls[0]?.[0])).toBe(EXA_MCP_ENDPOINT);
    expect(content).toMatchObject({ status: "completed", text: SEARCH_TEXT });
  });

  it("takes the own host from PUBLIC_ORIGIN, refuses it in any case or with a trailing dot, and reads other hosts", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("plain notes", { headers: { "content-type": "text/plain" } }));
    const web = fromEnv(" https://Gateway.Example.NET/base ");
    expect(web.ownHost).toBe("gateway.example.net");

    const own = await run(web, toolCall(WEB_READ_TOOL_NAME, { url: "https://GATEWAY.example.net./telegram" }));
    expect(String(own.content.error)).toMatch(/^own_origin_refused:/u);
    expect(network).not.toHaveBeenCalled();

    const other = await run(web, toolCall(WEB_READ_TOOL_NAME, { url: "https://example.org/notes.txt" }));
    expect(other.content).toMatchObject({ status: "completed", text: "plain notes" });
    expect(network).toHaveBeenCalledTimes(1);
  });
});

describe("web tools on both owner channels", () => {
  // Since #174 both adapters hand the provider this one catalogue, so being in
  // it is being on both channels. The two turn tests below prove each adapter
  // actually runs the tool.
  it("puts web_read and web_search in the shared owner catalogue, within the provider's tool cap", () => {
    const names = OWNER_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toContain(WEB_READ_TOOL_NAME);
    expect(names).toContain(WEB_SEARCH_TOOL_NAME);
    expect(OWNER_TOOL_DEFINITIONS.length).toBeLessThanOrEqual(AGENT_MAX_TOOLS);
  });

  it("runs web_search from a Telegram turn and hands the model the untrusted results with a receipt", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonRpc({ content: [{ type: "text", text: SEARCH_TEXT }] }));
    const turn = await argumentTurn("look up the waterloo cs deadline", {
      id: "call_web_telegram", name: WEB_SEARCH_TOOL_NAME, arguments: JSON.stringify({ query: "Waterloo CS deadline" }),
    }, { web: dependencies({ fetch: fetcher }) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const toolResult = JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}") as Record<string, unknown>;
    expect(toolResult).toMatchObject({ status: "completed", untrustedWebContent: true, text: SEARCH_TEXT });
    expect(turn.replies.join("\n")).toContain("Searched the web for \"Waterloo CS deadline\".");
    const row = await env.DB.prepare("SELECT outcome, principal_id FROM web_tool_receipts WHERE turn_id = ?")
      .bind(turn.turnId).first<{ outcome: string; principal_id: string }>();
    expect(row).toEqual({ outcome: "completed", principal_id: turn.principalId });
  });

  it("runs web_search from a call turn and hands the model the same untrusted results with a receipt", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonRpc({ content: [{ type: "text", text: SEARCH_TEXT }] }));
    const turn = await voiceArgumentTurn("look up the waterloo cs deadline", {
      id: "call_web_voice", name: WEB_SEARCH_TOOL_NAME, arguments: JSON.stringify({ query: "Waterloo CS deadline" }),
    }, { web: dependencies({ fetch: fetcher }) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const toolResult = JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}") as Record<string, unknown>;
    expect(toolResult).toMatchObject({ status: "completed", untrustedWebContent: true, text: SEARCH_TEXT });
    expect(turn.spoken).toContain("Searched the web for \"Waterloo CS deadline\".");
    const row = await env.DB.prepare("SELECT outcome, principal_id FROM web_tool_receipts WHERE turn_id = ?")
      .bind(turn.turnId).first<{ outcome: string; principal_id: string }>();
    expect(row).toEqual({ outcome: "completed", principal_id: turn.principalId });
  });

  it("runs the tier gate before any web request, so a denied capability fetches nothing", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonRpc({ content: [{ type: "text", text: SEARCH_TEXT }] }));
    const deny: ToolAutonomyGateContract = {
      async evaluateToolCall() {
        return { verdict: "deny", receipt: "Nothing happened: read.web is denied in this test.", confirmedBy: null,
          evaluation: {} } as unknown as ToolGateDecision;
      },
    };
    const turn = await argumentTurn("search the web", {
      id: "call_web_denied", name: WEB_SEARCH_TOOL_NAME, arguments: JSON.stringify({ query: "anything" }),
    }, { web: dependencies({ fetch: fetcher }), gate: deny });
    expect(fetcher).not.toHaveBeenCalled();
    const toolResult = JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}") as Record<string, unknown>;
    expect(toolResult).toMatchObject({ status: "refused", receipt: "Nothing happened: read.web is denied in this test." });
  });
});
