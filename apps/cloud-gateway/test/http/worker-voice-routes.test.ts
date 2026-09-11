import { describe, expect, it } from "vitest";
import worker from "../../src/index.js";

async function dispatch(request: Request): Promise<Response> {
  const fetch = worker.fetch as unknown as (candidate: Request) => Response | Promise<Response>;
  return fetch(request);
}

describe("cloud gateway Worker voice routes", () => {
  it("passes an unknown voice path through the voice router", async () => {
    const response = await dispatch(new Request("https://worker.internal/voice/unknown"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("not_found");
  });

  it("fails a recognized voice path closed when runtime dependencies are unavailable", async () => {
    const response = await dispatch(new Request("https://worker.internal/voice/inbound", { method: "POST" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("unavailable");
  });

  it("preserves the existing 501 skeleton outside the voice route namespace", async () => {
    const response = await dispatch(new Request("https://worker.internal/not-implemented"));

    expect(response.status).toBe(501);
    await expect(response.text()).resolves.toBe("Not implemented");
  });
});
