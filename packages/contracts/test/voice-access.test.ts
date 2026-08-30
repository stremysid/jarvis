import { describe, expect, it } from "vitest";
import { GUEST_CAPABILITY_IDS, type RelayBinding } from "../src/index.js";

describe("voice access contracts", () => {
  it("publishes one closed duplicate-free capability registry", () => {
    expect(GUEST_CAPABILITY_IDS).toEqual([
      "conversation.basic",
      "research.web",
      "memory.own",
      "reminders.manage",
      "calendar.read",
      "calendar.manage",
      "owner.contact",
      "communications.draft",
      "communications.send",
      "calls.place",
      "files.read",
      "files.write",
      "pc.control",
      "spending.propose",
      "destructive.propose",
    ]);
    expect(new Set(GUEST_CAPABILITY_IDS).size).toBe(GUEST_CAPABILITY_IDS.length);
    expect(GUEST_CAPABILITY_IDS).not.toContain("access.manage");
  });

  it("requires relay bindings to carry exact owner or guest lineage", () => {
    const owner = {
      callSid: `CA${"a".repeat(32)}`,
      principalId: "principal:owner",
      identityId: "identity:owner:voice",
      destinationIdentityId: "identity:owner:voice",
      relayNonce: `${"a".repeat(42)}A`,
      direction: "inbound",
      activationOnly: false,
      activationChallengeId: null,
      accessKind: "owner",
      guestGrantId: null,
      guestGrantVersion: null,
      accessDocumentHash: null,
    } satisfies RelayBinding;

    const guest = {
      ...owner,
      principalId: "principal:guest",
      identityId: "identity:guest:voice",
      destinationIdentityId: "identity:guest:voice",
      accessKind: "guest",
      guestGrantId: "01k3w1t4000000000000000200",
      guestGrantVersion: 1,
      accessDocumentHash: "a".repeat(64),
    } satisfies RelayBinding;

    expect(owner.accessKind).toBe("owner");
    expect(guest.accessKind).toBe("guest");
  });
});
