import { describe, expect, it } from "vitest";
import { handleLiveness, type LivenessDependencies } from "../../src/http/health.js";

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
