import type { CapacityEstimate, CapacityEstimateSource } from "./capacity-guard.js";

export interface ProviderCapacityObservation {
  amount: number;
  currency: string;
  observedAt: string;
}

/** The direction belongs to the configured reader, not to a provider name. */
export interface ProviderCapacityInput {
  resource: `provider:${string}`;
  mode: "prepaid" | "postpaid";
  budget: number;
  currency: string;
  read(signal: AbortSignal): Promise<ProviderCapacityObservation>;
}

interface CapacitySourceOptions {
  database: D1Database;
  archive: R2Bucket;
  d1BudgetBytes: number;
  r2BudgetBytes: number;
  providers: readonly ProviderCapacityInput[];
  now: () => Date;
}

function unavailable(): Error { return new Error("capacity_unavailable"); }
function size(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}

/** Storage bytes plus reported provider observations, never a local charge ledger. */
export class ProductionCapacitySource implements CapacityEstimateSource {
  private readonly options: CapacitySourceOptions;

  constructor(options: CapacitySourceOptions) {
    const resources = new Set<string>();
    if (!Number.isSafeInteger(options.d1BudgetBytes) || options.d1BudgetBytes <= 0
      || !Number.isSafeInteger(options.r2BudgetBytes) || options.r2BudgetBytes <= 0
      || !Array.isArray(options.providers) || options.providers.length === 0) {
      throw new TypeError("capacity_configuration_invalid");
    }
    const providers = options.providers.map((provider) => {
      if (!/^provider:[a-z0-9][a-z0-9_-]{0,63}$/u.test(provider.resource) || resources.has(provider.resource)
        || !["prepaid", "postpaid"].includes(provider.mode) || !/^[A-Z]{3}$/u.test(provider.currency)
        || !Number.isFinite(provider.budget) || provider.budget <= 0 || typeof provider.read !== "function") {
        throw new TypeError("capacity_configuration_invalid");
      }
      resources.add(provider.resource);
      return Object.freeze({ ...provider, read: provider.read.bind(provider) });
    });
    this.options = Object.freeze({ ...options, providers: Object.freeze(providers) });
  }

  async readEstimates(): Promise<readonly CapacityEstimate[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race as well as abort: a broken binding that ignores cancellation must
      // not hold an inbound caller or a confirmed outbound command indefinitely.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 10_000);
      });
      return await Promise.race([this.collect(controller.signal), deadline]);
    } catch {
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  private async collect(signal: AbortSignal): Promise<readonly CapacityEstimate[]> {
    const observedAt = this.options.now().toISOString();
    return Promise.all([
      (async (): Promise<CapacityEstimate> => {
        const result = await this.options.database.prepare("SELECT 1").run();
        if (!result.success) throw unavailable();
        return { resource: "d1", used: size(result.meta.size_after), budget: this.options.d1BudgetBytes, observedAt };
      })(),
      this.readArchive(observedAt, signal),
      ...this.options.providers.map(async (provider): Promise<CapacityEstimate> => {
        const observation = await provider.read(signal);
        if (observation.currency !== provider.currency || !Number.isFinite(observation.amount) || observation.amount < 0) {
          throw unavailable();
        }
        const used = provider.mode === "prepaid" ? provider.budget - observation.amount : observation.amount;
        // A refill or grant beyond the declared pot violates the one-time-pot
        // assumption. Never clamp that change into an apparently healthy zero.
        if (used < 0) throw unavailable();
        return { resource: provider.resource, used, budget: provider.budget, observedAt: observation.observedAt };
      }),
    ]);
  }

  private async readArchive(observedAt: string, signal: AbortSignal): Promise<CapacityEstimate> {
    const cursors = new Set<string>();
    const keys = new Set<string>();
    let cursor: string | undefined;
    let used = 0;
    // Full completed-object payload scan, including orphaned objects. This is
    // an estimate during concurrent writes, not atomic or billed R2 storage.
    // Unfinished multipart data is outside the binding's list API.
    for (let page = 0; page < 100; page += 1) {
      if (signal.aborted) throw unavailable();
      const listed = await this.options.archive.list({ limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
      if (!Array.isArray(listed.objects) || typeof listed.truncated !== "boolean") throw unavailable();
      for (const object of listed.objects) {
        if (typeof object.key !== "string" || keys.has(object.key)) throw unavailable();
        keys.add(object.key);
        used = size(used + size(object.size));
      }
      if (!listed.truncated) return { resource: "r2", used, budget: this.options.r2BudgetBytes, observedAt };
      if (typeof listed.cursor !== "string" || listed.cursor.length === 0 || cursors.has(listed.cursor)) throw unavailable();
      cursors.add(listed.cursor);
      cursor = listed.cursor;
    }
    throw unavailable();
  }
}
