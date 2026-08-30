import { describe, expect, it } from "vitest";
import {
  handleLiveness,
  handleReadiness,
  type LivenessDependencies,
  type ReadinessDependencies,
  type ReadinessSnapshotV1,
} from "../../src/http/health.js";

async function responseShape(response: Response) {
  return { status: response.status, body: await response.text() };
}

function dependencies(overrides: Partial<LivenessDependencies> = {}): LivenessDependencies {
  return {
    rateLimiter: { allow: () => true },
    availability: "available",
    ...overrides,
  };
}

describe("handleLiveness", () => {
  it("returns only the exact healthy public response", async () => {
    await expect(responseShape(await handleLiveness(dependencies()))).resolves.toEqual({
      status: 200,
      body: "ok",
    });
  });

  it("returns only unavailable with 503 for a coarse dependency failure", async () => {
    await expect(responseShape(await handleLiveness(dependencies({ availability: "unavailable" })))).resolves.toEqual({
      status: 503,
      body: "unavailable",
    });
  });

  it("returns only unavailable with 429 for an explicit rate-limit decision", async () => {
    const response = await handleLiveness(dependencies({
      rateLimiter: { allow: () => false },
    }));

    expect(await responseShape(response)).toEqual({ status: 429, body: "unavailable" });
  });

  it("never reflects limiter or dependency failures", async () => {
    const limiterFailure = await handleLiveness(dependencies({
      rateLimiter: { allow: () => { throw new Error("redis password=secret"); } },
    }));
    const throwingSnapshot = dependencies();
    Object.defineProperty(throwingSnapshot, "availability", {
      enumerable: true,
      get: () => { throw new Error("provider token=secret"); },
    });
    const dependencyFailure = await handleLiveness(throwingSnapshot);
    const malformed = await handleLiveness(dependencies({ availability: "provider offline: secret" as never }));
    const malformedLimiter = await handleLiveness(dependencies({
      rateLimiter: { allow: () => "yes" as never },
    }));

    expect(await responseShape(limiterFailure)).toEqual({ status: 503, body: "unavailable" });
    expect(await responseShape(dependencyFailure)).toEqual({ status: 503, body: "unavailable" });
    expect(await responseShape(malformed)).toEqual({ status: 503, body: "unavailable" });
    expect(await responseShape(malformedLimiter)).toEqual({ status: 503, body: "unavailable" });
  });
});

const operatorRequest = Object.freeze({ request: "signed readiness request" }) as never;

function healthyReadiness(overrides: Partial<ReadinessSnapshotV1> = {}): ReadinessSnapshotV1 {
  return {
    schemaVersion: "1.0",
    components: {
      database: "ready",
      archive: "ready",
      sync: "ready",
      policy: "ready",
    },
    queueDepth: 7,
    syncLagSeconds: 42,
    capacityCategory: "normal",
    ...overrides,
  };
}

function readinessDependencies(input: {
  authorize?: () => unknown | Promise<unknown>;
  read?: () => unknown | Promise<unknown>;
} = {}): ReadinessDependencies {
  return {
    authorizer: {
      requireEnrolledOperator: async () => input.authorize === undefined
        ? Object.freeze({ operatorId: "principal:one" })
        : input.authorize(),
    },
    snapshotReader: {
      read: input.read ?? (() => healthyReadiness()),
    },
  } as ReadinessDependencies;
}

async function exactResponse(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers.entries()].sort(([left], [right]) => left.localeCompare(right))),
    body: await response.text(),
  };
}

