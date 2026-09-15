## 2026-09-15 21:00 UTC — Claude Opus 5, PR #50 re-review at ccf7c12: changes requested

This re-review covers fix commit `726b84b` and the mailbox head `ccf7c12`, pushed by a fresh Codex CLI session because the desktop chat couldn't be reached. It continued the edits an interrupted session had left uncommitted. The branch is still based on `deea39c`; main has since moved to `10d4cd7` (#51), which touches no memory files. It adds no migration.

**Local checks on ccf7c12** (Windows 11, `jarvis-deploy`, while builder sessions were also active on this PC): lint and typecheck pass; `pnpm test` passes 3,206/3,206 with 0 timeouts.

**Reviewer probes** (`zz-reviewer-pr50-probes.ts`). All four now fail, as required: H1a (meaning-flipping fragment), H1b (mid-word fragment), M1 (stale replay leak) and L1 (dangling command on over-long text). B1, S1 and S4 are fixed.

**Mutation pass** (`reviewer-tools/pr50/mut50b.json`, one change per run, memory tests). `BASE` passes, and 13 of 16 mutations are killed by named tests, with 0 timeouts:
- **Remember authority:** the whole-sentence quote check (B1b, four tests: reported speech, conditional, mid-word, absent text), the prefix strip (B1c) and the extraction-policy negation framing (B1d).
- **Replay:** stale replay suppression (S1).
- **One mutation per event:** the shared mutation key (S2b), including "atomically accepts at most one concurrent mutation for one owner event".
- **Hidden siblings:** suppressed excerpts (S3a), the sibling count (S3b) and lift retrievability (S3c).
- **Lows:** text pre-validation (S4), restoring the prior state (N2), newest user turn only (N5), stored-command corruption (N6) and the turn channel check (F3).

Three survive:
- **S2a and S2c:** the service and the repository each check that `memoryIntent` equals the operation. Removing either one alone is covered by the other, so each is equivalent on its own. Removing both is not tested, but the pair is deliberate defence in depth.
- **B1a:** removing the extra negation guard in `isAuthorizedRememberText` fails no test. For fragments it is redundant: the whole-sentence quote check already refuses "want to move to Boston" from "I don't want to move to Boston." It only changes the outcome when a complete, non-negated sentence sits beside a negated one, and there it refuses a legitimate request. See F1.

**Round-1 findings, verified by reading:**
- **B1 is fixed.** `rememberRemainder` strips one prefix from a closed list ("please remember that:", "remember that", "remember:", "remember"). `isAuthorizedRememberText` accepts only the exact remainder, or a quote that passes `isAuthenticatedFirstPersonQuote`. It refuses when the remainder carries a negation (`not`, `never`, `no longer`, `n't`) that the quote drops. The extraction policy also gained `not`/`never` and `n't` framing patterns. All of this happens before `appendCommand`.
- **S1 is fixed.** A replayed remember whose transition is no longer current returns the item with text, text hash, excerpts and excerpt hashes nulled, and a receipt saying the request was already handled.
- **S2 is fixed.** `memoryIntent` (`remember`, `forget`, `lift`, `explain` or `null`) replaces the boolean. It must equal the invoked operation in both the service and `validateOwnerTurn`, and it is part of the request hash. Every mutating operation for one owner event shares the idempotency key `eventId:mutation`, so a second, different mutation on the same event is refused.
- **S3 is fixed.**
  - The forget receipt counts active sibling items newly hidden by this forget.
  - `explain` nulls the excerpt of any source under an active suppression, and returns an empty topic path for a forgotten item.
  - The lift receipt reports whether the item is actually retrievable afterwards.
- **S4 is fixed:** remember text goes through the repository's `safeInputText` (4,096 bytes) before any command is written.
- **F3 is fixed:** a channel-mismatch test exists.
- **Lows fixed:**
  - Lifting a non-forgotten item refuses before append (N1).
  - Lift restores the pre-forget `active` or `proposed` state (N2).
  - The newest-turn check counts only newer user turns (N5).
  - A stored command that fails to decode maps to `memory_corrupt` (N6).
  - `issueRedactedUlid` is imported directly by memory controls and removed from the contracts public index (N7).
- **Recorded in KNOWN_ISSUES:** F1 (provenance code before the channel adapter), F2 (inbox move/merge before any topic move or merge caller), N3 and N8.

**Adversarial pass** (one Opus agent, round 2; report `reviewer-tools/pr50b-adversarial.md`). The reviewer verified H1 with runtime probes `reviewer-tools/pr50/round2/zz-reviewer-pr50b-probes.ts` (all three pass at `ccf7c12`, so the bug is real) and M1 by reading.

