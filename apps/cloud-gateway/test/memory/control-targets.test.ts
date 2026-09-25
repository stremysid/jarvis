/**
 * The guard on the real control-target finder, which no test reached.
 *
 * `findControlTargets` is the only production implementation of
 * `TelegramMemoryTargetFinder`, and until this file it was never called by a test
 * at all: every agent test injects a stub
 * (`targets: { async findControlTargets() { return [] } }`). So the operation guard
 * at the top of it was unreachable from the suite, and a rejected operation was
 * indistinguishable from a working one.
 *
 * It was rejecting two of them. `memory_pin` and `memory_unpin` reach
 * `requireEligibleItem` -> `eligibleItemIds` -> `findControlTargets({operation:
 * "pin" | "unpin"})`, and the guard listed only forget, lift, confirm, explain and
 * correct -- so both tools threw `telegram_memory_target_invalid` in production
 * while `targetStates` sat below with a `pin`/`unpin` case already written for
 * them, and every test stayed green.
 *
 * These tests therefore assert on the REAL finder, not on a stub. A stub cannot
 * fail the way production fails.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";

let serial = 0;

async function seedPrincipal(): Promise<string> {
  serial += 1;
  const principalId = `principal:control-targets:${serial}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'control targets test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

function retriever(): TelegramMemoryRetriever {
  return new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE });
}

beforeAll(async () => {
  await applyNewestRuntimeMigration();
});

describe("the real control-target finder accepts every operation its caller can pass", () => {
  // The contract is the type: TelegramMemoryTargetOperation is a closed union and
  // findControlTargets declares that it accepts it. A member the guard rejects is
  // a tool that cannot work, so this is asserted over the union rather than over a
  // hand-picked list that could go stale the same way the guard did.
  const OPERATIONS = Object.freeze([
    "forget", "lift", "confirm", "explain", "correct", "pin", "unpin",
  ] as const);

  it("does not reject any operation in its own declared type", async () => {
    const principalId = await seedPrincipal();
    for (const operation of OPERATIONS) {
      // No query and no turnId, so the call returns before it touches the ledger:
      // what is under test is the guard, not the selection.
      await expect(retriever().findControlTargets({
        principalId,
        operation,
        query: null,
      })).resolves.toEqual([]);
    }
  });

  it("still refuses an operation outside the type", async () => {
    // The guard is not deleted, it is corrected. An unlisted operation is still a
    // programming error rather than an empty result.
    const principalId = await seedPrincipal();
    await expect(retriever().findControlTargets({
      principalId,
      operation: "teleport" as never,
      query: null,
    })).rejects.toThrow("telegram_memory_target_invalid");
  });
});
