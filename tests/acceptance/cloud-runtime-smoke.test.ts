import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("runs an acceptance smoke check against the Worker D1 binding", async () => {
  expect((await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>())?.value).toBe(1);
});
