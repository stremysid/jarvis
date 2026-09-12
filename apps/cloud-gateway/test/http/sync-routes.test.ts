import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../../src/env.js";
import {
  SIGNED_REQUEST_HEADER,
  SYNC_ACK_PATH,
  SYNC_PULL_PATH,
  isSyncPath,
  statusForSyncError,
} from "../../src/http/sync-routes.js";
import { DISTILL_PATH } from "../../src/sync/memory-distill.js";
import { MEMORY_PROJECTION_PATH } from "../../src/sync/memory-projection.js";
import worker from "../../src/index.js";
import { applyFoundationMigration } from "../persistence/migration.js";

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
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
    ]);
  });

  it("recognizes only the signed sync paths", () => {
    expect(isSyncPath(SYNC_PULL_PATH)).toBe(true);
    expect(isSyncPath(SYNC_ACK_PATH)).toBe(true);
    expect(isSyncPath(MEMORY_PROJECTION_PATH)).toBe(true);
    expect(isSyncPath(DISTILL_PATH)).toBe(true);
    expect(isSyncPath("/sync")).toBe(false);
    expect(isSyncPath("/sync/pull/extra")).toBe(false);
  });

  it.each([
    ["signature_invalid", 401],
    ["device_not_active", 401],
    ["device_key_invalid", 401],
    ["audience_mismatch", 401],
    ["signed_request_expired", 401],
    ["replayed_nonce", 401],
    ["consumer_binding_invalid", 403],
    ["device_key_changed", 403],
    ["sync_device_state_changed", 403],
    ["memory_projection_device_state_changed", 403],
    ["memory_projection_page_state_changed", 409],
    ["no such table: request_nonces", 400],
    ["internal signature storage failure", 400],
  ])("maps the exact sync failure %s to %i", (reason, expected) => {
    expect(statusForSyncError(new Error(reason))).toBe(expected);
  });

  it("authenticates distillation before a paid model call", async () => {
    const body = { schemaVersion: "1.0", excerpts: [{
      sourceEventId: "01m1hh9h1yxaeyjgbhfzm4nnth",
      text: "I prefer coffee",
    }] };
    const rawBody = canonicalize(body);
    const envelope = {
      schemaVersion: "1.0",
      deviceId: "device:not-enrolled",
      principalId: "principal:not-enrolled",
      audience: "jarvis-local-agent",
      issuedAt: new Date().toISOString(),
      nonce: btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
      bodyHash: await sha256Hex(rawBody),
      signatureBase64: btoa(String.fromCharCode(...new Uint8Array(64))),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await dispatch(syncRequest(DISTILL_PATH, {
      envelope: JSON.stringify(envelope),
      body: new TextDecoder().decode(rawBody),
    }), { ...env, SYNC_CONTINUATION_SECRET: SECRET, DEEPSEEK_API_KEY: "test-key" });

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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

  it("cancels a streaming request as soon as its body exceeds the signed limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_536));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { cancelled = true; },
    });
    const response = await dispatch(new Request(`https://worker.internal${MEMORY_PROJECTION_PATH}`, {
      method: "POST",
      headers: { [SIGNED_REQUEST_HEADER]: "{}" },
      body,
      duplex: "half",
    } as RequestInit), { SYNC_CONTINUATION_SECRET: SECRET });
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
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
    expect((await dispatch(new Request("https://worker.internal/not-implemented"))).status).toBe(501);
  });
});
