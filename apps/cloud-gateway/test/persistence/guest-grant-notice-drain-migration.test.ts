import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearGuestGrantNoticeDrainStateForTest } from "./migration.js";

describe("guest grant notice drain migration", () => {
  beforeEach(() => clearGuestGrantNoticeDrainStateForTest());
  afterEach(() => clearGuestGrantNoticeDrainStateForTest());

  it("rejects INSERT OR IGNORE and INSERT OR REPLACE collisions on the singleton checkpoint", async () => {
    for (const conflict of ["IGNORE", "REPLACE"] as const) {
      await expect(env.DB.prepare(`INSERT OR ${conflict} INTO guest_grant_notice_drain_state
        SELECT * FROM guest_grant_notice_drain_state WHERE singleton_id = 1`).run())
        .rejects.toThrow("guest_grant_notice_drain_state_invalid");
    }
  });

  it("rejects a cursor rewrite outside a claimed drain run", async () => {
    await expect(env.DB.prepare(`UPDATE guest_grant_notice_drain_state
      SET cursor_created_at = '2026-08-30T12:00:00.000Z',
        cursor_mutation_id = '01k3w1t4000000000000000999'
      WHERE singleton_id = 1`).run())
      .rejects.toThrow("guest_grant_notice_drain_state_transition_invalid");
  });

  it("rejects deletion of the resumable checkpoint", async () => {
    await expect(env.DB.prepare(
      "DELETE FROM guest_grant_notice_drain_state WHERE singleton_id = 1",
    ).run()).rejects.toThrow("guest_grant_notice_drain_state_delete_forbidden");
  });
});
