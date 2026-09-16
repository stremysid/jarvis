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

  it("keeps ten repeated notice attempts inside the declared D1 statement budget", async () => {
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
});
