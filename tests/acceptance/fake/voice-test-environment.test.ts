import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { readVoiceRuntimeConfiguration } from "../../../apps/cloud-gateway/src/voice/production-runtime.js";

it("keeps the ordinary test environment unconfigured when the socket project is fully configured", () => {
  expect(env.TWILIO_API_KEY_SECRET).toBeUndefined();
  expect(env.CAPACITY_MODEL_ALLOCATION_USD).toBeUndefined();
  expect(() => readVoiceRuntimeConfiguration(env)).toThrow("voice_runtime_configuration_invalid");
});
