
// Reviewer probes (PR #50 round 2, H1): each passes when a context-flipped sentence is stored as an owner-stated fact.
describe("zzreviewerpr50b", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["conditional", "Remember my plan if Waterloo rejects me. I'll take a gap year.", "I'll take a gap year."],
    ["reported", "Remember what Sam texted me. I'm quitting the team.", "I'm quitting the team."],
    ["retracted", "Remember I failed calculus. Jk.", "I failed calculus."],
  ];
  for (const [name, turnText, quote] of cases) {
    it(`H1-${name} stores a context-flipped sentence as owner-stated`, async () => {
      const turn = await seedTurn(turnText);
      const service = new MemoryOwnerControlsService(env.DB);
      const result = await service.remember(rememberInput(turn, quote));
      expect(result.item.version?.text).toBe(quote);
      expect(result.item.version?.origin).toBe("authenticated_first_person");
      expect(result.item.version?.uncertain).toBe(false);
      expect(result.item.lifecycle.actor).toBe("owner");
    });
  }
});
