import type { PolicyDecision } from "./policy-types.js";
import type { StoredPolicyContext, TrustedOrigin } from "./policy-engine.js";

export interface OutboundControls {
  readonly enabled: boolean;
  readonly quietStartsAt: string | null;
  readonly quietEndsAt: string | null;
}

export interface OutboundControlSource {
  readControls(): Promise<Readonly<OutboundControls>>;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) && instant.toISOString() === value;
}

/** Own immutable data survives an awaited policy read without trusting accessors. */
export function snapshotOutboundControls(value: unknown): Readonly<OutboundControls> {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("outbound_controls_unavailable");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = ["enabled", "quietStartsAt", "quietEndsAt"] as const;
  if (Reflect.ownKeys(value).length !== fields.length
    || fields.some((name) => descriptors[name] === undefined || !descriptors[name]!.enumerable || !("value" in descriptors[name]!))) {
    throw new TypeError("outbound_controls_unavailable");
  }
  const enabled: unknown = descriptors.enabled!.value;
  const start: unknown = descriptors.quietStartsAt!.value;
  const end: unknown = descriptors.quietEndsAt!.value;
  if (typeof enabled !== "boolean" || !(start === null && end === null
    || timestamp(start) && timestamp(end) && start < end)) throw new TypeError("outbound_controls_unavailable");
  return Object.freeze({ enabled, quietStartsAt: start as string | null, quietEndsAt: end as string | null });
}

/** Evaluate at the final clock sample, never at the time a slow read started. */
export function outboundControlDecision(controls: Readonly<OutboundControls>, now: string): PolicyDecision {
  if (!controls.enabled) return { decision: "deny", reason: "kill_switch_enabled" };
  if (controls.quietStartsAt !== null && controls.quietEndsAt !== null
    && now >= controls.quietStartsAt && now < controls.quietEndsAt) return { decision: "deny", reason: "quiet_hours" };
  return { decision: "allow", reason: "allowed" };
}

export class D1OutboundControlSource implements OutboundControlSource {
  constructor(protected readonly database: D1Database) {}

  async readControls(): Promise<Readonly<OutboundControls>> {
    const row = await this.database.prepare(`SELECT enabled, quiet_starts_at, quiet_ends_at
      FROM outbound_runtime_controls WHERE singleton_id = 1`)
      .first<{ enabled: number; quiet_starts_at: string | null; quiet_ends_at: string | null }>();
    if (row === null || row.enabled !== 0 && row.enabled !== 1) throw new Error("outbound_controls_unavailable");
    return snapshotOutboundControls({ enabled: row.enabled === 1, quietStartsAt: row.quiet_starts_at, quietEndsAt: row.quiet_ends_at });
  }
}

export class D1OutboundPolicyContext extends D1OutboundControlSource implements StoredPolicyContext {
  constructor(database: D1Database, readonly authenticatedOrigin: (commandId: string) => Promise<TrustedOrigin | null>,
    readonly now: () => Date = () => new Date()) { super(database); }

  async activeOutboundCalls(principalId: string): Promise<number> {
    return this.count(`SELECT count(*) AS count FROM outbound_call_attempts WHERE principal_id = ?
      AND provider_dispatch_state IN ('claimed', 'dispatched', 'provider_dispatch_unknown') AND provider_terminal_at IS NULL`, [principalId]);
  }

  async outboundCallsForUtcPolicyDay(principalId: string, day: string): Promise<number> {
    return this.count(`SELECT count(*) AS count FROM outbound_call_attempts WHERE principal_id = ?
      AND provider_dispatch_claimed_at IS NOT NULL AND substr(provider_dispatch_claimed_at, 1, 10) = ?`, [principalId, day]);
  }

  private async count(sql: string, values: string[]): Promise<number> {
    const row = await this.database.prepare(sql).bind(...values).first<{ count: number }>();
    if (row === null || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error("outbound_controls_unavailable");
    return row.count;
  }
}