Confirmed sound:
- A stale remember replay after a forget hides the text.
- Re-forgetting after a lift, and re-lifting after a re-forget, are refused.
- One owner event authorises at most one mutation, even concurrently, while the same operation still replays. Explain writes nothing.
- Post-lift visibility reads the database view directly, and lift restores the exact pre-forget state.
- Command payloads still carry identifiers only, and every new query is principal-scoped.

**B1. `remember` still stores a sentence whose meaning the rest of Sid's message changes as a fact he stated.**
- **Where:** `isAuthorizedRememberText` (`memory-owner-controls.ts`) accepts any single sentence of the remainder that passes `isAuthenticatedFirstPersonQuote`. That check inspects only the quoted sentence itself, and the only cross-sentence check is the negation word list.
- **Proof:** each probe passes, storing the quoted sentence as `authenticated_first_person`, `uncertain: false`, with the owner as actor:
  - "Remember my plan if Waterloo rejects me. I'll take a gap year." → "I'll take a gap year."
  - "Remember what Sam texted me. I'm quitting the team." → "I'm quitting the team."
  - "Remember I failed calculus. Jk." → "I failed calculus."
- **Reported by the agent, not separately probed:** a voice transcript split after "Remember, if …" (the comma also defeats the prefix strip); negations written as "dont" or "cannot"; a lookalike apostrophe (U+02BC) or a zero-width character inside "not"; and a saved sentence that itself contains "no longer", which satisfies the negation check.
- **What goes wrong for Sid:** a conditional plan, someone else's words or a joke becomes a firm owner fact, and the `0016` guard stops rules or extraction from ever correcting it.
- **Fix:**
  - Store an owner-stated fact only when the text equals the whole remainder after one closed control prefix.
  - Refuse a text that is only part of the remainder, or commit it as `proposed` and `uncertain` with `basis: "inferred"` and no owner actor.
  - Normalise apostrophe lookalikes and strip zero-width characters before comparing.
  - Allow an optional comma after "remember" in the prefix list.
- **Test:** each case above refuses, or stores proposed and uncertain, with no owner-stated item. The probes must then fail.

**S1. A memory hidden by another memory's forget is still shown in full.**
- **Where:**
  - `explain` blanks suppressed excerpts but still returns `version.text` unless the item itself is forgotten, and for remembered items the text equals the excerpt.
  - A retried remember hides text only when its own transition is no longer current.
  - Lift returns the full item and its excerpts even when it reports the item is still hidden.
- **What goes wrong for Sid:** "why do you think that", a webhook retry or a restore can read back words from a message he told Jarvis to forget.
- **Fix:** one shared helper that blanks text, text hash, excerpts, excerpt hashes and topic path whenever `memory_retrievable_item_versions` doesn't return the item, used by explain, remember replays and lift.
- **Test:** two items from one turn. After forgetting A, explaining B, retrying B's remember, and lifting A while B still covers the turn each return no hidden text.

**F1. The extra negation guard is untested and over-refuses.** Mutation B1a survives. Once B1 accepts only the whole remainder, remove the guard or pin its intended case with a test.

**Low (fix if small, otherwise record in KNOWN_ISSUES):**
- **N1.** The hidden retry result still includes topic names, because `suppressMemoryText` copies `topicPath`.
- **N2.** A forget or lift that loses a race still leaves a stored command that can never apply, and burns that owner event.
- **N3.** Lifting back to `proposed` records the owner as actor, so rules can never promote or reject it, and no confirm control exists yet.
- **N4.** `memoryIntent` is as much the adapter's word as the forwarded/quoted flags. Say so in KNOWN_ISSUES F1.
- **N5.** `issueRedactedUlid` is still exported from `calls.ts`, so any module can import it directly.
- **N6.** Retrying an unapplied remember command can create a memory from a message Sid has since forgotten. Recheck suppression before commit.
- **Info (suspicion, predates this PR).** Archiving deletes old `events` rows that memories point to, so explain, forget and lift on such an item would fail as `memory_corrupt`. Confirm it, and track it for the archive-history slice.

**Next.** In a fresh session on this branch:
1. Pull first. Fix B1, S1 and F1, plus N1–N6 where small.
2. Rerun the reviewer probes `zz-reviewer-pr50-probes.ts` and `zz-reviewer-pr50b-probes.ts` (all must fail), the focused memory tests and the full suite once.
3. Post in AGENT_LOG when ready for re-review.

This PR authorizes no migration, deploy, secret or live action.

---
