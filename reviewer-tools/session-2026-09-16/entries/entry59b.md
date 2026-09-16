## 2026-09-16 16:06 UTC — Claude Opus 5, PR #59 round-2 max re-review at 7fd25ff: changes requested

Real progress. The two ways distillation silently stopped learning are fixed and proven, and so are M2–M5 and L3. One High remains, and it is the rule Sid cares about most: a message he *forwards* from someone else can still be filed as his own confirmed words.

**Gates at `7fd25ff`:** lint and typecheck pass. `pnpm test` passed 3,770/3,772; the two failures were 5-second timeouts in `call-session-do.test.ts`, which this PR does not touch, and that file passes 126/126 run alone.

**Mutation pass** (`reviewer-tools/pr59/mut59.json`, `run59.txt`): **23/23 killed by named tests, BASE surviving.**
- all 10 whole-trigger removals, including the recreated `archive_segment_events_no_update`;
- H1: no narrowing, and no irreducible text skip;
- M2: no proposal narrowing, and no irreducible proposal skip;
- H2: counting all events, and one step per poll (killed by `drains multiple production-default steps per hour…`);
- M3: no key retry;
- M1: preceding-attribution check removed (4 named cases fail);
- M5: subject mismatch in code, the trigger subject bound, and set-once;
- M4: terminal-run immutability;
- L3: cursor moving backwards.

**Round-1 status** (second reviewer, `reviewer-tools/pr59b-adversarial.md`, confirmed by my own reading): H1, H2, M2, M3, M4, M5 and L3 are **fixed in code**. H2 now handles about 64 conversation turns an hour, against 1.6 before. **M1 is only partly fixed.** The three round-1 Lows that pointed at `reviewer-tools/pr59-adversarial.md` cannot be recovered: that report was lost with the session that wrote it, and I won't guess at them. The Lows below replace them.

**H1. A forwarded Telegram message is still filed as Sid's own words.**
- **Where:** `conversation-repository.ts` writes every user turn as `conversation.user_committed` with `historyEligible: true` and no direct/forwarded marker. The Telegram layer knows (`isDirectText`), but that fact never reaches the event distillation reads.
- **Proven:** `isAuthenticatedFirstPersonQuote` returns true for a forwarded message whose text is `I am moving to Calgary in June.`. The event carries nothing that could stop it. The stored outcome (active, not uncertain) is by reading.
- **Decision (reviewer):** distillation must **fail closed**. Treat a turn as `authenticated_first_person` only when its event explicitly records direct owner text. No producer writes that marker yet, so for now every extracted fact from a user turn is stored uncertain. It is still recalled, labelled, and never treated as an instruction. The Telegram composition slice (#62) adds the marker to the conversation payload.

**M1. Replace the attribution verb list with a structural rule.** The list is being out-guessed: the second reviewer got **31 of 42** realistic inputs through. Examples: `Mum sent this. …`, `Mum called. …`, `From Mum. …`, a pasted `Mum: …` chat log, and `… That's what Mum said.` afterwards. It also now demotes Sid's own `I wrote my Western essay.`.
- **Decision (reviewer):** once the direct marker exists, a quote is authenticated first person only when it is the **whole** direct message. Anything else is stored uncertain. Drop the verb list.

**M2. One message with more than four facts is dropped entirely.** `automatic-distillation.test.ts` currently asserts `proposal_budget_exceeded` for it. That is the shape of Sid's planned onboarding interview.
- **Fix:** commit up to four facts per step and continue the same event in the next step. Never skip the event.

**M3. Memory now runs up to 8 steps before the Classroom and Brightspace polls, with no time budget** (`job-table.ts` hourly order).
- **Effect:** with a real model, slow calls can use up the scheduled invocation, and the school checks miss that hour.
- **Fix:** run the school polls first, and stop starting new memory steps after a wall-clock budget. Four minutes is a reasonable ceiling.
- **Also:** don't rely on an unverified D1 per-invocation query allowance. Either cite the current Cloudflare limit in the entry, or keep one invocation's total under 1,000 queries.

**Lows** (fix or record each in `KNOWN_ISSUES.md` with the reason):
- **L1.** A skipped event reads as `nothing_new`, and "events pending" counts raw events, about five per turn. Report skipped-with-reason counts and a backlog of eligible events.
- **L2.** A step can report `succeeded` while the cursor did not move, if the cursor write fails after finalization. The loop then repeats the same window. Break the loop when the cursor did not advance.
- **L3.** A retry after a failed finalize can duplicate facts with a non-deterministic model. Facts committed before the failure stay behind, unattached to any run.
- **L4.** `archive_segment_events` accepts any subject on its first write; only the hash-checked code path protects it.

**Also note for the rollout:** `0026` now alters `archive_segment_events`, a table live since `0001`. It adds a column, drops and recreates an immutability trigger, and backfills. That makes it the first candidate migration that is not purely additive, so the scratch rehearsal must cover it. Say so in the migration's header comment.

**Next.** The same memory-builder session fixes H1 and M1–M3, fixes or records L1–L4, adds the header note, and requests a max re-review. Expect the new rules to be removed one at a time again.

— Claude Opus 5
