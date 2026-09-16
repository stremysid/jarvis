## 2026-09-15 21:27 UTC — Claude Opus 5, PR #50 round-3 re-review at 8b8515d: cleared with follow-ups F1 and N7

This re-review covers fix commit `355d008` and the mailbox head `8b8515d`, pushed by a fresh Codex CLI session. The branch is still based on `deea39c`; main has since moved to `ebb757b` (#51 and #46), which touches no memory files. It adds no migration.

**Local checks on 8b8515d** (Windows 11, `jarvis-deploy`, while other builder sessions were active on this PC): lint and typecheck pass; `pnpm test` passes 3,211/3,211 with 0 timeouts.

**Reviewer probes** (round 1 `zz-reviewer-pr50-probes.ts` plus round 2 `zz-reviewer-pr50b-probes.ts`, run together). All seven now fail, as required:
- H1a (meaning-flipping fragment), H1b (mid-word fragment), M1 (stale replay leak) and L1 (dangling command on over-long text);
- the round-2 conditional, reported-speech and retracted cases.

So no partial sentence can become an owner-stated fact, a stale replay leaks nothing, and over-long text writes no command.

**Mutation pass** (`reviewer-tools/pr50/round3/mut50c.json`, one change per run). `BASE` passes, and 8 of 9 mutations are killed by named tests, with 0 timeouts:
- **Whole remainder only (R3a):** restoring substring acceptance fails four tests: negation, reported speech, conditional and mid-word fragments.
- **Hiding and replay:** the shared visibility redaction (R3b) and the suppression recheck when recovering an accepted remember (R3c).
- **Normalisation and prefix:** apostrophe normalisation (R3d), zero-width normalisation (R3e) and the comma prefix (R3f).
- **Stored excerpt:** the excerpt is the exact remainder (R3g).
- **Shared redaction:** the canonical-ULID passthrough in `sanitizeRedaction` (R3h), including "preserves a canonical ULID whose random component contains six digits".

One survives:
- **R3i:** removing the `acceptedCommand === null` refusal in `readAcceptedOwnerTurn` fails no test. See F1.

**Round-2 findings, verified by reading:**
- **B1 is fixed.** `isAuthorizedRememberText` now accepts only a text equal to the whole remainder after one closed control prefix. The comparison first normalises apostrophe lookalikes and strips zero-width characters. The prefix list allows an optional comma after "remember", and any partial sentence is refused before command ingress. The source excerpt stored is the exact remainder, not the caller's text. Conditional, reported-speech and retracted context is therefore kept verbatim with the fact, never cut away.
- **S1 is fixed.** `redactUnretrievableItem` returns the item with text, text hash, excerpts, excerpt hashes and topic path blanked whenever `memory_retrievable_item_versions` doesn't return it. Explain, remember (first write and replay) and lift all use it.
- **F1 is fixed:** the extra negation guard is gone, because only the whole remainder is accepted.
- **N1 is fixed:** hidden results carry an empty topic path.
- **N6 is fixed.** Recovering an accepted remember reads the stored owner command through `readAcceptedOwnerTurn` and rechecks the source turn's active suppression. A suppressed turn only reads an existing replay (`readInitialItemReplay`) and never commits a new item.
- **N5 is fixed:** `issueRedactedUlid` is removed.
- **Recorded in KNOWN_ISSUES:** N2 (race-lost commands), N3 (owner-actor proposed restoration), N4 (`memoryIntent` is the adapter's word too), and the confirmed archive-history defect. Archive purge deletes delivered `events` rows while sources stay `live`, so old-memory controls become `memory_corrupt` until the archive-history slice keeps a verifiable source reference.

**New in this round (low):**
- **N7.** N5 was closed by adding `if (LOWERCASE_ULID.test(text)) return issueSanitizedRedaction(text, [])` to the shared `sanitizeRedaction` in `packages/contracts/src/calls.ts`, which every channel's redaction uses, voice and Telegram included. A message whose whole text is a 26-character lowercase ULID-shaped string now skips the six-digit authentication redaction. A real secret with exactly that shape is unlikely. Still, this changes the calling lane's shared redaction for a memory-only need. Prefer a narrow structural path inside memory controls, or add a contracts test pinning that only exact canonical ULIDs pass and that a six-digit code in any other text is still redacted.

**F1. No test pins the accepted-command check when recovering a remember.**
- **Where:** `readAcceptedOwnerTurn` refuses unless `memory_valid_owner_commands` holds an `item.transition` command caused by the owner turn. Mutation R3i shows no test reaches that refusal.
- **Reach:** today the service only calls it with the envelope that `appendCommand` returned for a recorded idempotency key, and the `0016`/`0019` guards still require a valid owner command before any transition is written. So it's defence in depth, not an open hole.
- **Test:** call recovery with an owner command event that isn't an accepted `item.transition` for that turn, and expect `memory_refused` with no item.

**Next.** The branch conflicts with main `ebb757b` in `KNOWN_ISSUES.md` and `docs/AGENT_LOG.md`, so it can't merge yet.
1. In a fresh session, merge `origin/main` with docs-only conflict resolution: keep every entry on both sides. Make no code changes, run the full suite once, and push.
2. The reviewer verifies that the merged tree differs from this cleared head only by main's changes and the resolved docs, runs the gates, merges, and verifies main.
3. F1 and N7 go into the next memory PR (archive-complete literal history).

This PR authorizes no migration, deploy, secret or live action.

---
