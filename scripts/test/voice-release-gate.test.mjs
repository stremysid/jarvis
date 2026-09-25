import assert from "node:assert/strict";
import { test } from "node:test";
import { runVoiceReleaseGate } from "../voice-release-gate.mjs";

test("runs the real fake-suite entry before the retained-evidence audit", () => {
  const observed = [];
  assert.equal(runVoiceReleaseGate((step) => { observed.push(step); return 0; }), 0);
  assert.deepEqual(observed.map((step) => step.name), ["gate_tests", "fake_calls", "live_evidence"]);
  // An independent required list: removing a filter from the runner must fail.
  assert.deepEqual(observed[1].args, ["node_modules/vitest/vitest.mjs", "--config", "vitest.workspace.ts", "run", "--maxWorkers=1",
    "tests/acceptance/fake/voice-",
    "apps/cloud-gateway/test/security/voice-access-authority.test.ts",
    "apps/cloud-gateway/test/security/owner-access-security.test.ts",
    "apps/cloud-gateway/test/security/guest-pin-verifier.test.ts",
    "apps/cloud-gateway/test/security/relay-binding.test.ts",
    "apps/cloud-gateway/test/security/redaction.test.ts",
    "apps/cloud-gateway/test/voice/capability-registry.test.ts",
    "apps/cloud-gateway/test/voice/owner-access-service.test.ts",
    "apps/cloud-gateway/test/voice/owner-access-intent.test.ts",
    "apps/cloud-gateway/test/voice/call-session-do.test.ts",
    "apps/cloud-gateway/test/voice/call-session-pin-capture.test.ts",
    "apps/cloud-gateway/test/voice/sensitive-action-pin.test.ts",
    "apps/cloud-gateway/test/voice/pin-capture.test.ts",
    "apps/cloud-gateway/test/voice/owner-call-alerts.test.ts",
    "apps/cloud-gateway/test/autonomy/tier3-pin.test.ts",
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
  assert.deepEqual(observed[2].args, ["tests/acceptance/live/voice-smoke-cli.mjs", "--audit-evidence"]);
});

for (const failedStep of ["gate_tests", "fake_calls", "live_evidence"]) {
  test(`stops at ${failedStep} and preserves its failure instead of reporting a release pass`, () => {
    const observed = [];
    assert.equal(runVoiceReleaseGate((step) => {
      observed.push(step.name);
      return step.name === failedStep ? 7 : 0;
    }), 7);
    assert.equal(observed.at(-1), failedStep);
  });
}

test("permits a fake-only developer run without mistaking it for evidence acceptance", () => {
  const observed = [];
  assert.equal(runVoiceReleaseGate((step) => { observed.push(step.name); return 0; }, true), 0);
  assert.deepEqual(observed, ["gate_tests", "fake_calls"]);
});

test("refuses a process that could not start or did not return an exit status", () => {
  let calls = 0;
  assert.equal(runVoiceReleaseGate(() => { calls += 1; return null; }), 1);
  assert.equal(calls, 1);
  assert.equal(runVoiceReleaseGate(() => { throw new Error("fixture spawn failed"); }), 1);
});
