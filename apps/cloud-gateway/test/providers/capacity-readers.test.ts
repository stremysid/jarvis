import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekCreditReader, TwilioUsageReader } from "../../src/providers/capacity-readers.js";

const at = "2026-09-13T16:00:00.000Z";
const account = `AC${"a".repeat(32)}`;
const key = `SK${"b".repeat(32)}`;
const signal = () => new AbortController().signal;
const creditBody = () => ({
  is_available: true,
  balance_infos: [{ currency: "USD", total_balance: "12.50", granted_balance: "0.50", topped_up_balance: "12.00" }],
});
const usageBody = () => ({
  next_page_uri: null as string | null,
  usage_records: [{ account_sid: account, category: "totalprice", price: "1.25", price_unit: "usd",
    start_date: "2026-09-13", end_date: "2026-09-13", as_of: "2026-09-13T15:59:31+00:00" }],
});
function credit(fetchImplementation: typeof fetch, now = () => new Date(at)) {
  return new DeepSeekCreditReader({ apiKey: "synthetic-model-key", currency: "USD", now, fetchImplementation });
}
function voice(fetchImplementation: typeof fetch, now = () => new Date(at)) {
  return new TwilioUsageReader({ accountSid: account, apiKeySid: key, apiKeySecret: "synthetic-voice-key", currency: "USD", now, fetchImplementation });
}
function response(body: unknown): typeof fetch { return vi.fn(async () => Response.json(body)); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Capacity provider readers", () => {
  it("reads current credit from the fixed balance endpoint and timestamps the start of the read", async () => {
    let instant = new Date(at);
    const fetcher = vi.fn<typeof fetch>(async () => {
      instant = new Date(instant.getTime() + 1000);
      return Response.json(creditBody());
    });
    expect(await credit(fetcher, () => instant).read(signal())).toEqual({ amount: 12.5, currency: "USD", observedAt: at });
    expect(fetcher).toHaveBeenCalledWith("https://api.deepseek.com/user/balance", expect.objectContaining({
      method: "GET", redirect: "error", cache: "no-store",
      headers: { authorization: "Bearer synthetic-model-key", accept: "application/json" },
    }));
  });

  it("reads one account-wide totalprice record for the current UTC day and preserves its actual as_of", async () => {
    const fetcher = vi.fn<typeof fetch>(response(usageBody()));
    expect(await voice(fetcher).read(signal())).toEqual({ amount: 1.25, currency: "USD", observedAt: "2026-09-13T15:59:31.000Z" });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.twilio.com/2010-04-01/Accounts/${account}/Usage/Records/Today.json?Category=totalprice`,
      expect.objectContaining({ method: "GET", redirect: "error", cache: "no-store",
        headers: { authorization: `Basic ${btoa(`${key}:synthetic-voice-key`)}`, accept: "application/json" } }),
    );
  });

  it("uses bound native fetch for both production readers", async () => {
    vi.stubGlobal("fetch", function (this: unknown, input: RequestInfo | URL) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json(String(input).includes("deepseek") ? creditBody() : usageBody()));
    });
    expect(await new DeepSeekCreditReader({ apiKey: "synthetic", currency: "USD", now: () => new Date(at) }).read(signal())).toHaveProperty("amount", 12.5);
    expect(await new TwilioUsageReader({ accountSid: account, apiKeySid: key, apiKeySecret: "synthetic", currency: "USD", now: () => new Date(at) }).read(signal())).toHaveProperty("amount", 1.25);
  });

  it.each([
    {}, { is_available: true }, { ...creditBody(), is_available: false }, { ...creditBody(), is_available: "true" },
    { is_available: true, balance_infos: [] },
    { is_available: true, balance_infos: [creditBody().balance_infos[0], creditBody().balance_infos[0]] },
  ])("refuses unavailable, short or ambiguous credit telemetry", async (body) => {
    await expect(credit(response(body)).read(signal())).rejects.toThrow(/^capacity_unavailable$/);
  });

  it.each([
    ["currency", "CNY"], ["currency", "usd"], ["total_balance", ""], ["total_balance", null],
    ["total_balance", "-1"], ["total_balance", "1e2"], ["total_balance", "NaN"],
    ["total_balance", "12.500000001"], ["total_balance", "12.51"],
    ["granted_balance", undefined], ["topped_up_balance", undefined],
  ])("refuses invalid credit field %s = %s", async (field, value) => {
    const body = creditBody();
    Object.assign(body.balance_infos[0]!, { [field as string]: value });
    await expect(credit(response(body)).read(signal())).rejects.toThrow(/^capacity_unavailable$/);
  });

  it("selects the configured currency without summing different currencies", async () => {
    const body = creditBody();
    body.balance_infos.unshift({ currency: "CNY", total_balance: "100", granted_balance: "0", topped_up_balance: "100" });
    expect(await credit(response(body)).read(signal())).toHaveProperty("amount", 12.5);
  });

  it.each([
    ["account_sid", `AC${"c".repeat(32)}`], ["category", "calls"], ["price_unit", "cny"],
    ["start_date", "2026-09-12"], ["end_date", "2026-09-14"], ["as_of", undefined],
    ["as_of", "2026-09-13T15:59:31-04:00"], ["as_of", "2026-02-30T15:59:31+00:00"],
    ["price", "-1"], ["price", "1.25 USD"], ["price", undefined],
  ])("refuses invalid spending field %s = %s", async (field, value) => {
    const body = usageBody();
    Object.assign(body.usage_records[0]!, { [field as string]: value });
    await expect(voice(response(body)).read(signal())).rejects.toThrow(/^capacity_unavailable$/);
  });

  it.each([{}, { usage_records: [] }, { ...usageBody(), next_page_uri: "more" },
    { ...usageBody(), usage_records: [usageBody().usage_records[0], usageBody().usage_records[0]] },
  ])("refuses incomplete or multiple spending records", async (body) => {
    await expect(voice(response(body)).read(signal())).rejects.toThrow(/^capacity_unavailable$/);
  });

  it("refuses a UTC day rollover instead of treating yesterday's amount as today's usage", async () => {
    let instant = new Date("2026-09-13T23:59:59.000Z");
    const fetcher: typeof fetch = async () => { instant = new Date("2026-09-14T00:00:00.000Z"); return Response.json(usageBody()); };
    await expect(voice(fetcher, () => instant).read(signal())).rejects.toThrow(/^capacity_unavailable$/);
  });

  it.each([credit, voice])("fails closed on HTTP, decoding and cache faults for either provider", async (build) => {
    for (const make of [
      () => new Response("synthetic private upstream detail", { status: 401 }),
      () => new Response("synthetic private upstream detail", { status: 503 }),
      () => new Response("<html>not telemetry</html>"),
      () => new Response("{invalid", { headers: { "content-type": "application/json" } }),
      () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
      () => new Response(" ".repeat(65_537), { headers: { "content-type": "application/json" } }),
      () => Response.json(build === credit ? creditBody() : usageBody(), { headers: { age: "1" } }),
    ]) {
      await expect(build(async () => make()).read(signal())).rejects.toThrow(/^capacity_unavailable$/);
    }
    await expect(build(async () => { throw new Error("synthetic private request details"); }).read(signal())).rejects.toThrow(/^capacity_unavailable$/);
  });

  it("accepts an exactly bounded response and refuses the next byte", async () => {
    const body = JSON.stringify(creditBody());
    const make = (length: number) => new Response(body + " ".repeat(length - body.length), { headers: { "content-type": "application/json" } });
    await expect(credit(async () => make(65_536)).read(signal())).resolves.toHaveProperty("amount", 12.5);
    await expect(credit(async () => make(65_537)).read(signal())).rejects.toThrow("capacity_unavailable");
  });

  it("refuses an already aborted read without sending a request", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>(response(creditBody()));
    await expect(credit(fetcher).read(controller.signal)).rejects.toThrow("capacity_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels a stalled body and returns on the five-second deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher: typeof fetch = async () => new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } });
    let ended = false;
    const denied = expect(credit(fetcher).read(signal())).rejects.toThrow("capacity_unavailable").then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toBe(true);
    await denied;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns on deadline even when fetch ignores its aborted signal", async () => {
    vi.useFakeTimers();
    let received: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => { received = init?.signal; return new Promise(() => undefined); };
    let ended = false;
    const denied = expect(credit(fetcher).read(signal())).rejects.toThrow("capacity_unavailable").then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toBe(true);
    await denied;
    expect(received?.aborted).toBe(true);
  });

  it("honours caller cancellation before the reader deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const denied = expect(credit(async () => new Promise(() => undefined)).read(controller.signal)).rejects.toThrow("capacity_unavailable");
    controller.abort();
    await denied;
    expect(vi.getTimerCount()).toBe(0);
  });
});
