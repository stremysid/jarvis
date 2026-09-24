/**
 * Single-use owner confirmations for tier-3 tool calls.
 *
 * A tier-3 action is refused until the owner has tapped for it, and the tap is
 * recorded by the decision queue that already exists -- `decision_responses` is
 * one row per question and immutable, which is exactly the shape a confirmation
 * wants. A separate consumption row preserves that immutable answer.
 *
 * What the confirmation is bound to matters more than where it is stored. It
 * binds the tool name, capability and a canonical hash of the arguments:
 *
 *  - tool name, so tools that share a capability cannot spend each other's tap.
 *  - capability, so confirming "warm up the car" cannot authorize "unlock the
 *    car" -- `vehicle.precondition` and `vehicle.unlock` are different tiers
 *    and a steered model must not be able to slide from one to the other.
 *  - arguments hash, so confirming the email Sid just read cannot authorize a
 *    different one composed after he tapped. The model re-issues the call on
 *    the following turn, and it must re-issue the SAME call. Wording that
 *    differs only in key order or whitespace still matches, because the hash is
 *    taken over canonical JSON rather than over the bytes.
 *
 * The arguments themselves are never stored. The audit tables in this system
 * are read during incident review and must not become a second copy of the
 * archive, and an email body is exactly the content that rule exists to keep
 * out. Only a hash of it is kept.
 *
 * Claiming the tap and checking its age are one database statement. The unique
 * decision key arbitrates competing Workers, including different channels.
 * A claimed tap stays spent even if the later audit or tool fails: retrying a
 * side effect whose outcome is unknown needs a new confirmation.
 */

import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";

/**
 * How long a tap stays usable. Short on purpose: the owner confirms and then
 * restates in the same sitting, and an authorization that outlives the
 * conversation it belongs to is an authorization nobody remembers giving.
 */
export const CONFIRMATION_TTL_MS = 10 * 60_000;

/** The `decision_items.origin` this subsystem owns. Bounded to 64 by 0009. */
export const TIER3_TOOL_ORIGIN = "autonomy-tier3-tool";

/** The option key the owner taps to approve. */
export const TIER3_CONFIRM_OPTION = "confirm";

export interface StandingConfirmationLookup {
  readonly principalId: string;
  readonly toolName: string;
  readonly capability: string;
  readonly argumentsHash: string;
}

export interface ToolConfirmationStoreContract {
  /** Atomically spends one matching tap, returning null if none can be claimed. */
  consumeStandingDecision(lookup: StandingConfirmationLookup): Promise<string | null>;
}

/**
 * The value written to `decision_items.origin_reference`, and the value looked
 * up again on the next turn. Issuance and consumption must use the same tuple.
 *
 * JSON keeps the field boundaries unambiguous even if a name contains a
 * delimiter. Old capability:hash references deliberately do not match: they
 * cannot prove which tool the owner approved, so the owner must tap again.
 */
export function confirmationReference(toolName: string, capability: string, argumentsHash: string): string {
  return JSON.stringify([toolName, capability, argumentsHash]);
}

/**
 * The hash a confirmation binds to.
 *
 * Canonical JSON, so the model re-issuing the same call with reordered keys or
 * different spacing still matches the tap. Arguments that are not valid JSON
 * hash over the raw text instead of throwing: the tool's own parser rejects
 * them a moment later, and failing here would turn a malformed call into a gate
 * error rather than an ordinary refusal.
 */
export async function argumentsFingerprint(serializedArguments: string): Promise<string> {
  let canonical = serializedArguments;
  try {
    canonical = canonicalJson(JSON.parse(serializedArguments) as never);
  } catch {
    canonical = serializedArguments;
  }
  return sha256Hex(canonical);
}

interface ConfirmationRow {
  readonly decision_id: unknown;
}

export class D1ToolConfirmationStore implements ToolConfirmationStoreContract {
  readonly #database: D1Database;
  readonly #now: () => Date;

  constructor(database: D1Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async consumeStandingDecision(lookup: StandingConfirmationLookup): Promise<string | null> {
    // Sample at the claim, not at the first audit: that write may have waited
    // long enough for a tap to expire. Both SQL bounds use this same instant.
    const now = this.#now();
    const consumedAt = now.toISOString();
    const notBefore = new Date(now.getTime() - CONFIRMATION_TTL_MS).toISOString();
    const row = await this.#database.prepare(`INSERT INTO tool_confirmation_consumptions (decision_id, consumed_at)
      SELECT item.decision_id, ?6
      FROM decision_items item
      JOIN decision_responses response ON response.decision_id = item.decision_id
      WHERE item.principal_id = ?1
        AND item.origin = ?2
        AND item.origin_reference = ?3
        AND response.option_key = ?4
        AND item.resolved_at IS NOT NULL
        AND response.responded_at > ?5
        AND response.responded_at <= ?6
      ORDER BY response.responded_at DESC, item.decision_id DESC
      LIMIT 1
      ON CONFLICT DO NOTHING
      RETURNING decision_id`)
      .bind(
        lookup.principalId,
        TIER3_TOOL_ORIGIN,
        confirmationReference(lookup.toolName, lookup.capability, lookup.argumentsHash),
        TIER3_CONFIRM_OPTION,
        notBefore,
        consumedAt,
      )
      .first<ConfirmationRow>();
    if (row === null || row === undefined) return null;
    return typeof row.decision_id === "string" && row.decision_id.length > 0 ? row.decision_id : null;
  }
}
