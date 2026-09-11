import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index.js";

let instant = Date.parse("2030-01-01T00:00:00.000Z");
function dispatch(path = "/health", method = "GET") {
  return worker.fetch(new Request(`https://worker.internal${path}`, { method }), env, createExecutionContext());
}

describe("gateway public liveness route", () => {
  beforeEach(() => {
    instant += 86_400_001;
    vi.spyOn(Date, "now").mockReturnValue(instant);
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns only coarse process liveness without querying private state", async () => {
    const database = vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("must not read D1"); });
    const response = await dispatch();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("ok");
    expect(database).not.toHaveBeenCalled();
  });

  it("supports a bodyless HEAD and rejects methods other than GET and HEAD", async () => {
    const head = await dispatch("/health", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await dispatch("/health", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(post.headers.get("cache-control")).toBe("no-store");
  });

  it("limits the route and admits probes again when the minute expires", async () => {
    for (let index = 0; index < 30; index += 1) expect((await dispatch()).status).toBe(200);
    const limited = await dispatch();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.text()).toBe("unavailable");
    vi.mocked(Date.now).mockReturnValue(instant + 60_001);
    expect((await dispatch()).status).toBe(200);
  });

  it("keeps unrelated paths unimplemented", async () => {
    for (const path of ["/health/extra", "/not-implemented"]) {
      const response = await dispatch(path);
      expect(response.status).toBe(501);
      expect(await response.text()).toBe("Not implemented");
    }
  });
});
