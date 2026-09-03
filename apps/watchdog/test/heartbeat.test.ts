import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { applyLivenessSchema, clearLivenessTables } from "./liveness-schema.js";
import { componentRows, seedComponent } from "./support.js";

/**
 * A constructed Request, retyped as the incoming one the handler declares.
 *
 * `new Request(...)` produces Request<unknown, CfProperties>; an ExportedHandler
 * is declared with IncomingRequestCfProperties, which only the runtime can
 * populate. The cast is at the boundary and changes nothing the handler reads.
 */
function incoming(request: Request): Parameters<typeof worker.fetch>[0] {
  return request as Parameters<typeof worker.fetch>[0];
}


const SECRET = "watchdog-heartbeat-secret-value";

function environment(overrides: Partial<Env> = {}): Env {
  return { DB: testEnv.DB, WATCHDOG_HEARTBEAT_SECRET: SECRET, ...overrides };
}

async function post(
  body: unknown,
  init: { authorization?: string | null; method?: string; raw?: string; environment?: Env } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.authorization !== null) headers.set("authorization", init.authorization ?? `Bearer ${SECRET}`);

  const request = new Request("https://watchdog.example/heartbeat", {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" ? undefined : (init.raw ?? JSON.stringify(body)),
  });

  // No execution context: the watchdog's fetch handler takes none. Nothing it
  // serves is deferred past the response, so there is no waitUntil work for a
  // test to wait on.
  return worker.fetch(incoming(request), init.environment ?? environment());
}

async function reasonOf(response: Response): Promise<string> {
  return String(((await response.json()) as { reason?: unknown }).reason);
}

describe("POST /heartbeat", () => {
  beforeEach(async () => {
    await applyLivenessSchema();
    await clearLivenessTables();
  });

  it("records the heartbeat of a component presenting the shared secret", async () => {
    const response = await post({ component: "local-agent", expectedIntervalSeconds: 3600 });

    expect(response.status).toBe(200);
    const rows = await componentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      component: "local-agent",
      expected_interval_seconds: 3600,
      detail: null,
      suppressed_until: null,
    });
    expect(Number.isFinite(Date.parse(rows[0]!.last_seen_at))).toBe(true);
  });

  it("rejects an unauthenticated heartbeat and records nothing", async () => {
    // The whole reason the endpoint is authenticated. Anything that can make a
    // component look alive can silence the watchdog for that component, and a
    // silenced watchdog answers "fine" in the same words it uses when the
    // system really is fine.
    const response = await post({ component: "local-agent", expectedIntervalSeconds: 3600 }, {
      authorization: null,
    });

    expect(response.status).toBe(401);
    expect(await reasonOf(response)).toBe("unauthenticated");
    expect(await componentRows()).toEqual([]);
  });

  it("rejects a heartbeat presenting the wrong secret and records nothing", async () => {
    const response = await post({ component: "local-agent", expectedIntervalSeconds: 3600 }, {
      authorization: `Bearer ${SECRET.slice(0, -1)}X`,
    });

    expect(response.status).toBe(401);
    expect(await componentRows()).toEqual([]);
  });

  it("rejects a heartbeat presenting a correct prefix of the secret", async () => {
    const response = await post({ component: "local-agent", expectedIntervalSeconds: 3600 }, {
      authorization: `Bearer ${SECRET.slice(0, 8)}`,
    });

    expect(response.status).toBe(401);
    expect(await componentRows()).toEqual([]);
  });

  it("refuses the endpoint entirely when no secret is configured", async () => {
    // Not left open, and not left comparing against an empty string -- an
    // empty configured secret equals an absent credential and authenticates
    // everyone.
    const response = await post({ component: "local-agent", expectedIntervalSeconds: 3600 }, {
      environment: environment({ WATCHDOG_HEARTBEAT_SECRET: undefined }),
      authorization: "Bearer ",
    });

    expect(response.status).toBe(503);
    expect(await reasonOf(response)).toBe("heartbeat_secret_not_configured");
    expect(await componentRows()).toEqual([]);
  });

  it("refuses the endpoint when the database is not bound", async () => {
    const response = await post({ component: "local-agent", expectedIntervalSeconds: 3600 }, {
      environment: { WATCHDOG_HEARTBEAT_SECRET: SECRET },
    });

    expect(response.status).toBe(503);
    expect(await reasonOf(response)).toBe("database_not_bound");
  });

  it("rejects a heartbeat sent by any method other than POST", async () => {
    expect((await post(null, { method: "GET" })).status).toBe(405);
  });

  it("moves an existing component's last seen time forward", async () => {
    await seedComponent({ component: "local-agent", lastSeenAt: "2026-09-02T10:00:00.000Z" });

    await post({ component: "local-agent", expectedIntervalSeconds: 3600 });

    const rows = await componentRows();
    expect(rows).toHaveLength(1);
    expect(Date.parse(rows[0]!.last_seen_at)).toBeGreaterThan(Date.parse("2026-09-02T10:00:00.000Z"));
  });

  it("clears a suppression window when the component reports in again", async () => {
    // The migration's own rule: suppression is set while a component is
    // knowingly down, and cleared by the next heartbeat.
    await seedComponent({
      component: "local-agent",
      lastSeenAt: "2026-09-02T10:00:00.000Z",
      suppressedUntil: "2099-01-01T00:00:00.000Z",
    });

    await post({ component: "local-agent", expectedIntervalSeconds: 3600 });

    expect((await componentRows())[0]?.suppressed_until).toBeNull();
  });

  it("refuses a heartbeat that tries to declare its own suppression window", async () => {
    // Refused rather than ignored. A component that sent this and got a 200
    // would believe it had arranged a maintenance window that does not exist,
    // and letting it work would hand every component a switch for turning off
    // the alerting about itself.
    const response = await post({
      component: "local-agent",
      expectedIntervalSeconds: 3600,
      suppressedUntil: "2099-01-01T00:00:00.000Z",
    });

    expect(response.status).toBe(400);
    expect(await reasonOf(response)).toBe("invalid_heartbeat");
    expect(await componentRows()).toEqual([]);
  });

  it("refuses an interval long enough to switch off the alerting for a component", async () => {
    const response = await post({ component: "local-agent", expectedIntervalSeconds: 31_536_000 });

    expect(response.status).toBe(400);
    expect(await componentRows()).toEqual([]);
  });

  it("accepts an interval long enough for a component that sleeps overnight", async () => {
    // The upper bound has to leave room for the case the per-component
    // interval exists for.
    expect((await post({ component: "local-agent", expectedIntervalSeconds: 57_600 })).status).toBe(200);
  });

  it("refuses each malformed heartbeat rather than writing a row the schema would reject", async () => {
    // One violation per request. A body breaking several rules at once trips
    // whichever check runs first and leaves the others unpinned.
    const rejected = [
      { component: "", expectedIntervalSeconds: 300 },
      { component: "x".repeat(65), expectedIntervalSeconds: 300 },
      { component: "local-agent", expectedIntervalSeconds: 0 },
      { component: "local-agent", expectedIntervalSeconds: -300 },
      { component: "local-agent", expectedIntervalSeconds: 1.5 },
      { component: "local-agent", expectedIntervalSeconds: "300" },
      { component: "local-agent" },
      { expectedIntervalSeconds: 300 },
      { component: "local-agent", expectedIntervalSeconds: 300, detail: "d".repeat(257) },
      { component: "local-agent", expectedIntervalSeconds: 300, detail: 7 },
    ];

    for (const body of rejected) {
      const response = await post(body);
      expect([body, response.status]).toEqual([body, 400]);
    }
    expect(await componentRows()).toEqual([]);
  });

  it("accepts a short structural detail alongside the heartbeat", async () => {
    await post({ component: "local-agent", expectedIntervalSeconds: 3600, detail: "v1.4.2 cycle=88" });
    expect((await componentRows())[0]?.detail).toBe("v1.4.2 cycle=88");
  });

  it("refuses a body it cannot read as JSON", async () => {
    const response = await post(null, { raw: "{not json" });
    expect(response.status).toBe(400);
    expect(await reasonOf(response)).toBe("unreadable_body");
  });

  it("refuses a body far larger than any heartbeat", async () => {
    const response = await post(null, {
      raw: JSON.stringify({ component: "local-agent", expectedIntervalSeconds: 300, detail: "d".repeat(4000) }),
    });
    expect(response.status).toBe(413);
    expect(await componentRows()).toEqual([]);
  });

  it("does not serve any path it was not given", async () => {
    const request = new Request("https://watchdog.example/", { method: "GET" });
    const response = await worker.fetch(incoming(request), environment());
    expect(response.status).toBe(404);
  });
});

