## 2026-09-17 01:40 UTC — Claude Opus 5, PR #84 max review at d461889: changes requested, superseded by the agent-tools design

**Don't merge.** The regex claim guard passes its own tuning corpus, but on fresh text it both misses false claims and mangles honest replies. Sid has since set the direction that Jarvis must understand language through the AI, not phrase rules.
- **Gates at `d461889`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **187 files / 4,972 tests**.
- **Adversarial second reviewer:** `reviewer-tools/pr84-adversarial.md`, tests in `reviewer-tools/pr84/agent/adversarial-pr84.test.ts`. They run through the real owner chain as `index.ts` wires it, with a worker-level check. I re-ran them at this head: **18 of 26 fail**.

**B1 (H1). Fresh false claims still reach Sid: 47 of 67 (main: 52).** They get past the guard through:
- markdown and check marks (`**Emailed Ms. Lee**`, `Step 1 ✔ Emailed Ms. Lee`);
- missing verbs ("I went ahead and let Mom know", "Got you a table at Pai for 7");
- lead-ins ("OK, texting Mom now");
- passives ("Ms. Lee's been emailed", "E-transfer sent to Mom for $40");
- exemption abuse ("I created a draft and sent it to Ms. Lee").

The builder's 0/72 holds only on the corpus the patterns were tuned on.

**B2 (H2). Honest replies are replaced: 32 of 48 (main: 3).** Examples:
- "I'd email Ms. Lee tonight…";
- "I can help you write the email…";
- "Your Waterloo AIF must be submitted by February 1";
- "I'm glad you called your grandma";
- curly-apostrophe denials.

One-sentence advice becomes only the capability line. Measured as wired, the builder's b2r3 benign set is 3/41, not 1/41.

**B3 (H3) and S1 (M1, M2). Code-built receipts are rewritten:**
- the university draft is gutted and flattened;
- the offer "send exactly" instruction is deleted;
- memory remember/forget receipts lose the remembered text;
- the partial school save line is replaced;
- after a closed quiz, school receipts are lost through `collect()`.

**Lows:**
- The appended line can push a reply over Telegram's 4,096-character limit, so nothing arrives.
- The line can appear twice.
- 7 guards have no named test.

**Sound:**
- Receipts can't be forged or reused, since they are object identities in WeakMaps.
- Streaming holds.
- Performance is fine.
- **The PR #75 follow-up tests are good:** all 5 mutations were killed.

**Decision.** No regex round 2. Honesty about actions moves into the agent-tools PR (builder queued, prompt `reviewer-tools/prompts/memory-ai-intent-prompt.txt`):
- The model returns `{reply, claimedActions}` in the same call.
- Code refuses any claimed action without a tool receipt from this turn, and asks once for an honest rewrite.
- Code-built receipt text is shown verbatim, never rescanned.
- The reviewer measures a held-out set against the real model.

That builder cherry-picks `45b7b75` (the #75 follow-up tests). Leave this draft open, unmerged, as the record.

— Claude Opus 5
