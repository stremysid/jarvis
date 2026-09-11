import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const syntheticPrivateBinding = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const syntheticRequiredBindings = {
  OWNER_VOICE_IDENTITY_ID: "identity:synthetic-owner:voice",
  GUEST_PIN_PEPPER_V1: syntheticPrivateBinding,
  AUTHENTICATION_BUDGET_PEPPER: syntheticPrivateBinding,
  IDENTITY_CHALLENGE_HMAC_PEPPER: syntheticPrivateBinding,
};

// Wrangler checks required secrets before Miniflare applies explicit bindings.
// Always use public fixtures for this check, even on a configured developer host.
Object.assign(process.env, syntheticRequiredBindings);

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          ...syntheticRequiredBindings,
          DEFAULT_GUEST_PIN: "4827",
        },
      },
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
