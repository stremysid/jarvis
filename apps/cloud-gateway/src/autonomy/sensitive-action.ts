/**
 * The one place that answers "is this a sensitive action".
 *
 * Sensitive is not a property a caller may assert and not a second list
 * beside the first. It is `capability_tiers` saying tier 3, and this module is
 * the only reader that turns that row into a yes: the Telegram owner agent
 * reaches the same answer through `decideOutcome`, which returns
 * `requires_confirmation` for exactly the same tier, and the call session
 * reaches it through `requiresOwnerAuthorisation`. A capability added as tier
 * 3 in a migration is gated on both channels at once, which is the point --
 * a list that could drift between channels is a list a persuasive prompt only
 * has to defeat once.
 *
 * `decideOutcome` also consults the autonomy mode, because on Telegram a
 * tier-2 action in shadow mode is withheld and that is a different question.
 * Sensitivity has no mode: money is money in shadow mode too.
 */

import type { AutonomyTier } from "./autonomy-types.js";

export const SENSITIVE_ACTION_TIER: AutonomyTier = 3;

export function isSensitiveAction(tier: AutonomyTier | null): boolean {
  return tier === SENSITIVE_ACTION_TIER;
}

/** The narrow slice of the autonomy repository this decision needs. */
export interface CapabilityTierReader {
  readCapabilityTier(capability: string): Promise<AutonomyTier | null>;
}

/**
 * An unregistered capability is not sensitive and is not permitted either --
 * it is denied upstream. Treating it as sensitive here would send the caller
 * to a PIN prompt for something that is never going to run, and treating it as
 * permitted would be a worse answer still.
 */
export async function requiresOwnerAuthorisation(
  reader: CapabilityTierReader,
  capability: string,
): Promise<boolean> {
  return isSensitiveAction(await reader.readCapabilityTier(capability));
}
