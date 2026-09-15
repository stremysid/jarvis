// Append to apps/cloud-gateway/test/voice/call-session-do.test.ts at 623c64a (uses its accessHarness/relaySetup).
// ---- PR40 reverify3 core-level probes (PASS = hole is real) ----
describe("PR40 reverify3 core probes", () => {
  beforeEach(applyCallStepUpTestMigrations);
  afterEach(clearFixture);
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const refusals = (h: { sendNeutralText: { mock: { calls: unknown[][] } } }) =>
    h.sendNeutralText.mock.calls.filter(([t]) => t === OWNER_STEP_UP_REJECTED).length;

  it("Q1c: deadline alarm during a frame-path rejection blocked in binding() completes it twice", async () => {
    const h = await accessHarness("owner", undefined, true);
    await h.instance.handleRelayEvent(relaySetup(h.stored));
    h.advanceTime(60_001);
    const original = OwnerCallStepUpService.prototype.binding;
    let n = 0; let go!: () => void; let hit!: () => void;
    const gate = new Promise<void>((r) => { go = r; }); const reached = new Promise<void>((r) => { hit = r; });
    const spy = vi.spyOn(OwnerCallStepUpService.prototype, "binding").mockImplementation(async function (this: OwnerCallStepUpService, id) {
      if (++n === 1) { hit(); await gate; }
      return original.call(this, id);
    });
    try {
      const frame = h.instance.handleRelayEvent({ type: "prompt", final: true, language: "en-US", text: "hello there" });
      await reached;
      const alarm = h.instance.handleOwnerStepUpAlarm("window", 1);
      await Promise.race([alarm, wait(3_000)]);
      go();
      await frame; await alarm;
      const report = `refusals=${refusals(h)} alerts=${h.ownerStepUpAlert.mock.calls.length} closes=${h.close.mock.calls.length}`;
      expect(h.ownerStepUpAlert.mock.calls.length, report).toBe(2);
      expect(refusals(h), report).toBe(2);
    } finally { go(); spy.mockRestore(); }
  }, 30_000);

  it("Q2c: deadline alarm while the frame-path rejection awaits the alert sink completes it twice", async () => {
    const h = await accessHarness("owner", undefined, true);
    await h.instance.handleRelayEvent(relaySetup(h.stored));
    h.advanceTime(60_001);
    let go!: () => void; let hit!: () => void; let n = 0;
    const gate = new Promise<void>((r) => { go = r; }); const reached = new Promise<void>((r) => { hit = r; });
    h.ownerStepUpAlert.mockImplementation(async () => { if (++n === 1) { hit(); await gate; } });
    try {
      const frame = h.instance.handleRelayEvent({ type: "prompt", final: true, language: "en-US", text: "hello there" });
      await reached;
      expect(h.instance.phase).toBe("rejected");
      const alarm = h.instance.handleOwnerStepUpAlarm("window", 1);
      await Promise.race([alarm, wait(3_000)]);
      go();
      await frame; await alarm;
      const report = `refusals=${refusals(h)} alerts=${h.ownerStepUpAlert.mock.calls.length} closes=${h.close.mock.calls.length}`;
      expect(h.ownerStepUpAlert.mock.calls.length, report).toBe(2);
      expect(refusals(h), report).toBe(2);
    } finally { go(); }
  }, 30_000);

  it("Q3c: a failed final alarm clear makes the retry refuse, end and alert a second time", async () => {
    const h = await accessHarness("owner", undefined, true);
    await h.instance.handleRelayEvent(relaySetup(h.stored));
    h.advanceTime(60_001);
    h.clearOwnerStepUpAlarm.mockRejectedValueOnce(new Error("probe_storage_delete_failed"));
    await expect(h.instance.handleOwnerStepUpAlarm("window", 1)).rejects.toThrow("probe_storage_delete_failed");
    expect(refusals(h)).toBe(1);
    await h.instance.handleOwnerStepUpAlarm("window", 1); // runtime retry, cached core
    const report = `refusals=${refusals(h)} alerts=${h.ownerStepUpAlert.mock.calls.length} closes=${h.close.mock.calls.length}`;
    expect(h.ownerStepUpAlert.mock.calls.length, report).toBe(2);
    expect(refusals(h), report).toBe(2);
  }, 30_000);
});

describe("PR40 reverify3 core probe Q6c", () => {
  beforeEach(applyCallStepUpTestMigrations);
  afterEach(clearFixture);
  it("Q6c: a throwing alarm clear in handleSocketClose skips the pre_auth -> failed transition", async () => {
    const h = await accessHarness("owner", undefined, true);
    await h.instance.handleRelayEvent(relaySetup(h.stored));
    h.clearOwnerStepUpAlarm.mockRejectedValueOnce(new Error("probe_storage_delete_failed"));
    await expect(h.instance.handleSocketClose("socket_closed")).rejects.toThrow("probe_storage_delete_failed");
    expect((await h.repo.getCallSession(h.stored.sessionId))?.phase).toBe("pre_auth");
  }, 30_000);
});
