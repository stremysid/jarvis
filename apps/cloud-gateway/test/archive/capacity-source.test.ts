import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapacityGuard } from "../../src/archive/capacity-guard.js";
import { ProductionCapacitySource, type ProviderCapacityInput } from "../../src/archive/capacity-source.js";

const at = "2026-09-13T16:00:00.000Z";
const clock = () => new Date(at);
const sink = { emit: async () => undefined, rearm: async () => undefined };
const prepaid = (remaining = 15): ProviderCapacityInput => ({
  resource: "provider:model", mode: "prepaid", budget: 20, currency: "USD",
  read: async () => ({ amount: remaining, currency: "USD", observedAt: at }),
});
const postpaid = (): ProviderCapacityInput => ({
  resource: "provider:voice", mode: "postpaid", budget: 40, currency: "USD",
  read: async () => ({ amount: 12, currency: "USD", observedAt: at }),
});
function source(options: Partial<ConstructorParameters<typeof ProductionCapacitySource>[0]> = {}) {
  return new ProductionCapacitySource({
    database: env.DB, archive: env.ARCHIVE, d1BudgetBytes: 1_000_000_000, r2BudgetBytes: 1_000_000,
    providers: [prepaid(), postpaid()], now: clock, ...options,
  });
}
function guard(collector: ProductionCapacitySource) {
  return new CapacityGuard({ source: collector, sink, now: clock, maximumTelemetryAgeMs: 60_000 });
}
afterEach(() => vi.useRealTimers());

