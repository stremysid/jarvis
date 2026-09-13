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

const socketTest = "tests/acceptance/fake/voice-production-socket.test.ts";
const project = (name: string, include: string[], exclude: string[], bindings: Record<string, string> = {}) => ({
  plugins: [cloudflareTest({
    miniflare: { bindings: { ...syntheticRequiredBindings, DEFAULT_GUEST_PIN: "4827", ...bindings } },
    wrangler: { configPath: "apps/cloud-gateway/wrangler.toml", environment: "test" },
  })],
  test: { name, include, exclude },
});

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { projects: [
    project("default", ["apps/cloud-gateway/test/**/*.test.ts", "packages/contracts/test/**/*.test.ts",
      "tests/acceptance/**/*.test.ts"], [socketTest]),
    // Only this project supplies complete public synthetic runtime bindings.
    // Existing missing-configuration tests retain their original environment.
    project("voice-production-socket", [socketTest], [], {
      OWNER_PRINCIPAL_ID: "principal:owner", OWNER_VOICE_IDENTITY_ID: "identity:voice",
      TWILIO_ACCOUNT_SID: `AC${"6".repeat(32)}`, TWILIO_API_KEY_SID: `SK${"6".repeat(32)}`,
      TWILIO_API_KEY_SECRET: "synthetic-voice-key",
      DEEPSEEK_API_KEY: "synthetic-runtime-key", DEEPSEEK_MODEL: "synthetic-runtime-model",
      TELEGRAM_BOT_TOKEN: `123456789:${"s".repeat(35)}`,
      GUEST_PIN_PEPPER_V1: Buffer.alloc(32, 12).toString("base64"),
      IDENTITY_CHALLENGE_HMAC_KEY_VERSION: "identity-hmac-v1",
      CAPACITY_D1_BUDGET_BYTES: "1000000000", CAPACITY_R2_BUDGET_BYTES: "1000000000",
      CAPACITY_MODEL_ALLOCATION_USD: "20", CAPACITY_MODEL_REQUEST_COST_ASSUMPTION_USD: "0.45",
      CAPACITY_TWILIO_DAILY_BUDGET_USD: "40",
    }),
  ] },
});
