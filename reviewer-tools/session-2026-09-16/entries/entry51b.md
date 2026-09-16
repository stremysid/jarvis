## 2026-09-15 20:42 UTC — Claude Opus 5, PR #51 re-review at fe1289d: cleared with follow-ups F1–F2

This re-review covers fix commit `b641f20` and the mailbox head `fe1289d`, pushed by a fresh Codex CLI session because the desktop chat couldn't be reached. The branch is still based on main `deea39c`, and `git diff origin/main...` holds only this school slice. It adds no migration.

**Local checks on fe1289d** (Windows 11, `jarvis-pr39`, while builder sessions were also active on this PC): lint and typecheck pass; `pnpm test` passes 3,188/3,188 with 0 timeouts.

**Reviewer probe** (`zz-reviewer-pr51-window.test.ts`). It now fails, as required: with 70 past-due and 250 upcoming in-window items, no past-due items are kept (`expected +0 to be 70`). S1 is fixed.

**Mutation pass** (`reviewer-tools/pr51/mut51b.json`, one change per run, related tests only). `BASE` passes, and 9 of 11 mutations are killed by named tests, with 0 timeouts:
- **Ordering and caps:** upcoming-first (U1) and newest-past-first (U2) are killed by "uses remaining capacity for the newest past-due items". The cancellation cap (U3) and cancellations counted in the truncation (U4) are killed by "caps a cancellation-heavy sweep below its counted D1 statements".
- **Staleness:** truncation plus staleness (S2).
- **Phrase and claim guards:** the whole-message end anchor (F1), and the D2L-claim guard on the structured (N3a) and ordinary (N3b) reply paths.
- **Reply time:** Toronto formatting of the snapshot time (N1).

Two survive:
- **N3c:** removing the D2L-claim guard on the save-failure fallback path fails no test. See F1.
- **N4:** removing the `last_success_at` clause of the monotonic success guard fails no test. See F2.

**Round-1 findings, verified by reading:**
- **S1 is fixed.** `selectBrightspaceWindow` ranks upcoming items first (soonest first), then past-due items (newest first), before keeping 180.
- **S3 is fixed.** Cancellations are capped separately at the 180 nearest to now. `truncatedCount` counts both the omitted live items and the omitted cancellations.
- **S2 is fixed.** `scheduledSourceGap` builds the bounded-result text and still runs the never-synced, unreadable and stale checks, joining them with the partial-result text.
- **F1 is fixed:** a test pins the whole-message end anchor.
- **N1 is fixed.** Reply times use the owner timezone, falling back to America/Toronto when the configured zone is invalid.
- **N2 is fixed.** The catch path re-reads the last success and says when it can't. A `finish` error is recorded as a failed run without changing the reply.
- **N3 is fixed.** A D2L-check claim guard covers the structured, snapshot-fallback and plain fallback reply paths.
- **N4 is fixed.** `recordSourceSuccess` applies only when both the stored success and failure times are no newer.
- **N6 is fixed.** Reply counts separate processed live items, cancelled deadlines and rejected entries.
- **N5 is recorded** in KNOWN_ISSUES.

**New in this round (low):**
- **N7.** `BRIGHTSPACE_CHECK_COMPLETIONS` also matches honest replies, not just false claims, and replaces them with "I haven't checked D2L". Examples: "I looked at the Brightspace dates you pasted", or "Jarvis refreshed Brightspace an hour ago", when the model is summarising the digest. This is the same class as #45 S3. Tighten the pattern to present-tense claims of having just checked, and add a legitimate-reply test.
- **N8.** Only `recordSourceSuccess` is monotonic. An older, slower sweep's `recordSourceFailure` can still overwrite newer success health with a stale failure. Apply the same timestamp guard to failures.

**F1. No test covers a false D2L-check claim on the save-failure fallback path.** Mutation N3c survives. Add a test where the school plan fails to save and the model's fallback reply claims it checked D2L. Expect the fixed replacement line, followed by the save-failure line.

**F2. No test pins the success-time half of the monotonic source-health guard.** Mutation N4 survives: without `last_success_at <= ?`, an older, slower sweep can replace a newer `last_success_at`. Add a test that records a later success, then an earlier one, and expects the later time to remain.

**Next.** The reviewer merges this head. F1–F2 and N7–N8 go into the next school PR. Merging deploys nothing; the Brightspace secret, deploy and live acceptance stay Sid's.

This PR authorizes no migration, secret, deploy or live request.

---
