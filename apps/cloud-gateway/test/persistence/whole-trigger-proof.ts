import { env } from "cloudflare:test";
import { expect } from "vitest";

/**
 * Proves a whole trigger is load-bearing: the mutation is refused while the
 * trigger is installed, then the trigger is dropped, the same mutation is
 * re-run and must now succeed, and the trigger is restored from
 * `sqlite_schema`.
 *
 * Restoration reads the installed SQL rather than a copy of the migration, so
 * a test cannot quietly restore a weaker trigger than production runs. The
 * refusal half is what makes this different from a plain behaviour test: a
 * suite that only asserts the refusal stays green when the trigger is replaced
 * by one that refuses everything.
 *
 * `mutation` is called twice, so it must leave no state behind when it is
 * refused and must be repeatable -- build a fresh fixture per call, or use ids
 * and sequence numbers the call itself produces.
 */
export async function proveWholeTrigger(
  triggerName: string,
  mutation: () => Promise<unknown>,
  expectedFailure: string,
): Promise<void> {
  const trigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
  ).bind(triggerName).first<{ sql: string }>();
  if (trigger === null) throw new Error(`missing trigger ${triggerName}`);
  await expect(mutation()).rejects.toThrow(expectedFailure);
  await env.DB.prepare(`DROP TRIGGER ${triggerName}`).run();
  try {
    await expect(mutation()).resolves.toBeDefined();
  } finally {
    await env.DB.prepare(trigger.sql).run();
  }
}
