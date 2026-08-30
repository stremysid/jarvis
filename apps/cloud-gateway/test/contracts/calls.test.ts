import { SELF, env } from "cloudflare:test";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  canonicalJson,
  type CallDirection,
  type ExpectedOutboundCall,
  type RelayBinding,
} from "../../../../packages/contracts/src/index.js";

describe("provider-neutral call contracts", () => {
  it("defines an expected outbound call without provider-specific fields", () => {
    const expected = {
      commandId: "01k3s6k8000000000000000001",
      principalId: "principal:sid",
      destinationIdentityId: "identity:sid:voice",
      relayNonce: "relay-nonce",
      nonceExpiresAt: "2026-08-30T12:05:00.000Z",
      authorizationExpiresAt: "2026-08-30T12:05:00.000Z",
      idempotencyKey: "call:one",
    } satisfies ExpectedOutboundCall;

    expect(canonicalJson(expected)).toBe(
      '{"authorizationExpiresAt":"2026-08-30T12:05:00.000Z","commandId":"01k3s6k8000000000000000001","destinationIdentityId":"identity:sid:voice","idempotencyKey":"call:one","nonceExpiresAt":"2026-08-30T12:05:00.000Z","principalId":"principal:sid","relayNonce":"relay-nonce"}',
    );
    expectTypeOf<CallDirection>().toEqualTypeOf<"inbound" | "outbound">();
  });

  it("defines a provider-neutral relay binding with an explicit activation boundary", () => {
    const binding = {
      callSid: "provider-call-reference",
      principalId: "principal:sid",
      identityId: "identity:caller",
      destinationIdentityId: "identity:sid:voice",
      relayNonce: "relay-nonce",
      direction: "inbound",
      activationOnly: true,
      activationChallengeId: "challenge:voice",
      accessKind: "owner",
      guestGrantId: null,
      guestGrantVersion: null,
      accessDocumentHash: null,
    } satisfies RelayBinding;

    expect(canonicalJson(binding)).toBe(
      '{"accessDocumentHash":null,"accessKind":"owner","activationChallengeId":"challenge:voice","activationOnly":true,"callSid":"provider-call-reference","destinationIdentityId":"identity:sid:voice","direction":"inbound","guestGrantId":null,"guestGrantVersion":null,"identityId":"identity:caller","principalId":"principal:sid","relayNonce":"relay-nonce"}',
    );
  });
});

describe("calling entrypoint boundary", () => {
  it("receives only canonical synthetic owner and guest security bindings in tests", () => {
    expect(env.OWNER_VOICE_IDENTITY_ID).toBe("identity:synthetic-owner:voice");
    const privateBindings = [
      env.GUEST_PIN_PEPPER_V1,
      env.AUTHENTICATION_BUDGET_PEPPER,
      env.IDENTITY_CHALLENGE_HMAC_PEPPER,
    ];
    for (const binding of privateBindings) {
      const bytes = Uint8Array.from(atob(binding), (character) => character.charCodeAt(0));
      expect(bytes).toHaveLength(32);
      expect(btoa(String.fromCharCode(...bytes))).toBe(binding);
      bytes.fill(0);
    }
    expect(env.DEFAULT_GUEST_PIN).toMatch(/^[0-9]{4}$/u);
  });

  it("fails closed when voice route dependencies are unavailable", async () => {
    const response = await SELF.fetch("https://jarvis.test/voice/inbound", { method: "POST", body: "untrusted" });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("unavailable");
  });

  it("exports the correctly bound Durable Object as a fail-closed skeleton", async () => {
    const id = env.CALL_SESSION.idFromName("call-session-task-one");
    const response = await env.CALL_SESSION.get(id).fetch("https://call-session.invalid/relay");

    expect(response.status).toBe(501);
    expect(await response.text()).toBe("Not implemented");
  });
});
