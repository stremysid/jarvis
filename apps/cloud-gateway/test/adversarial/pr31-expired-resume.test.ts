// PR #31 adversarial suite, attack 5 follow-up: resuming after expiry.
// createOwnerPhoneEnrollmentChallenge treats `meta.changes === 1` on the final INSERT as "created". The
// identity_challenges_reclaim_and_cap BEFORE INSERT trigger deletes the device's expired challenges inside
// that INSERT, and D1 counts those trigger rows, so a committed challenge is reported as not created.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BEGIN, enrollmentEnvironment, KEY_VERSION, OWNER_IDENTITY, resetEnrollmentState, seedDevice, seedPrincipal, send,
  STATUS, type Device,
} from "./pr31-helpers.js";

const T0 = new Date("2026-09-14T16:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0.valueOf() + offsetMs).toISOString();

async function challengeRows() {
  return (await env.DB.prepare(
    "SELECT challenge_id, channel, consumed_at, expires_at FROM identity_challenges ORDER BY created_at, challenge_id",
  ).all<{ challenge_id: string; channel: string; consumed_at: string | null; expires_at: string }>()).results;
}

describe("PR31 adversarial 5a: resuming an expired enrollment", () => {
  let home: Device;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:home", "principal:owner", "key:home");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("MECHANISM an identity_challenges INSERT that reclaims an expired row reports meta.changes = 2", async () => {
    expect((await send(home, BEGIN, enrollmentEnvironment())).status).toBe(200);
    const insert = (challengeId: string, createdAt: string, expiresAt: string) => env.DB.prepare(
      `INSERT INTO identity_challenges (
         challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id,
         initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version,
         expires_at, consumed_at, created_at
       ) VALUES (?, 'principal:owner', ?, 'voice', 'device:home', 'key:home', ?, 1, ?, ?, ?, NULL, ?)`,
    ).bind(challengeId, OWNER_IDENTITY, home.fingerprint, "a".repeat(64), KEY_VERSION, expiresAt, createdAt);

    const [plain] = await env.DB.batch([insert("challenge:probe:1", iso(1_000), iso(301_000))]);
    const [reclaiming] = await env.DB.batch([insert("challenge:probe:2", iso(300_000), iso(600_000))]);

    expect({
      plain: { changes: plain?.meta.changes, rowsWritten: plain?.meta.rows_written },
      reclaiming: { changes: reclaiming?.meta.changes, rowsWritten: reclaiming?.meta.rows_written },
    }).toMatchObject({ plain: { changes: 1 }, reclaiming: { changes: 2 } });
  });

  it("FINDING 5a the runbook's same-phone retry after expiry gets 409, yet commits a fresh challenge nobody was shown", async () => {
    const first = await send(home, BEGIN, enrollmentEnvironment());
    expect(first.status).toBe(200);
    const shown = first.json as { challengeId: string };

    vi.setSystemTime(new Date(T0.valueOf() + 301_000));
    expect((await send(home, STATUS, enrollmentEnvironment())).json).toMatchObject({ enrollmentState: "expired" });

    const retry = await send(home, BEGIN, enrollmentEnvironment());
    expect(retry.status).toBe(409);
    expect(retry.json).toEqual({ error: "owner_phone_enrollment_rejected" });

    const rows = await challengeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.challenge_id).not.toBe(shown.challengeId);
    expect(rows[0]?.consumed_at).toBeNull();
    expect((rows[0]?.expires_at ?? "") > new Date().toISOString()).toBe(true);
    expect((await send(home, STATUS, enrollmentEnvironment())).json).toMatchObject({ enrollmentState: "pending" });

    // Only a second identical retry returns a usable response (nothing left for the trigger to reclaim).
    const again = await send(home, BEGIN, enrollmentEnvironment());
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ enrollmentState: "pending" });
  });

  it("FINDING 5a' a first-ever begin returns 409 while committing the immutable singleton if the device has any expired challenge", async () => {
    // An expired challenge from another flow on the same device, e.g. an old Telegram identity challenge.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO channel_identities
           (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
         VALUES ('identity:telegram-old', 'principal:owner', 'telegram', '424242', 'pending', NULL, ?, 'device:home')`,
      ).bind(iso(-900_000)),
      env.DB.prepare(
        `INSERT INTO identity_challenges (
           challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id,
           initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version,
           expires_at, consumed_at, created_at
         ) VALUES ('challenge:telegram-old', 'principal:owner', 'identity:telegram-old', 'telegram', 'device:home',
           'key:home', ?, 1, ?, ?, ?, NULL, ?)`,
      ).bind(home.fingerprint, "b".repeat(64), KEY_VERSION, iso(-600_000), iso(-900_000)),
    ]);

    const response = await send(home, BEGIN, enrollmentEnvironment());
    expect(response.status).toBe(409);
    expect(await env.DB.prepare("SELECT principal_id, identity_id FROM voice_owner_identity").first())
      .toEqual({ principal_id: "principal:owner", identity_id: OWNER_IDENTITY });
    expect((await challengeRows()).map((row) => row.channel)).toEqual(["voice"]);
    expect((await send(home, STATUS, enrollmentEnvironment())).json).toMatchObject({ enrollmentState: "pending" });
  });
});
