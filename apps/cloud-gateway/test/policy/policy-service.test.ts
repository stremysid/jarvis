import { describe, expect, it } from "vitest";
import type { ActiveTelegramIdentity, DeviceRepository } from "../../src/persistence/device-repository.js";
import { PolicyService } from "../../src/policy/policy-service.js";

class RecordingIdentityLookup implements Pick<DeviceRepository, "findActiveVerifiedTelegramIdentity"> {
  readonly subjects: string[] = [];

  constructor(
    private readonly result: ActiveTelegramIdentity | null = null,
    private readonly failure?: Error,
  ) {}

  async findActiveVerifiedTelegramIdentity(providerSubject: string): Promise<ActiveTelegramIdentity | null> {
    this.subjects.push(providerSubject);
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

describe("PolicyService.authenticateTelegram", () => {
  it("returns one frozen blocked singleton before reading a user identifier when the webhook secret is not exact true", async () => {
    const identities = new RecordingIdentityLookup();
    const policy = new PolicyService(identities);
    let identifierReads = 0;
    const falseSecret = { webhookSecretValid: false } as Record<string, unknown>;
    Object.defineProperty(falseSecret, "telegramUserId", {
      enumerable: true,
      get: () => {
        identifierReads += 1;
        throw new Error("must not read Telegram subject");
      },
    });

    const first = await policy.authenticateTelegram(falseSecret);
    const second = await policy.authenticateTelegram({ telegramUserId: "424242", webhookSecretValid: 1 as never });

    expect(first).toEqual({ principalId: "", identityState: "blocked" });
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(identifierReads).toBe(0);
    expect(identities.subjects).toEqual([]);
  });

  it("rejects malformed or accessor-bearing input without invoking accessors or querying identities", async () => {
    const identities = new RecordingIdentityLookup();
    const policy = new PolicyService(identities);
    let getterCalls = 0;
    const secretAccessor = { telegramUserId: "424242" } as Record<string, unknown>;
    Object.defineProperty(secretAccessor, "webhookSecretValid", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return true;
      },
    });
    const subjectAccessor = { webhookSecretValid: true } as Record<string, unknown>;
    Object.defineProperty(subjectAccessor, "telegramUserId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "424242";
      },
    });
    const inherited = Object.assign(Object.create({ operator: true }), {
      telegramUserId: "424242",
      webhookSecretValid: true,
    });
    const unknown = { telegramUserId: "424242", webhookSecretValid: true, role: "operator" };
    const missing = { webhookSecretValid: true };
    const symbolField = { telegramUserId: "424242", webhookSecretValid: true } as Record<PropertyKey, unknown>;
    symbolField[Symbol("operator")] = true;
    const hiddenField = { telegramUserId: "424242", webhookSecretValid: true } as Record<string, unknown>;
    Object.defineProperty(hiddenField, "operator", { value: true, enumerable: false });

    const results = await Promise.all([
      policy.authenticateTelegram(null),
      policy.authenticateTelegram(secretAccessor),
      policy.authenticateTelegram(subjectAccessor),
      policy.authenticateTelegram(inherited),
      policy.authenticateTelegram(unknown),
      policy.authenticateTelegram(missing),
      policy.authenticateTelegram(symbolField),
      policy.authenticateTelegram(hiddenField),
    ]);

    expect(results.every((result) => result === results[0])).toBe(true);
    expect(getterCalls).toBe(0);
    expect(identities.subjects).toEqual([]);
  });

  it.each(["", "0424242", "424242\n1", "not-a-telegram-id", "1".repeat(21)])(
    "maps invalid provider subject %j to blocked without leaking validation detail",
    async (telegramUserId) => {
      const identities = new RecordingIdentityLookup();
      const result = await new PolicyService(identities).authenticateTelegram({ telegramUserId, webhookSecretValid: true });

      expect(result).toEqual({ principalId: "", identityState: "blocked" });
      expect(Object.isFrozen(result)).toBe(true);
      expect(identities.subjects).toEqual([]);
    },
  );

  it("maps repository failure, no identity, malformed rows, and a service principal to the same blocked singleton", async () => {
    const service = Object.freeze({ identityId: "identity:service", principalId: "service:one", principalType: "service" as const });
    const malformed = { identityId: "identity:one", principalId: "principal:one", principalType: "human", providerSubject: "424242" } as never;
    const policies = [
      new PolicyService(new RecordingIdentityLookup(null, new Error("database secret detail"))),
      new PolicyService(new RecordingIdentityLookup()),
      new PolicyService(new RecordingIdentityLookup(malformed)),
      new PolicyService(new RecordingIdentityLookup(service)),
    ];

    const results = await Promise.all(policies.map((policy) => policy.authenticateTelegram({ telegramUserId: "424242", webhookSecretValid: true })));

    expect(results.every((result) => result === results[0])).toBe(true);
    expect(results[0]).toEqual({ principalId: "", identityState: "blocked" });
  });

  it("returns only an opaque active human principal authentication with no call authorization", async () => {
    const identity = Object.freeze({ identityId: "identity:telegram", principalId: "principal:one", principalType: "human" as const });
    const result = await new PolicyService(new RecordingIdentityLookup(identity)).authenticateTelegram({
      telegramUserId: "424242",
      webhookSecretValid: true,
    });

    expect(result).toEqual({ principalId: "principal:one", identityState: "active" });
    expect(Reflect.ownKeys(result)).toEqual(["principalId", "identityState"]);
    expect(JSON.stringify(result)).not.toContain("424242");
    expect(JSON.stringify(result)).not.toContain("identity:telegram");
    expect("capability" in result).toBe(false);
    expect("callAuthorization" in result).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("copies captured identity descriptors without rereading a dependency object", async () => {
    let propertyReads = 0;
    const identity = new Proxy(
      { identityId: "identity:telegram", principalId: "principal:one", principalType: "human" as const },
      {
        get: (target, property, receiver) => {
          if (property === "identityId" || property === "principalId" || property === "principalType") propertyReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = await new PolicyService(new RecordingIdentityLookup(identity)).authenticateTelegram({
      telegramUserId: "424242",
      webhookSecretValid: true,
    });

    expect(result).toEqual({ principalId: "principal:one", identityState: "active" });
    expect(propertyReads).toBe(0);
  });
});
