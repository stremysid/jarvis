import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The watchdog's own Vitest config, not the repository's workspace config.
 *
 * The root vitest.workspace.ts binds the Workers pool to the cloud gateway's
 * wrangler.toml -- its D1 database, its Durable Object, its secrets. Running
 * the watchdog's tests there would give them the gateway's bindings and would
 * make a change to the gateway's test configuration able to break the
 * watchdog's tests. That is the coupling this app exists to avoid, so the
 * watchdog points the pool at its own wrangler.toml instead.
 *
 * No bindings are declared here beyond the D1 database wrangler.toml provides.
 * Every other binding is optional and supplied per test, so a test can ask
 * what happens when the alert path or the heartbeat secret is absent.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.toml",
        environment: "test",
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
