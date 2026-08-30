import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "apps/cloud-gateway/wrangler.toml"
      },
      miniflare: {
        d1Databases: ["DB"],
        r2Buckets: ["ARCHIVE"],
        durableObjects: {
          CALL_SESSION: "CallSessionStub"
        }
      }
    })
  ],
  test: {
    include: ["apps/cloud-gateway/test/**/*.test.ts"],
    passWithNoTests: true
  }
});
