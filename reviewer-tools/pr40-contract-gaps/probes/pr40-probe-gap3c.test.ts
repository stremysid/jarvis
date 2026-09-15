import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";
import { FAKE_OWNER_PASSPHRASE } from "./voice-access-system.js";

// PR40 PROBE ONLY (gap 3c). The admitted phrase is persisted in encodings the contract's
// case-sensitive, bytes-as-numbers sweep cannot read, plus an unspied console method.
function decode(value: unknown): string | null {
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) return new TextDecoder().decode(Uint8Array.from(value as number[]));
  return null;
}

describe("PR40 probe gap 3c: success-path encodings", () => {
  it("the admitted phrase persists as bytes, base64 SHA-256, uppercase and console.dir", async () => {
    const dir = vi.spyOn(console, "dir").mockImplementation(() => undefined);
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt("ABLAZE,  ABRASION!  ABRASIVE.");
      const kv = (await call.durableStorage())["call-session.pr40-success.v1"] as {
        candidateBytes: Uint8Array; digestBase64: string; upperCanonical: string;
      } | undefined;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(FAKE_OWNER_PASSPHRASE)));
      const sqlRows = await call.durableSqlStorage() as Array<Record<string, unknown>>;
      const d1 = await env.DB.prepare("SELECT b FROM pr40_success_blob").all<{ b: unknown }>();
      expect({
        phase: await call.phase(),
        kvBytes: decode(kv?.candidateBytes),
        kvDigestIsBase64Sha256: kv?.digestBase64 === btoa(String.fromCharCode(...digest)),
        kvUpper: kv?.upperCanonical,
        sqlBlob: decode(sqlRows.find((row) => "b" in row)?.b),
        d1Blob: decode(d1.results[0]?.b),
        consoleDir: JSON.stringify(dir.mock.calls).includes(FAKE_OWNER_PASSPHRASE),
      }).toEqual({
        phase: "active",
        kvBytes: FAKE_OWNER_PASSPHRASE,
        kvDigestIsBase64Sha256: true,
        kvUpper: FAKE_OWNER_PASSPHRASE.toUpperCase(),
        sqlBlob: FAKE_OWNER_PASSPHRASE,
        d1Blob: FAKE_OWNER_PASSPHRASE,
        consoleDir: true,
      });
    } finally {
      dir.mockRestore();
      await system.cleanup();
    }
  }, 60_000);
});
