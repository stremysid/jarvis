/**
 * Standing owner confirmations for tier-3 tool calls.
 *
 * A tier-3 action is refused until the owner has tapped for it, and the tap is
 * recorded by the decision queue that already exists -- `decision_responses` is
 * one row per question and immutable, which is exactly the shape a confirmation
 * wants. Nothing new is invented here, and no table is added.
 *
 * What the confirmation is bound to matters more than where it is stored. It
 * binds the capability AND a canonical hash of the arguments, not just the
 * capability:
 *
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
 * Known limit, stated rather than implied away: a standing confirmation is
 * valid for `CONFIRMATION_TTL_MS` and is not marked consumed, so a second
 * identical call inside that window would also be permitted. That is a narrow
 * window for a duplicate side effect, not a way to reach a different action --
 * the capability and argument binding above still hold. Closing it properly
 * needs a durable consumed-at mark, which is a schema change and belongs in its
 * own reviewed slice.
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
  readonly capability: string;
  readonly argumentsHash: string;
  readonly now: Date;
}

export interface ToolConfirmationStoreContract {
  /** The decision that authorized this exact call, or null if none stands. */
  findStandingDecision(lookup: StandingConfirmationLookup): Promise<string | null>;
}

/**
 * The value written to `decision_items.origin_reference`, and the value looked
 * up again on the next turn. `origin_reference` is unbounded TEXT, so the only
 * constraint on its shape is that this function and the query agree.
 *
 * The two halves are separated by a colon and neither half contains one: a
 * capability key is dotted lowercase, and the hash is lowercase hex. A delimiter
 * that could appear inside either half would let a crafted capability name
 * collide with a different hash.
 */
export function confirmationReference(capability: string, argumentsHash: string): string {
  return `${capability}:${argumentsHash}`;
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

  constructor(database: D1Database) {
    this.#database = database;
  }

  async findStandingDecision(lookup: StandingConfirmationLookup): Promise<string | null> {
    const notBefore = new Date(lookup.now.getTime() - CONFIRMATION_TTL_MS).toISOString();
    const row = await this.#database.prepare(`SELECT item.decision_id AS decision_id
      FROM decision_items item
      JOIN decision_responses response ON response.decision_id = item.decision_id
      WHERE item.principal_id = ?1
        AND item.origin = ?2
        AND item.origin_reference = ?3
        AND response.option_key = ?4
        AND item.resolved_at IS NOT NULL
        AND item.resolved_at >= ?5
      ORDER BY response.responded_at DESC
      LIMIT 1`)
      .bind(
        lookup.principalId,
        TIER3_TOOL_ORIGIN,
        confirmationReference(lookup.capability, lookup.argumentsHash),
        TIER3_CONFIRM_OPTION,
        notBefore,
      )
      .first<ConfirmationRow>();
    if (row === null || row === undefined) return null;
    return typeof row.decision_id === "string" && row.decision_id.length > 0 ? row.decision_id : null;
  }
}
