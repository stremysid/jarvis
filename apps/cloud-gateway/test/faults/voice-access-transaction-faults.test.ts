import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import {
  clearVoiceAccessFixture,
  seedOwnerAuthority,
  validCreateInput,
} from "../persistence/voice-access-fixture.js";

describe("voice access transaction faults", () => {
  beforeEach(() => clearVoiceAccessFixture(env.DB));
  afterEach(() => clearVoiceAccessFixture(env.DB));

  it("leaves every guest row absent when the event boundary fails", async () => {
    const ownerAuthority = await seedOwnerAuthority(env.DB);
    const repository = new VoiceAccessRepository(env.DB, {
      beforeEventWrite: () => {
        throw new Error("synthetic_event_fault");
      },
    });

    await expect(repository.createGuestGrant(validCreateInput(ownerAuthority)))
      .rejects.toThrow("synthetic_event_fault");

    const [principals, identities, grants, events] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM principals WHERE principal_id <> 'principal:voice-owner'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities WHERE identity_id <> 'identity:voice-owner'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grant_events").first<{ count: number }>(),
    ]);
    expect([principals?.count, identities?.count, grants?.count, events?.count]).toEqual([0, 0, 0, 0]);
  });
});
