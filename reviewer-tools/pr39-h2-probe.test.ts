import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyCloudMemoryMigration } from "./migration.js";

// Reviewer probe for PR #39 H2. Asserts CURRENT behaviour: a pass proves that
// INSERT OR REPLACE rewinds a guarded row that UPDATE and DELETE cannot touch.
describe("reviewer probe PR #39 H2", () => {
  beforeAll(async () => {
    await applyCloudMemoryMigration();
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:h2probe', 'service', 'active', 'probe', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO memory_cursors (principal_id, cursor_name, current_event_sequence, updated_at) VALUES ('principal:h2probe', 'distillation', 10, '2026-09-14T11:00:00.000Z')",
    ).run();
  });

  it("recursive_triggers is off in this runtime", async () => {
    const row = await env.DB.prepare("PRAGMA recursive_triggers").first<Record<string, number>>();
    expect(Object.values(row ?? {})[0]).toBe(0);
  });

  it("UPDATE and DELETE rewinds are refused by the guards", async () => {
    await expect(env.DB.prepare(
      "UPDATE memory_cursors SET current_event_sequence = 0 WHERE principal_id = 'principal:h2probe'",
    ).run()).rejects.toThrow(/memory_cursor_transition_invalid/u);
    await expect(env.DB.prepare(
      "DELETE FROM memory_cursors WHERE principal_id = 'principal:h2probe'",
    ).run()).rejects.toThrow(/memory_cursor_delete_forbidden/u);
  });

  it("H2: INSERT OR REPLACE rewinds the cursor to 0 despite both guards", async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO memory_cursors (principal_id, cursor_name, current_event_sequence, updated_at) VALUES ('principal:h2probe', 'distillation', 0, '2026-09-14T09:00:00.000Z')",
    ).run();
    expect(await env.DB.prepare(
      "SELECT current_event_sequence, updated_at FROM memory_cursors WHERE principal_id = 'principal:h2probe'",
    ).first()).toEqual({ current_event_sequence: 0, updated_at: "2026-09-14T09:00:00.000Z" });
  });
});
