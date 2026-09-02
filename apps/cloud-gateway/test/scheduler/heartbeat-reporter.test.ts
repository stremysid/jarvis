import { describe, expect, it, vi } from "vitest";
import {
  heartbeatConfiguration,
  reportHeartbeat,
  type HeartbeatReport,
} from "../../src/scheduler/heartbeat-reporter.js";

/**
 * The failure this file is really about: a heartbeat that succeeds while the
 * work it claims to represent did not.
 *
 * That cannot be tested here, because the ordering lives in the caller. What
 * can be tested is the other half of the contract -- that a watchdog which is
 * down, slow, or rejecting never takes this Worker's real work down with it.
 */

const REPORT: HeartbeatReport = {
  component: "cloud-gateway",
  expectedIntervalSeconds: 900,
  detail: "digest",
};

const CONFIGURED = { url: "https://watchdog.example/heartbeat", secret: "s3cret" };

describe("configuration", () => {
  it("is null when the secret is missing, so an unauthenticated beat is never sent", () => {
    // A rejected heartbeat on every run looks like a broken watchdog rather
    // than a missing secret, and the wrong diagnosis is the expensive part.
    expect(heartbeatConfiguration("https://watchdog.example/heartbeat", undefined)).toBeNull();
  });

  it("is null when the url is missing", () => {
    expect(heartbeatConfiguration(undefined, "s3cret")).toBeNull();
  });

  it("is null when either value is present but empty", () => {
    expect(heartbeatConfiguration("", "s3cret")).toBeNull();
    expect(heartbeatConfiguration("https://watchdog.example/heartbeat", "")).toBeNull();
  });

  it("is the pair when both are present", () => {
    expect(heartbeatConfiguration("https://watchdog.example/heartbeat", "s3cret")).toEqual(CONFIGURED);
  });
});

describe("sending a heartbeat", () => {
  it("posts the component and its expected interval", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const outcome = await reportHeartbeat(REPORT, CONFIGURED, fetcher as unknown as typeof fetch);

    expect(outcome).toEqual({ sent: true });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CONFIGURED.url);
    expect(JSON.parse(String(init.body))).toEqual({
      component: "cloud-gateway",
      expectedIntervalSeconds: 900,
      detail: "digest",
    });
  });

  it("carries the secret in a header rather than the url", async () => {
    // A URL with a secret in it lands in the request logs of both sides.
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await reportHeartbeat(REPORT, CONFIGURED, fetcher as unknown as typeof fetch);

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("s3cret");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer s3cret");
  });

  it("omits the detail entirely when there is none, rather than sending null", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await reportHeartbeat(
      { component: "cloud-gateway", expectedIntervalSeconds: 900 },
      CONFIGURED,
      fetcher as unknown as typeof fetch,
    );
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)))
      .not.toHaveProperty("detail");
  });
});

describe("when the watchdog cannot be reached", () => {
  it("reports unreachable instead of throwing at the job that called it", async () => {
    // The caller is a scheduled job whose real work already succeeded. An
    // exception here has nothing useful it could do except be swallowed.
    const fetcher = vi.fn(async () => {
      throw new TypeError("network error");
    });
    const outcome = await reportHeartbeat(REPORT, CONFIGURED, fetcher as unknown as typeof fetch);
    expect(outcome).toEqual({ sent: false, reason: "unreachable", detail: "network error" });
  });

  it("reports rejected when the watchdog refuses the beat", async () => {
    const fetcher = vi.fn(async () => new Response("no", { status: 401 }));
    const outcome = await reportHeartbeat(REPORT, CONFIGURED, fetcher as unknown as typeof fetch);
    expect(outcome).toEqual({ sent: false, reason: "rejected", detail: "status 401" });
  });

  it("gives up on a watchdog that never answers rather than hanging the job", async () => {
    // A slow watchdog must not become a way to hold a scheduled invocation
    // open until the platform kills it.
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );
      const pending = reportHeartbeat(REPORT, CONFIGURED, fetcher as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(5_000);

      const outcome = await pending;
      expect(outcome.sent).toBe(false);
      expect(outcome.sent === false && outcome.reason).toBe("unreachable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports not_configured rather than quietly doing nothing", async () => {
    // A deployment missing the secret has no liveness monitoring at all. That
    // should be visible here, not only as an absence somewhere else.
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const outcome = await reportHeartbeat(REPORT, null, fetcher as unknown as typeof fetch);

    expect(outcome).toEqual({ sent: false, reason: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
