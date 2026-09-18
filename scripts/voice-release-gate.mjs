import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const VOICE_FAKE_TEST_FILTERS = Object.freeze([
  "tests/acceptance/fake/voice-",
  "apps/cloud-gateway/test/security/voice-access-authority.test.ts",
  "apps/cloud-gateway/test/security/owner-access-security.test.ts",
  "apps/cloud-gateway/test/security/guest-pin-verifier.test.ts",
  "apps/cloud-gateway/test/security/relay-binding.test.ts",
  "apps/cloud-gateway/test/security/redaction.test.ts",
  "apps/cloud-gateway/test/security/pbkdf2-production-cap.test.ts",
  "apps/cloud-gateway/test/voice/capability-registry.test.ts",
  "apps/cloud-gateway/test/voice/owner-access-service.test.ts",
  "apps/cloud-gateway/test/voice/owner-access-intent.test.ts",
  "apps/cloud-gateway/test/voice/owner-call-step-up-alert.test.ts",
  "apps/cloud-gateway/test/voice/owner-call-pin-speech.test.ts",
  "apps/cloud-gateway/test/voice/owner-sensitive-action.test.ts",
  "apps/cloud-gateway/test/voice/call-session-do.test.ts",
  "apps/cloud-gateway/test/persistence/owner-call-step-up-migration.test.ts",
  "apps/cloud-gateway/test/persistence/owner-sensitive-action-migration.test.ts",
  "apps/cloud-gateway/test/policy/policy-engine.test.ts",
  "apps/cloud-gateway/test/policy/outbound-runtime.test.ts",
  "apps/cloud-gateway/test/calls/outbound-call-dispatcher.test.ts",
  "apps/cloud-gateway/test/channels/telegram-",
  "apps/cloud-gateway/test/channels/command-handler.test.ts",
  "apps/cloud-gateway/test/http/voice-callback-recorder.test.ts",
  "apps/cloud-gateway/test/http/voice-routes.test.ts",
  "apps/cloud-gateway/test/http/voice-route-construction.test.ts",
  "apps/cloud-gateway/test/http/owner-passphrase-routes.test.ts",
  "apps/cloud-gateway/test/providers/twilio.test.ts",
  "apps/cloud-gateway/test/providers/twilio-cleanup-url.test.ts",
  "apps/cloud-gateway/test/providers/conversation-relay.test.ts",
]);

const steps = Object.freeze([
  Object.freeze({ name: "gate_tests", args: ["--test", "scripts/test/voice-release-gate.test.mjs"] }),
  Object.freeze({ name: "fake_calls", args: [
    "node_modules/vitest/vitest.mjs", "--config", "vitest.workspace.ts", "run", "--maxWorkers=1",
    ...VOICE_FAKE_TEST_FILTERS,
  ] }),
  Object.freeze({ name: "live_evidence", args: ["tests/acceptance/live/voice-smoke-cli.mjs", "--audit-evidence"] }),
]);

/** No evidence audit is reached after a failed fake gate. Nothing here runs live calls. */
export function runVoiceReleaseGate(runStep, fakeOnly = false) {
  for (const step of steps) {
    if (fakeOnly && step.name === "live_evidence") break;
    let status;
    try { status = runStep(step); }
    catch { return 1; }
    if (!Number.isInteger(status) || status !== 0) return Number.isInteger(status) && status > 0 ? status : 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== "--fake-only") {
    process.stderr.write("Unsupported voice release gate argument.\n");
    process.exitCode = 2;
  } else {
    // Invoke Node directly: a .cmd shell shim is neither required on Windows
    // nor allowed to reinterpret the fixed argument list.
    process.exitCode = runVoiceReleaseGate((step) => spawnSync(process.execPath, step.args,
      { cwd: root, stdio: "inherit", shell: false }).status, args[0] === "--fake-only");
  }
}
