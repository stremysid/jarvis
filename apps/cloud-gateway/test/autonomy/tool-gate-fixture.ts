/**
 * The production tier gate, wired against the test database.
 *
 * Deliberately the real components rather than a permissive stub. A stub would
 * let the whole suite pass while the gate was misconfigured, which is the
 * failure mode this change exists to remove: the service was correct and
 * tested, and nothing asked it. Tests that construct the owner agent therefore
 * exercise the same classification, the same database tiers and the same
 * confirmation lookup that production does.
 *
 * It applies the capability-tier migration first, because the gate denies a
 * capability with no row. That refusal is the fail-closed rule working, so a
 * database without these rows is not a gate to test against -- it would refuse
 * every memory, school, university and study call.
 */

import { applyAutonomyToolCapabilitiesMigration } from "../persistence/migration.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { D1ToolConfirmationStore } from "../../src/autonomy/tool-confirmations.js";
import { ToolAutonomyGate } from "../../src/autonomy/tool-gate.js";

export async function testToolGate(database: D1Database): Promise<ToolAutonomyGate> {
  await applyAutonomyToolCapabilitiesMigration();
  return new ToolAutonomyGate(
    new AutonomyService({ repository: new AutonomyRepository(database) }),
    new D1ToolConfirmationStore(database),
  );
}
