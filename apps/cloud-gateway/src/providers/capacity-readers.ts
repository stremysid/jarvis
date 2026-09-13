import type { ProviderCapacityObservation } from "../archive/capacity-source.js";

interface ReaderOptions {
  now: () => Date;
  fetchImplementation?: typeof fetch;
}

function unavailable(): Error { return new Error("capacity_unavailable"); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function amount(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number")
    || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/u.test(String(value))) throw unavailable();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw unavailable();
  return parsed;
}

/** Fixed provider origins only. Redirects must never carry these credentials. */
async function readJson(url: string, authorization: string, fetcher: typeof fetch, signal: AbortSignal): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (signal.aborted) throw unavailable();
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(unavailable()), { once: true });
      timer = setTimeout(abort, 5000);
    });
    const work = (async () => {
      const response = await fetcher(url, {
        method: "GET", headers: { authorization, accept: "application/json" },
        redirect: "error", cache: "no-store", signal: controller.signal,
      });
      if (controller.signal.aborted) { void response.body?.cancel(); throw unavailable(); }
      if (!response.ok || response.redirected || response.body === null) throw unavailable();
      // A cached balance cannot acquire a new observedAt just because this
      // request was recent. The provider supplies no timestamp for credit.
      const age = response.headers.get("age");
      if (age !== null && age !== "0") throw unavailable();
      if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw unavailable();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 65_536) throw unavailable();
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return record(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
    })();
    return await Promise.race([work, stopped]);
  } catch {
    // No upstream body, credential, request URL or account identifier in errors.
    throw unavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

export class DeepSeekCreditReader {
  private readonly fetcher: typeof fetch;
  private readonly apiKey: string;
  private readonly currency: "USD" | "CNY";
  private readonly now: () => Date;
  constructor(options: ReaderOptions & { apiKey: string; currency: "USD" | "CNY" }) {
    if (!/^[\x21-\x7e]{1,4096}$/u.test(options.apiKey) || !["USD", "CNY"].includes(options.currency)) {
      throw new TypeError("capacity_configuration_invalid");
    }
    this.apiKey = options.apiKey;
    this.currency = options.currency;
    this.now = options.now;
    this.fetcher = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }
  async read(signal: AbortSignal): Promise<ProviderCapacityObservation> {
    const observedAt = this.now().toISOString();
    const body = await readJson("https://api.deepseek.com/user/balance", `Bearer ${this.apiKey}`, this.fetcher, signal);
    if (body.is_available !== true || !Array.isArray(body.balance_infos) || body.balance_infos.length === 0) throw unavailable();
    const currencies = new Set<string>();
    let selected: number | undefined;
    for (const value of body.balance_infos) {
      const balance = record(value);
      if ((balance.currency !== "USD" && balance.currency !== "CNY") || currencies.has(balance.currency)) throw unavailable();
      currencies.add(balance.currency);
      const total = amount(balance.total_balance);
      const granted = amount(balance.granted_balance);
      const toppedUp = amount(balance.topped_up_balance);
      if (Math.abs(total - granted - toppedUp) > 0.00000001) throw unavailable();
      if (balance.currency === this.currency) selected = total;
    }
    if (selected === undefined) throw unavailable();
    return { amount: selected, currency: this.currency, observedAt };
  }
}

export class TwilioUsageReader {
  private readonly fetcher: typeof fetch;
  private readonly accountSid: string;
  private readonly authorization: string;
  private readonly currency: string;
  private readonly now: () => Date;
  constructor(options: ReaderOptions & { accountSid: string; apiKeySid: string; apiKeySecret: string; currency: string }) {
    if (!/^AC[0-9a-fA-F]{32}$/u.test(options.accountSid) || !/^SK[0-9a-fA-F]{32}$/u.test(options.apiKeySid)
      || !/^[\x21-\x7e]{1,4096}$/u.test(options.apiKeySecret) || !/^[A-Z]{3}$/u.test(options.currency)) {
      throw new TypeError("capacity_configuration_invalid");
    }
    this.accountSid = options.accountSid;
    this.authorization = `Basic ${btoa(`${options.apiKeySid}:${options.apiKeySecret}`)}`;
    this.currency = options.currency;
    this.now = options.now;
    this.fetcher = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }
  async read(signal: AbortSignal): Promise<ProviderCapacityObservation> {
    const day = this.now().toISOString().slice(0, 10);
    const body = await readJson(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Usage/Records/Today.json?Category=totalprice`,
      this.authorization, this.fetcher, signal,
    );
    if (!Array.isArray(body.usage_records) || body.usage_records.length !== 1 || body.next_page_uri !== null) throw unavailable();
    const usage = record(body.usage_records[0]);
    if (usage.account_sid !== this.accountSid || usage.category !== "totalprice" || usage.price_unit !== this.currency.toLowerCase()
      || usage.start_date !== day || usage.end_date !== day || this.now().toISOString().slice(0, 10) !== day
      || typeof usage.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/u.test(usage.as_of)) throw unavailable();
    const observedAt = `${usage.as_of.slice(0, 19)}.000Z`;
    if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) throw unavailable();
    return { amount: amount(usage.price), currency: this.currency, observedAt };
  }
}