describe("ProductionCapacitySource", () => {
  it("reads real D1 metadata and all completed R2 objects, including objects outside the archive prefix", async () => {
    await env.DB.exec("CREATE TABLE IF NOT EXISTS capacity_probe (payload TEXT)");
    await env.ARCHIVE.put("outside-archive-prefix", "1234567");
    await env.ARCHIVE.put("events/sha256/probe", "123");
    const before = await env.DB.prepare("SELECT 1").run();
    const estimates = await source().readEstimates();
    expect(estimates).toEqual([
      { resource: "d1", used: before.meta.size_after, budget: 1_000_000_000, observedAt: at },
      { resource: "r2", used: 10, budget: 1_000_000, observedAt: at },
      { resource: "provider:model", used: 5, budget: 20, observedAt: at },
      { resource: "provider:voice", used: 12, budget: 40, observedAt: at },
    ]);
    expect(estimates[0]!.used).toBeGreaterThan(0);
  });

  it("passes prepaid and postpaid observations through the unchanged threshold guard in opposite directions", async () => {
    await expect(guard(source()).assertAcceptingNewTurn()).resolves.toBeUndefined();
    await expect(guard(source({ providers: [prepaid(1)] })).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
    await expect(guard(source({ providers: [prepaid(1.000001)] })).assertAcceptingNewTurn()).resolves.toBeUndefined();
    const spent = postpaid();
    spent.read = async () => ({ amount: 38, currency: "USD", observedAt: at });
    await expect(guard(source({ providers: [spent] })).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
  });

  it("preserves provider observation time rather than refreshing stale reported spending", async () => {
    const stale = postpaid();
    stale.read = async () => ({ amount: 1, currency: "USD", observedAt: "2026-09-13T15:59:00.000Z" });
    await expect(guard(source({ providers: [stale] })).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
  });

  it("fails closed on a failed credit read even when storage and the other provider are healthy", async () => {
    const unavailable = prepaid();
    unavailable.read = async () => { throw new Error("synthetic private upstream detail"); };
    await expect(source({ providers: [unavailable, postpaid()] }).readEstimates()).rejects.toThrow(/^capacity_unavailable$/);
  });

  it.each([NaN, Infinity, -1, 21])("rejects unrepresentable remaining credit %s rather than clamping it", async (amount) => {
    await expect(source({ providers: [prepaid(amount)] }).readEstimates()).rejects.toThrow("capacity_unavailable");
  });

  it("rejects a mismatched currency instead of combining unlike units", async () => {
    const mismatched = prepaid();
    mismatched.read = async () => ({ amount: 15, currency: "CNY", observedAt: at });
    await expect(source({ providers: [mismatched] }).readEstimates()).rejects.toThrow("capacity_unavailable");
  });

  it.each([{ providers: [] }, { providers: [prepaid(), prepaid()] }])("requires a nonempty uniquely named provider set", ({ providers }) => {
    expect(() => source({ providers })).toThrow("capacity_configuration_invalid");
  });

  it.each([0, -1, NaN, Infinity])("refuses invalid owner budgets %s before collecting", (budget) => {
    expect(() => source({ d1BudgetBytes: budget })).toThrow("capacity_configuration_invalid");
    expect(() => source({ r2BudgetBytes: budget })).toThrow("capacity_configuration_invalid");
    expect(() => source({ providers: [{ ...prepaid(), budget }] })).toThrow("capacity_configuration_invalid");
  });

  it("captures configured budgets and reader bindings rather than accepting later replacement", async () => {
    const provider = prepaid();
    const collector = source({ providers: [provider] });
    provider.budget = 1000;
    provider.read = async () => ({ amount: 999, currency: "USD", observedAt: at });
    expect((await collector.readEstimates())[2]).toEqual({ resource: "provider:model", used: 5, budget: 20, observedAt: at });
  });

  it("walks every R2 page and uses the start of the scan as the observation time", async () => {
    let instant = new Date(at);
    const list = vi.fn(async (options?: R2ListOptions) => {
      instant = new Date(instant.getTime() + 1000);
      return options?.cursor === undefined
        ? { objects: [{ key: "first", size: 7 }], truncated: true, cursor: "next" }
        : { objects: [{ key: "last", size: 11 }], truncated: false };
    });
    const collector = source({ archive: { list } as unknown as R2Bucket, now: () => instant });
    expect((await collector.readEstimates())[1]).toEqual({ resource: "r2", used: 18, budget: 1_000_000, observedAt: at });
    expect(list.mock.calls).toEqual([[{ limit: 1000 }], [{ limit: 1000, cursor: "next" }]]);
  });

  it.each([
    { objects: [{ key: "one", size: -1 }], truncated: false },
    { objects: [{ key: "one", size: 1.5 }], truncated: false },
    { objects: [{ key: "one", size: 1 }], truncated: true },
    { objects: [{ key: "one", size: Number.MAX_SAFE_INTEGER }, { key: "two", size: 1 }], truncated: false },
  ])("refuses an incomplete or malformed R2 scan", async (page) => {
    await expect(source({ archive: { list: async () => page } as unknown as R2Bucket }).readEstimates())
      .rejects.toThrow("capacity_unavailable");
  });

  it("rejects repeated cursors even when object keys differ", async () => {
    let count = 0;
    const list = vi.fn(async () => ({ objects: [{ key: `${count++}`, size: 1 }], truncated: true, cursor: "same" }));
    await expect(source({ archive: { list } as unknown as R2Bucket }).readEstimates()).rejects.toThrow("capacity_unavailable");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate object keys across distinct cursors rather than reporting an inconsistent scan", async () => {
    let count = 0;
    const list = vi.fn(async () => ({ objects: [{ key: "same", size: 1 }], truncated: count++ === 0, cursor: "next" }));
    await expect(source({ archive: { list } as unknown as R2Bucket }).readEstimates()).rejects.toThrow("capacity_unavailable");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("bounds a scan that keeps yielding new cursors without completing", async () => {
    let count = 0;
    const list = vi.fn(async () => ({ objects: [], truncated: true, cursor: `${count++}` }));
    await expect(source({ archive: { list } as unknown as R2Bucket }).readEstimates()).rejects.toThrow("capacity_unavailable");
    expect(list).toHaveBeenCalledTimes(100);
  });

  it.each([undefined, NaN, -1, 1.5])("refuses missing or invalid D1 size metadata %s", async (size_after) => {
    const database = { prepare: () => ({ run: async () => ({ success: true, meta: { size_after } }) }) } as unknown as D1Database;
    await expect(source({ database }).readEstimates()).rejects.toThrow("capacity_unavailable");
  });

  it("ends admission when a dependency never returns, including one that ignores cancellation", async () => {
    vi.useFakeTimers();
    const pending = prepaid();
    pending.read = () => new Promise(() => undefined);
    let ended = false;
    const denied = expect(source({ providers: [pending] }).readEstimates()).rejects.toThrow("capacity_unavailable")
      .then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ended).toBe(true);
    await denied;
  });
});
