import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "apps/cloud-gateway/wrangler.toml",
        environment: "test"
      }
    })
  ],
  test: {
    include: [
      "apps/cloud-gateway/test/**/*.test.ts",
      "packages/contracts/test/**/*.test.ts",
      "tests/acceptance/**/*.test.ts"
    ]
  }
});