/**
 * The shape the cloud gateway's own sender puts on the wire.
 *
 * Transcribed from apps/cloud-gateway/src/scheduler/heartbeat-reporter.ts, not
 * imported from it -- importing would put the gateway's tree in this app's
 * build graph, which is the one thing this app must never depend on. The cost
 * is that a change to that sender does not break this test until someone
 * transcribes it again, so this is the pair of files to keep in step.
 *
 * The gateway treats any non-2xx as `rejected` and never fails the job it was
 * reporting for, so a mismatch here does not show up as an error over there.
 * It shows up as a component that is quietly never seen alive, and then as an
 * alert about a component that is fine.
 */
function gatewayStyleRequest(report: {
  component: string;
  expectedIntervalSeconds: number;
  detail?: string;
}): Request {
  return new Request("https://watchdog.example/heartbeat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify({
      component: report.component,
      expectedIntervalSeconds: report.expectedIntervalSeconds,
      ...(report.detail === undefined ? {} : { detail: report.detail }),
    }),
  });
}

describe("the wire shape the cloud gateway's heartbeat reporter sends", () => {
  beforeEach(async () => {
    await applyLivenessSchema();
    await clearLivenessTables();
  });

  it("accepts a heartbeat with no detail, which is what the reporter sends when it has none", async () => {
    const response = await worker.fetch(
      incoming(gatewayStyleRequest({ component: "cloud-gateway", expectedIntervalSeconds: 900 })),
      environment(),
    );

    expect(response.ok).toBe(true);
    expect((await componentRows())[0]).toMatchObject({
      component: "cloud-gateway",
      expected_interval_seconds: 900,
      detail: null,
    });
  });

  it("accepts a heartbeat carrying the reporter's short structural detail", async () => {
    const response = await worker.fetch(
      incoming(gatewayStyleRequest({
        component: "cloud-gateway",
        expectedIntervalSeconds: 900,
        detail: "digest=ok turns=12",
      })),
      environment(),
    );

    expect(response.ok).toBe(true);
    expect((await componentRows())[0]?.detail).toBe("digest=ok turns=12");
  });

  it("answers 2xx, because the reporter reads anything else as a rejection", async () => {
    const response = await worker.fetch(
      incoming(gatewayStyleRequest({ component: "cloud-gateway", expectedIntervalSeconds: 900 })),
      environment(),
    );

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
  });
});
