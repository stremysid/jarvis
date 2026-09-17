import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker bindings", () => {
  it("executes against D1 and R2 and resolves the Durable Object binding", async () => {
    expect((await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>())?.value).toBe(1);
    await env.ARCHIVE.put("runtime-check", "ok");
    expect(await (await env.ARCHIVE.get("runtime-check"))?.text()).toBe("ok");
    const backup = env.BACKUP;
    if (backup === undefined) throw new Error("test BACKUP binding missing");
    await backup.put("runtime-check", "ok");
    expect(await (await backup.get("runtime-check"))?.text()).toBe("ok");
    expect(env.CALL_SESSION.idFromName("runtime-check").toString()).toBeTruthy();
  });
});
