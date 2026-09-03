import { env } from "cloudflare:test";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { applyFoundationMigration } from "../persistence/migration.js";

export interface DecisionPrincipalFixture {
  readonly principalId: string;
  readonly identityId: string;
}

/**
 * A principal with one verified Telegram identity, under ids nothing else uses.
 *
 * Every call makes a new one because none of it can be taken back: both
 * `decision_items` and `decision_responses` refuse DELETE, and the principal
 * they point at is held by ON DELETE RESTRICT. Reusing one principal across
 * tests would mean every queue assertion also had to account for whatever the
 * earlier tests left behind, and the assertions that matter here are about the
 * exact contents and order of a queue.
 *
 * They are service principals rather than human ones for a schema reason:
 * `principals_one_human_idx` permits exactly one human row in the entire
 * database, so a human fixture per test would collide with itself and with
 * every other suite. Nothing in the decision queue reads principal_type, so
 * the substitution does not reach the code under test.
 */
export async function createDecisionPrincipal(): Promise<DecisionPrincipalFixture> {
  await applyFoundationMigration();
  const suffix = newUlid();
  const principalId = `principal:decisions:${suffix}`;
  const identityId = `identity:decisions:${suffix}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
       VALUES (?, 'service', 'active', 'decision queue fixture', ?, ?)`,
    ).bind(principalId, now, now),
    env.DB.prepare(
      `INSERT INTO channel_identities (
         identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
       ) VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`,
    ).bind(identityId, principalId, suffix, now, now),
  ]);
  return Object.freeze({ principalId, identityId });
}

/** How many responses exist for one item, read past the service and the repository. */
export async function countResponses(decisionId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM decision_responses WHERE decision_id = ?",
  ).bind(decisionId).first<{ count: number }>();
  return row?.count ?? 0;
}
