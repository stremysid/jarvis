import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1GuestGrantNoticeSink, type GuestGrantNoticeSink } from "../../src/voice/guest-grant-notice.js";
import {
  D1GuestGrantNoticeDrainer,
  GUEST_GRANT_NOTICE_DRAIN_LIMITS,
} from "../../src/jobs/guest-grant-notice-drain.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import {
  clearGuestGrantNoticeDrainStateForTest,
} from "../persistence/migration.js";
import {
  clearVoiceAccessFixture,
  GRANT_ID,
  NOW,
  OWNER_IDENTITY_ID,
  OWNER_PRINCIPAL_ID,
  ROTATED_RECORD,
  SYNTHETIC_RECORD,
  seedOwnerAuthority,
  validCreateInput,
} from "../persistence/voice-access-fixture.js";
import type { PersistedCallAuthority } from "../../src/persistence/voice-access-repository.js";
import type { Sha256Hex, Ulid } from "../../../../packages/contracts/src/index.js";

function queryCountingDatabase(): { readonly database: D1Database; queryCount(): number } {
  let count = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: async <T>(columnName?: string) => {
        count += 1;
        return columnName === undefined ? statement.first<T>() : statement.first<T>(columnName);
      },
      run: async <T>() => { count += 1; return statement.run<T>(); },
      all: async <T>() => { count += 1; return statement.all<T>(); },
      raw: async (options?: { columnNames?: boolean }) => {
        count += 1;
        return options?.columnNames === true ? statement.raw({ columnNames: true }) : statement.raw();
      },
    } as D1PreparedStatement;
    originals.set(wrapped as object, statement);
    return wrapped;
  };
  return {
    database: {
      prepare: (query: string) => wrap(env.DB.prepare(query)),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        count += statements.length;
        return env.DB.batch<T>(statements.map((statement) => originals.get(statement as object) ?? statement));
      },
    } as D1Database,
    queryCount: () => count,
  };
}

const clock = { now: () => new Date(NOW) };
const RUN_ID = "11111111-1111-1111-1111-111111111111";
const TAKEOVER_RUN_ID = "22222222-2222-2222-2222-222222222222";

function timestamp(offsetMs: number): string {
  return new Date(NOW.valueOf() + offsetMs).toISOString();
}

async function claimDrainState(runId = RUN_ID): Promise<void> {
  await env.DB.prepare(`UPDATE guest_grant_notice_drain_state
    SET status = 'running', run_id = ?, lease_expires_at = ?, updated_at = ?, failure_code = NULL
    WHERE singleton_id = 1`).bind(runId, timestamp(240_000), timestamp(0)).run();
}

async function seedNotices(count: number): Promise<readonly Ulid[]> {
  const repository = new VoiceAccessRepository(env.DB);
  const ownerAuthority = await seedOwnerAuthority(env.DB, repository);
  await env.DB.prepare(
    "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:telegram-owner-drain', ?, 'telegram', '12345', 'active', ?, ?)",
  ).bind(OWNER_PRINCIPAL_ID, NOW.toISOString(), NOW.toISOString()).run();
  await repository.createGuestGrant(validCreateInput(ownerAuthority));
  const mutationIds: Ulid[] = [validCreateInput(ownerAuthority).mutationId];
  for (let index = 1; index < count; index += 1) {
    const suffix = String(510 + index).padStart(3, "0");
    const mutationId = `01k3w1t4000000000000000${suffix}` as Ulid;
    await repository.rotatePin({
      mutationId,
      requestHash: ((index % 15) + 1).toString(16).repeat(64) as Sha256Hex,
      ownerAuthority: ownerAuthority as PersistedCallAuthority,
      ownerIdentityId: OWNER_IDENTITY_ID,
      grantId: GRANT_ID,
      expectedGrantVersion: index,
      pinVerifier: index % 2 === 1 ? ROTATED_RECORD : SYNTHETIC_RECORD,
      now: new Date(NOW.valueOf() + index),
    });
    mutationIds.push(mutationId);
  }
  return Object.freeze(mutationIds);
}

