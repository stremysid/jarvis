import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import {
  SIGNED_REQUEST_HEADER,
  SYNC_ACK_PATH,
  SYNC_PULL_PATH,
  isSyncPath,
} from "../../src/http/sync-routes.js";
import worker from "../../src/index.js";

/**
 * Routing-level behaviour for the sync endpoints.
 *
 * These cover everything decidable before the signature is verified: an
 * unconfigured deployment, a wrong method, a missing or malformed envelope.
 * Each of those is a caller who has not yet proven they are the enrolled
 * device, so none of them may reach the database.
 *
 * The responses are deliberately terse. The verifier distinguishes
 * signature_invalid from device_not_active from nonce_replayed, and echoing
 * that back would tell an attacker which half of a guess was right.
 */

const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function dispatch(request: Request, env: Partial<Env> = {}): Promise<Response> {
  const fetch = worker.fetch as unknown as (
    candidate: Request,
    environment: Partial<Env>,
    context: { waitUntil(promise: Promise<unknown>): void },
  ) => Promise<Response>;
  return fetch(request, env, { waitUntil: () => undefined });
}

function syncRequest(
  path: string,
  { envelope = "{}", body = "{}", method = "POST", withHeader = true } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withHeader) headers[SIGNED_REQUEST_HEADER] = envelope;
  return new Request(`https://worker.internal${path}`, { method, headers, body });
}

describe("sync routes", () => {
  it("recognizes only the two sync paths", () => {
    expect(isSyncPath(SYNC_PULL_PATH)).toBe(true);
    expect(isSyncPath(SYNC_ACK_PATH)).toBe(true);
    expect(isSyncPath("/sync")).toBe(false);
    expect(isSyncPath("/sync/pull/extra")).toBe(false);
  });

  it("reports unconfigured when no continuation secret is set", async () => {
    const response = await dispatch(syncRequest(SYNC_PULL_PATH), {});
    expect(response.status).toBe(503);
  });

  it("treats a wrong-length continuation secret as unconfigured", async () => {
    // Otherwise this surfaces as an opaque construction failure on the first
    // request rather than as the configuration problem it is.
    const response = await dispatch(syncRequest(SYNC_PULL_PATH), {
      SYNC_CONTINUATION_SECRET: btoa("too-short"),
    });
    expect(response.status).toBe(503);
  });

  it("treats a non-base64 continuation secret as unconfigured", async () => {
    const response = await dispatch(syncRequest(SYNC_PULL_PATH), {
      SYNC_CONTINUATION_SECRET: "not base64 at all!!",
    });
    expect(response.status).toBe(503);
  });

  it("refuses a request with no signed envelope", async () => {
    const response = await dispatch(syncRequest(SYNC_PULL_PATH, { withHeader: false }), {
      SYNC_CONTINUATION_SECRET: SECRET,
    });
    expect(response.status).toBe(401);
  });

  it("refuses a malformed envelope before touching the database", async () => {
    // No DB is provided in env, so reaching storage at all would throw rather
    // than return 400.
    const response = await dispatch(syncRequest(SYNC_PULL_PATH, { envelope: "{not json" }), {
      SYNC_CONTINUATION_SECRET: SECRET,
    });
    expect(response.status).toBe(400);
  });

  it.each(["GET", "PUT", "DELETE"])("refuses %s", async (method) => {
    const response = await dispatch(
      new Request(`https://worker.internal${SYNC_PULL_PATH}`, { method }),
      { SYNC_CONTINUATION_SECRET: SECRET },
    );
    expect(response.status).toBe(405);
  });

  it("never echoes the verifier's reason", async () => {
    // signature_invalid, device_not_active and nonce_replayed are useful in
    // logs and dangerous in responses: they tell a caller which half of a
    // guess was right.
    const response = await dispatch(syncRequest(SYNC_PULL_PATH, { envelope: "{not json" }), {
      SYNC_CONTINUATION_SECRET: SECRET,
    });
    const text = await response.text();
    expect(text).not.toMatch(/signature|device_not_active|nonce|audience|expired/);
  });

  it("leaves other routes unchanged", async () => {
    expect((await dispatch(new Request("https://worker.internal/health"))).status).toBe(501);
  });
});
