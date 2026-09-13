import assert from "node:assert/strict";
import { test } from "node:test";
import { runVoiceReleaseGate } from "../voice-release-gate.mjs";

test("runs the real fake-suite entry before the retained-evidence audit", () => {
  const observed = [];
  assert.equal(runVoiceReleaseGate((step) => { observed.push(step); return 0; }), 0);
  assert.deepEqual(observed.map((step) => step.name), ["gate_tests", "fake_calls", "live_evidence"]);
  assert.ok(observed[1].args.includes("tests/acceptance/fake/voice-"));
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