describe("D1GuestGrantNoticeDrainer", () => {
  beforeEach(async () => {
    await clearGuestGrantNoticeDrainStateForTest();
    await clearVoiceAccessFixture(env.DB);
  });
  afterEach(async () => {
    await clearGuestGrantNoticeDrainStateForTest();
    await clearVoiceAccessFixture(env.DB);
  });

  it("lets the eleventh notice run first on the next tick after the oldest ten all fail", async () => {
    const mutationIds = await seedNotices(11);
    const attempted: string[] = [];
    const notify = vi.fn<GuestGrantNoticeSink["notify"]>(async ({ mutationId }) => {
      attempted.push(mutationId);
      if (mutationId !== mutationIds[10]) throw new Error("fixture_permanent_failure");
    });
    const drainer = new D1GuestGrantNoticeDrainer(env.DB, { notify }, clock);

    await expect(drainer.run()).resolves.toBe("delivery_deferred");
    expect(attempted).toEqual(mutationIds.slice(0, 10));
    await expect(env.DB.prepare(`SELECT status, cursor_mutation_id, failure_code
      FROM guest_grant_notice_drain_state WHERE singleton_id = 1`).first()).resolves.toEqual({
      status: "failed",
      cursor_mutation_id: mutationIds[9],
      failure_code: "notice_delivery_failed",
    });

    await expect(drainer.run()).resolves.toBe("delivery_deferred");
    expect(attempted[10]).toBe(mutationIds[10]);
  });

  it("reports an overlapping run without notifying while the current lease is active", async () => {
    await seedNotices(1);
    await claimDrainState();
    const notify = vi.fn<GuestGrantNoticeSink["notify"]>();
    const drainer = new D1GuestGrantNoticeDrainer(env.DB, { notify }, clock);

    await expect(drainer.run()).resolves.toBe("already_running");
    expect(notify).not.toHaveBeenCalled();
  });

  it("stops before the next notice when another run takes the lease mid-batch", async () => {
    await seedNotices(2);
    let leaseTaken = false;
    const notify = vi.fn<GuestGrantNoticeSink["notify"]>(async () => {
      if (leaseTaken) return;
      leaseTaken = true;
      await env.DB.prepare(`UPDATE guest_grant_notice_drain_state
        SET status = 'failed', run_id = NULL, lease_expires_at = NULL,
          updated_at = ?, failure_code = 'lease_expired'
        WHERE singleton_id = 1 AND status = 'running'`).bind(timestamp(240_000)).run();
      await env.DB.prepare(`UPDATE guest_grant_notice_drain_state
        SET status = 'running', run_id = ?, lease_expires_at = ?,
          updated_at = ?, failure_code = NULL
        WHERE singleton_id = 1 AND status = 'failed'`)
        .bind(TAKEOVER_RUN_ID, timestamp(480_000), timestamp(240_000)).run();
    });
    const drainer = new D1GuestGrantNoticeDrainer(env.DB, { notify }, clock);

    await expect(drainer.run()).rejects.toThrow("guest_grant_notice_drain_checkpoint_lost");
    expect(notify).toHaveBeenCalledTimes(1);
    await expect(env.DB.prepare(`SELECT status, run_id FROM guest_grant_notice_drain_state
      WHERE singleton_id = 1`).first()).resolves.toEqual({
      status: "running",
      run_id: TAKEOVER_RUN_ID,
    });
  });

  it("does not select a notice held by an active delivery claim", async () => {
    const mutationIds = await seedNotices(2);
    await env.DB.prepare(`UPDATE guest_grant_notices
      SET claim_id = 'active-claim', claim_expires_at = ?
      WHERE mutation_id = ?`).bind(timestamp(60_000), mutationIds[0]).run();
    const notify = vi.fn<GuestGrantNoticeSink["notify"]>();
    const drainer = new D1GuestGrantNoticeDrainer(env.DB, { notify }, clock);

    await expect(drainer.run()).resolves.toBe("completed");
    expect(notify).toHaveBeenCalledExactlyOnceWith({ mutationId: mutationIds[1], now: NOW });
  });

  it("skips an undeliverable notice key while advancing the fair cursor past it", async () => {
    const mutationIds = await seedNotices(1);
    const invalidMutationId = "not-an-ulid";
    await env.DB.prepare(`INSERT INTO voice_access_grant_events (
      event_id, grant_id, grant_version, event_type, owner_identity_id,
      request_hash, capability_ids_json, access_document_hash, created_at
    ) SELECT ?, grant_id, grant_version, event_type, owner_identity_id,
      request_hash, capability_ids_json, access_document_hash, created_at
      FROM voice_access_grant_events WHERE event_id = ?`)
      .bind(invalidMutationId, mutationIds[0]).run();
    await env.DB.prepare(`INSERT INTO guest_grant_notices (
      mutation_id, owner_principal_id, status, claim_id, claim_expires_at,
      provider_message_id, created_at, delivered_at
    ) SELECT ?, owner_principal_id, 'pending', NULL, NULL, NULL, created_at, NULL
      FROM guest_grant_notices WHERE mutation_id = ?`)
      .bind(invalidMutationId, mutationIds[0]).run();
    const attempted: string[] = [];
    const notify = vi.fn<GuestGrantNoticeSink["notify"]>(async ({ mutationId }) => {
      attempted.push(mutationId);
    });
    const drainer = new D1GuestGrantNoticeDrainer(env.DB, { notify }, clock);

    await expect(drainer.run()).resolves.toBe("delivery_deferred");
    expect(attempted).toEqual([mutationIds[0]]);
    await expect(env.DB.prepare(`SELECT cursor_mutation_id FROM guest_grant_notice_drain_state
      WHERE singleton_id = 1`).first("cursor_mutation_id")).resolves.toBe(invalidMutationId);
  });

  it("keeps checkpoint timestamps monotonic when the injected clock moves backward", async () => {
    const mutationIds = await seedNotices(1);
    const earlier = new Date(NOW.valueOf() - 1_000);
    const times = [new Date(NOW), earlier, earlier, earlier];
    const notify = vi.fn<GuestGrantNoticeSink["notify"]>();
    const drainer = new D1GuestGrantNoticeDrainer(
      env.DB,
      { notify },
      { now: () => times.shift() ?? earlier },
    );

    await expect(drainer.run()).resolves.toBe("completed");
    expect(notify).toHaveBeenCalledExactlyOnceWith({ mutationId: mutationIds[0], now: earlier });
    await expect(env.DB.prepare(`SELECT updated_at FROM guest_grant_notice_drain_state
      WHERE singleton_id = 1`).first("updated_at")).resolves.toBe(timestamp(0));
  });

  it("rejects lease-expired failure before the running lease has expired", async () => {
    await claimDrainState();

    await expect(env.DB.prepare(`UPDATE guest_grant_notice_drain_state
      SET status = 'failed', run_id = NULL, lease_expires_at = NULL,
        updated_at = ?, failure_code = 'lease_expired'
      WHERE singleton_id = 1`).bind(timestamp(1_000)).run())
      .rejects.toThrow("guest_grant_notice_drain_state_transition_invalid");
  });

  it("rejects a running cursor that does not name an existing notice", async () => {
    await claimDrainState();

    await expect(env.DB.prepare(`UPDATE guest_grant_notice_drain_state
      SET cursor_created_at = ?, cursor_mutation_id = ?, updated_at = ?
      WHERE singleton_id = 1`).bind(
      timestamp(0),
      "01k3w1t4000000000000000999",
      timestamp(1),
    ).run()).rejects.toThrow("guest_grant_notice_drain_state_transition_invalid");
  });

  it("rejects changing the fair cursor while claiming a failed checkpoint", async () => {
    const mutationIds = await seedNotices(2);
    await claimDrainState();
    await env.DB.prepare(`UPDATE guest_grant_notice_drain_state
      SET cursor_created_at = ?, cursor_mutation_id = ?, updated_at = ?
      WHERE singleton_id = 1`).bind(timestamp(0), mutationIds[0], timestamp(1_000)).run();
    await env.DB.prepare(`UPDATE guest_grant_notice_drain_state
      SET status = 'failed', run_id = NULL, lease_expires_at = NULL,
        updated_at = ?, failure_code = 'notice_delivery_failed'
      WHERE singleton_id = 1`).bind(timestamp(2_000)).run();

    await expect(env.DB.prepare(`UPDATE guest_grant_notice_drain_state
      SET status = 'running', cursor_created_at = ?, cursor_mutation_id = ?,
        run_id = ?, lease_expires_at = ?, updated_at = ?, failure_code = NULL
      WHERE singleton_id = 1`).bind(
      timestamp(1),
      mutationIds[1],
      TAKEOVER_RUN_ID,
      timestamp(600_000),
      timestamp(3_000),
    ).run()).rejects.toThrow("guest_grant_notice_drain_state_transition_invalid");
  });

  it("rejects moving updated_at backward during a running cursor advance", async () => {
    const mutationIds = await seedNotices(1);
    await claimDrainState();

    await expect(env.DB.prepare(`UPDATE guest_grant_notice_drain_state
      SET cursor_created_at = ?, cursor_mutation_id = ?, updated_at = ?
      WHERE singleton_id = 1`).bind(
      timestamp(0),
      mutationIds[0],
      timestamp(-1),
    ).run()).rejects.toThrow("guest_grant_notice_drain_state_transition_invalid");
  });

  it("moves an abandoned running checkpoint to a durable failed state before retrying", async () => {
    await env.DB.prepare(`UPDATE guest_grant_notice_drain_state
      SET status = 'running', run_id = '11111111-1111-1111-1111-111111111111',
        lease_expires_at = '2026-08-30T12:00:01.000Z', updated_at = '2026-08-30T12:00:00.000Z'
      WHERE singleton_id = 1`).run();
    const notify = vi.fn<GuestGrantNoticeSink["notify"]>();
    const drainer = new D1GuestGrantNoticeDrainer(
      env.DB,
      { notify },
      { now: () => new Date("2026-08-30T12:00:02.000Z") },
    );

    await expect(drainer.run()).resolves.toBe("expired_run_recovered");
    expect(notify).not.toHaveBeenCalled();
    await expect(env.DB.prepare(`SELECT status, run_id, lease_expires_at, failure_code
      FROM guest_grant_notice_drain_state WHERE singleton_id = 1`).first()).resolves.toEqual({
      status: "failed",
      run_id: null,
      lease_expires_at: null,
      failure_code: "lease_expired",
    });
  });

  it("takes a fresh clock value for every notice delivered by the fair drainer", async () => {
    const mutationIds = await seedNotices(2);
    const times = [
      new Date(NOW),
      new Date(NOW.valueOf() + 1_000),
      new Date(NOW.valueOf() + 2_000),
      new Date(NOW.valueOf() + 41_000),
      new Date(NOW.valueOf() + 42_000),
      new Date(NOW.valueOf() + 43_000),
    ];
    const notices = new D1GuestGrantNoticeSink(env.DB, {
      sendMessage: vi.fn()
        .mockResolvedValueOnce({ providerMessageId: "901" })
        .mockResolvedValueOnce({ providerMessageId: "902" }),
    });
    const drainer = new D1GuestGrantNoticeDrainer(
      env.DB,
      notices,
      { now: () => times.shift() ?? new Date(NOW.valueOf() + 44_000) },
    );

    await expect(drainer.run()).resolves.toBe("completed");
    await expect(env.DB.prepare(`SELECT mutation_id, delivered_at FROM guest_grant_notices
      ORDER BY mutation_id`).all()).resolves.toMatchObject({ results: [
      { mutation_id: mutationIds[0], delivered_at: "2026-08-30T12:00:01.000Z" },
      { mutation_id: mutationIds[1], delivered_at: "2026-08-30T12:00:41.000Z" },
    ] });
  });

  it("retries an unconfirmed pending notice through the fair drainer", async () => {
    const mutationIds = await seedNotices(1);
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("telegram_unavailable"))
      .mockResolvedValueOnce({ providerMessageId: "902" });
    const notices = new D1GuestGrantNoticeSink(env.DB, { sendMessage });
    const drainer = new D1GuestGrantNoticeDrainer(
      env.DB,
      notices,
      { now: () => new Date(NOW.valueOf() + 1_000) },
    );

    await expect(notices.notify({ mutationId: mutationIds[0], now: NOW }))
      .rejects.toThrow("telegram_unavailable");
    await expect(drainer.run()).resolves.toBe("completed");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[0].idempotencyKey).toBe(sendMessage.mock.calls[1]?.[0].idempotencyKey);
  });

  it("keeps ten failed notice attempts inside the declared D1 statement budget", async () => {
    await seedNotices(10);
    const counted = queryCountingDatabase();
    const notices = new D1GuestGrantNoticeSink(counted.database, {
      sendMessage: async () => ({ providerMessageId: "invalid" }),
    });
    const drainer = new D1GuestGrantNoticeDrainer(counted.database, notices, clock);

    await expect(drainer.run()).resolves.toBe("delivery_deferred");

    expect(GUEST_GRANT_NOTICE_DRAIN_LIMITS).toEqual({ noticesPerRun: 10, d1Statements: 95 });
    expect(counted.queryCount()).toBe(74);
    expect(counted.queryCount()).toBeLessThanOrEqual(GUEST_GRANT_NOTICE_DRAIN_LIMITS.d1Statements);
  });

  it("keeps ten successful notice deliveries inside the declared D1 statement budget", async () => {
    await seedNotices(10);
    const counted = queryCountingDatabase();
    const notices = new D1GuestGrantNoticeSink(counted.database, {
      sendMessage: async () => ({ providerMessageId: "901" }),
    });
    const successfulClock = { now: () => new Date(NOW.valueOf() + 1_000) };
    const drainer = new D1GuestGrantNoticeDrainer(counted.database, notices, successfulClock);

    await expect(drainer.run()).resolves.toBe("completed");

    expect(counted.queryCount()).toBe(74);
    expect(counted.queryCount()).toBeLessThanOrEqual(GUEST_GRANT_NOTICE_DRAIN_LIMITS.d1Statements);
  });
});
