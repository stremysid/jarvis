import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const syntheticPinVerifier = JSON.stringify({
  schemaVersion: "1.0",
  algorithm: "pbkdf2-hmac-sha256",
  iterations: 600_000,
  saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
  digestBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
});
const syntheticPrivateBinding = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// Wrangler validates required secrets before Miniflare applies explicit bindings.
// Force the test process to use the public synthetic fixture, never a developer's real verifier.
process.env.PIN_VERIFIER_JSON = syntheticPinVerifier;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          PIN_VERIFIER_JSON: syntheticPinVerifier,
          OWNER_VOICE_IDENTITY_ID: "identity:synthetic-owner:voice",
          GUEST_PIN_PEPPER_V1: syntheticPrivateBinding,
          AUTHENTICATION_BUDGET_PEPPER: syntheticPrivateBinding,
          IDENTITY_CHALLENGE_HMAC_PEPPER: syntheticPrivateBinding,
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
