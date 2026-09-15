
// Reviewer probes (PR #50): each passes when the reported bug exists.
describe("zzreviewerpr50", () => {
  it("H1a remembers a meaning-flipping fragment as an owner-stated fact", async () => {
    const turn = await seedTurn("Remember I don't want to move to Boston.");
    const service = new MemoryOwnerControlsService(env.DB);
    const result = await service.remember(rememberInput(turn, "want to move to Boston"));
    expect(result.item.version.text).toBe("want to move to Boston");
    expect(result.item.version.origin).toBe("authenticated_first_person");
    expect(result.item.version.uncertain).toBe(false);
    expect(result.item.lifecycle.actor).toBe("owner");
  });
  it("H1b remembers a mid-word fragment", async () => {
    const turn = await seedTurn("Remember I prefer teal.");
    const service = new MemoryOwnerControlsService(env.DB);
    const result = await service.remember(rememberInput(turn, "I prefer tea"));
    expect(result.item.version.text).toBe("I prefer tea");
  });
  it("M1 replaying remember after forget returns the hidden text with a Remembered receipt", async () => {
    const turn = await seedTurn("Remember that I prefer dark mode.");
    const service = new MemoryOwnerControlsService(env.DB);
    const input = rememberInput(turn, "I prefer dark mode.");
    const first = await service.remember(input);
    const forgetTurn = await seedTurn("Please forget my dark mode preference.");
    await service.forget({ ownerTurn: forgetTurn.input, candidateItemIds: [first.item.itemId] });
    const replay = await service.remember(input);
    console.log("M1 REPORT", replay.replayed, replay.item.lifecycle.state, replay.receipt);
    expect(replay.replayed).toBe(true);
    expect(replay.item.lifecycle.state).toBe("forgotten");
    expect(JSON.stringify(replay)).toContain("I prefer dark mode.");
    expect(replay.receipt).toMatch(/^Remembered 1 memory/u);
  });
  it("L1 an over-long remember is refused only after a command event is written", async () => {
    const long = `I prefer ${"x".repeat(5000)}.`;
    const turn = await seedTurn(`Remember that ${long}`);
    const service = new MemoryOwnerControlsService(env.DB);
    const before = await commandCount();
    let code = "resolved";
    try { await service.remember(rememberInput(turn, long)); } catch (error) { code = (error as Error).message; }
    console.log("L1 REPORT", code, before, await commandCount());
    expect(code).toBe("memory_refused");
    expect(await commandCount()).toBe(before + 1);
  });
});