describe("handleReadiness", () => {
  it("completes enrolled-operator authorization before obtaining or inspecting the snapshot reader", async () => {
    const order: string[] = [];
    const dependencies = {
      authorizer: {
        requireEnrolledOperator: async () => {
          order.push("authorized");
          return Object.freeze({ operatorId: "principal:one" });
        },
      },
    } as unknown as ReadinessDependencies;
    Object.defineProperty(dependencies, "snapshotReader", {
      enumerable: true,
      get: () => {
        order.push("reader-obtained");
        return { read: () => { order.push("snapshot-read"); return healthyReadiness(); } };
      },
    });

    const response = await handleReadiness(operatorRequest, dependencies);

    expect(response.status).toBe(200);
    expect(order).toEqual(["authorized", "reader-obtained", "snapshot-read"]);
  });

  it("returns byte-identical non-diagnostic 401 responses and performs zero snapshot access for every authorization failure", async () => {
    let authorizationGetterCalls = 0;
    const accessorProof = {} as Record<string, unknown>;
    Object.defineProperty(accessorProof, "operatorId", {
      enumerable: true,
      get: () => {
        authorizationGetterCalls += 1;
        return "principal:one";
      },
    });
    const failures = [
      () => { throw new Error("forged signature with secret detail"); },
      () => Promise.reject(new Error("replayed nonce with device identifier")),
      () => undefined,
      () => ({ operatorId: "principal:one", role: "admin" }),
      () => accessorProof,
    ];
    const outputs = [];
    let snapshotAccesses = 0;

    for (const authorize of failures) {
      const dependencies = { authorizer: { requireEnrolledOperator: authorize } } as unknown as ReadinessDependencies;
      Object.defineProperty(dependencies, "snapshotReader", {
        enumerable: true,
        get: () => {
          snapshotAccesses += 1;
          throw new Error("must not obtain snapshot reader");
        },
      });
      outputs.push(await exactResponse(await handleReadiness(operatorRequest, dependencies)));
    }

    expect(outputs).toEqual(Array.from({ length: failures.length }, () => ({
      status: 401,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
      body: "unauthorized",
    })));
    expect(authorizationGetterCalls).toBe(0);
    expect(snapshotAccesses).toBe(0);
  });

  it("returns only the exact versioned readiness allowlist from a copied snapshot", async () => {
    const source = healthyReadiness({
      components: {
        database: "ready",
        archive: "degraded",
        sync: "ready",
        policy: "degraded",
      },
      queueDepth: 10_000,
      syncLagSeconds: 2_592_000,
      capacityCategory: "elevated",
    });
    const response = await handleReadiness(operatorRequest, readinessDependencies({ read: () => source }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body).toBe('{"capacityCategory":"elevated","components":{"archive":"degraded","database":"ready","policy":"degraded","sync":"ready"},"queueDepth":10000,"schemaVersion":"1.0","syncLagSeconds":2592000}');
    expect(JSON.parse(body)).toEqual(source);
    expect(body).not.toContain("principal:one");
  });

  it.each([
    ["an unavailable component", healthyReadiness({ components: { ...healthyReadiness().components, archive: "unavailable" } })],
    ["critical capacity", healthyReadiness({ capacityCategory: "critical" })],
  ])("returns canonical authorized diagnostics with 503 for %s", async (_label, snapshot) => {
    const response = await handleReadiness(operatorRequest, readinessDependencies({ read: () => snapshot }));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(body)).toEqual(snapshot);
    expect(body).not.toContain("principal:one");
  });

  it("rejects unknown, inherited, symbol, non-enumerable, and accessor snapshot fields without evaluating accessors", async () => {
    let getterCalls = 0;
    const accessorComponents = {
      database: "ready",
      archive: "ready",
      sync: "ready",
    } as Record<string, unknown>;
    Object.defineProperty(accessorComponents, "policy", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "ready";
      },
    });
    const inherited = Object.assign(Object.create({ providerBody: "token=secret" }), healthyReadiness());
    const withSymbol = healthyReadiness() as ReadinessSnapshotV1 & { [key: symbol]: string };
    withSymbol[Symbol("secret")] = "secret";
    const nonEnumerable = healthyReadiness() as ReadinessSnapshotV1 & { providerError?: string };
    Object.defineProperty(nonEnumerable, "providerError", { value: "token=secret", enumerable: false });
    const nestedUnknown = { ...healthyReadiness().components, providerBody: "token=secret" };
    const { policy: _omittedPolicy, ...nestedMissing } = healthyReadiness().components;
    const nestedSymbol = { ...healthyReadiness().components } as Record<PropertyKey, unknown>;
    nestedSymbol[Symbol("secret")] = "secret";
    const nestedHidden = { ...healthyReadiness().components } as Record<string, unknown>;
    Object.defineProperty(nestedHidden, "providerError", { value: "token=secret", enumerable: false });
    const nestedInherited = Object.assign(Object.create({ providerBody: "token=secret" }), healthyReadiness().components);
    const { queueDepth: _omittedQueueDepth, ...topLevelMissing } = healthyReadiness();
    const topLevelAccessor = { ...healthyReadiness() } as Record<string, unknown>;
    Object.defineProperty(topLevelAccessor, "queueDepth", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 7;
      },
    });
    const cases = [
      healthyReadiness({ components: accessorComponents as never }),
      { ...healthyReadiness(), providerBody: "token=secret" },
      topLevelMissing,
      inherited,
      withSymbol,
      nonEnumerable,
      healthyReadiness({ components: nestedUnknown as never }),
      healthyReadiness({ components: nestedMissing as never }),
      healthyReadiness({ components: nestedSymbol as never }),
      healthyReadiness({ components: nestedHidden as never }),
      healthyReadiness({ components: nestedInherited as never }),
      topLevelAccessor,
    ];

    for (const snapshot of cases) {
      await expect(exactResponse(await handleReadiness(operatorRequest, readinessDependencies({ read: () => snapshot })))).resolves.toMatchObject({
        status: 503,
        body: "unavailable",
      });
    }
    expect(getterCalls).toBe(0);
  });

  it.each([
    ["null", null],
    ["wrong schema", healthyReadiness({ schemaVersion: "2.0" as never })],
    ["negative queue", healthyReadiness({ queueDepth: -1 })],
    ["negative-zero queue", healthyReadiness({ queueDepth: -0 })],
    ["fractional queue", healthyReadiness({ queueDepth: 1.5 })],
    ["oversized queue", healthyReadiness({ queueDepth: 10_001 })],
    ["non-finite queue", healthyReadiness({ queueDepth: Number.POSITIVE_INFINITY })],
    ["negative sync lag", healthyReadiness({ syncLagSeconds: -1 })],
    ["negative-zero sync lag", healthyReadiness({ syncLagSeconds: -0 })],
    ["fractional sync lag", healthyReadiness({ syncLagSeconds: 1.5 })],
    ["oversized sync lag", healthyReadiness({ syncLagSeconds: 2_592_001 })],
    ["non-finite sync lag", healthyReadiness({ syncLagSeconds: Number.POSITIVE_INFINITY })],
    ["unknown capacity", healthyReadiness({ capacityCategory: "provider-token-secret" as never })],
  ])("returns exact 503 unavailable for %s snapshot state", async (_label, snapshot) => {
    await expect(exactResponse(await handleReadiness(operatorRequest, readinessDependencies({ read: () => snapshot })))).resolves.toEqual({
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
      body: "unavailable",
    });
  });

  it("never reflects snapshot-reader errors or malformed reader accessors", async () => {
    const throwing = readinessDependencies({ read: () => { throw new Error("provider body token=secret"); } });
    const accessorReader = {
      authorizer: readinessDependencies().authorizer,
      snapshotReader: {},
    } as ReadinessDependencies;
    Object.defineProperty(accessorReader.snapshotReader, "read", {
      enumerable: true,
      get: () => { throw new Error("config secret"); },
    });

    expect(await exactResponse(await handleReadiness(operatorRequest, throwing))).toMatchObject({ status: 503, body: "unavailable" });
    expect(await exactResponse(await handleReadiness(operatorRequest, accessorReader))).toMatchObject({ status: 503, body: "unavailable" });
  });
});
