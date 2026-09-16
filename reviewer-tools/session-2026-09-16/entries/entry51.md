## 2026-09-15 19:10 UTC — Claude Opus 5, PR #51 xhigh review at a25a5fd: changes requested (small)

This review covers the Brightspace step-3 completion:
- **F1:** keep the soonest 180 in-window live items, keep in-window cancellations additive, and record the truncation as a digest gap.
- **F2 and F3:** the malformed-component and repeat-cancellation tests.
- **N7 and N8:** recorded in KNOWN_ISSUES.
- **"Check D2L now":** an on-demand refresh from the owner's own Telegram turn, under a durable five-minute cooldown.

The branch is based on main `deea39c`, and `git diff origin/main...` holds only this school slice. It adds no migration and no memory, voice, calls or contracts changes.

**Local checks on a25a5fd** (Windows 11, `jarvis-pr39`): lint and typecheck pass; `pnpm test` passes 3,178/3,178 with 0 timeouts.

**Mutation pass** (`reviewer-tools/pr51/mut51.json`, one change per run, related tests only). `BASE` passes, and 11 of 12 mutations are killed by named tests, with 0 timeouts:
- **Truncation:** the 180 cap (T1), soonest-first ordering (T2), the truncation count (T3), the count passed to ingestion (T4), the health gap written by ingestion (I1) and persisted by the repository (R1), and the digest wording (D1). All are killed by "keeps the soonest 180 of 250 in-window items plus cancellations".
- **Cooldown:** the durable cooldown (C1) fails three tests, including "admits one cooldown claim across different request keys".
- **Replies and routing:** the failed-refresh reply keeps the last-known snapshot (T5), owner-only routing (M1) and the phrase's start anchor (M2).

One survives:
- **M3:** removing the phrase pattern's end anchor (`$`) fails no test. See F1.

**Verified by reading:**
- **Truncation (F1).** `selectBrightspaceWindow` sorts in-window items by `dueAt`, then `externalId`, and keeps the first 180. Cancellations are filtered by the same window but aren't counted against the cap. The omitted count reaches `DeadlineIngestion` as `sourceTruncatedCount`, which is bounded at 2,000. `recordSourceSuccess` stores `source_items_truncated:N` as a fixed health gap beside the fresh success, and the digest renders it as "showing the next 180 Brightspace items".
- **On-demand refresh.** `SchoolCatchupModelAdapter` runs it before any model call, only when the principal is the configured owner and the whole message matches the anchored phrase pattern ("check D2L now", "refresh my Brightspace deadlines now", and similar).
  - With no URL or a disabled source, it replies without a feed request.
  - Otherwise `claimAfterCooldown` inserts a `scheduled_runs` row only when no `brightspace_on_demand` run started in the last five minutes, in one D1 statement.
  - The refresh reuses the hourly `refreshBrightspace`, with the #49 redirect, isolation, window and cancellation guarantees.
  - Replies carry only fixed codes, counts and timestamps. The feed URL and body never reach the reply, the model, or events.

**Adversarial pass** (one Opus agent; report `reviewer-tools/pr51-adversarial.md`). The reviewer verified each item below:
- **Runtime-proven:** M1, with probe `reviewer-tools/pr51/zz-reviewer-pr51-window.test.ts`. It passes at `a25a5fd`: with 70 past-due and 250 upcoming in-window items, all 70 past-due items are kept and only 110 upcoming ones.
- **By reading:** M2, M3, L1 and L2.

Confirmed sound:
- The trigger is decided on the owner's own Telegram text before any model call, and the whole message must match. Quoted, pasted or casual text never triggers it.
- The cooldown claim is one atomic D1 insert, written before the fetch and kept on failure.
- Replies carry only fixed codes, counts and timestamps.
- The snapshot time is the last success, not the last attempt.
- The #49 guarantees hold, apart from S2 below.
- Group chats and forwarded text aren't a new exposure: ordinary school replies already reach them. They belong with the channel adapter's provenance work.

**S1. A busy semester drops upcoming deadlines to keep past-due ones.**
- **Where:** `selectBrightspaceWindow` (`job-table.ts`) sorts the whole window, from 14 days ago to 120 days ahead, soonest first, then keeps 180. Past-due items therefore fill the cap first, while the digest says "showing the next 180 Brightspace items".
- **Proof:** the probe keeps all 70 past-due items and only 110 of the 250 upcoming ones.
- **What goes wrong for Sid:** when D2L lists more than 180 entries, the next deadlines he most needs are the ones dropped, while the digest suggests it is showing what's next.
- **Fix:** rank items due from now onward first (soonest first), then past-due items (newest first), and keep 180.
- **Test:** 70 past-due plus 250 upcoming keeps the 180 soonest upcoming. Add past-due items to the existing 250-item test. The probe must then fail.

**S2 (regression of a #49 guarantee). A truncated source can never show as stale.**
- **Where:** `scheduledSourceGap` (`digest-job.ts`) returns "showing the next 180" whenever `last_failure` holds the truncation marker, before the three-hour staleness check runs.
- **What goes wrong for Sid:** once a large feed truncates, hourly syncing may later stop without recording a failure, for example a swallowed D1 error in `safeSourcePoll` or the cron not firing. The digest then keeps saying "showing the next 180 Brightspace items" and never "last successful sync is stale", so old deadlines look current.
- **Fix:** run the age check as well when the marker is present.
- **Test:** a Brightspace source with the truncation marker and a last success more than three hours old shows the stale gap.

**S3. Cancellations are no longer capped.**
- **Where:** the 180 cap now applies only to live items. Every in-window cancellation, including each `STATUS:COMPLETED` task, still costs a D1 update, up to the parser's 2,000 components.
- **Why it matters:** a feed with many completed tasks can go over the sweep's D1 budget, which #49's test pinned below 800 statements, and abort partway. The real feed shape is unknown.
- **Fix:** cap cancellations too (for example the nearest 180), or look up which ids are still open in one chunked query and update only those.
- **Test:** 180 live items plus 1,500 in-window cancellations stays under the counted budget.

**F1. No test pins the whole-message match for "check D2L now".**
- **What goes wrong:** mutation M3 survives. Without the end anchor, a message that merely starts with the phrase ("check D2L now and tell me what's due Friday") runs the refresh and drops the rest of the message.
- **Test:** add that case, expecting the normal model path.

**Low (fix if small, otherwise record in KNOWN_ISSUES):**
- **N1.** Refresh and snapshot replies show raw UTC ISO times. Show Toronto time, as the digest does.
- **N2.** Both catch-all replies say "No last-known Brightspace snapshot is available" even when one exists. And if `runs.finish` throws after a good refresh, the reply says the refresh failed. Read the source's last success in the catch path, and don't let a `finish` error turn a success into a failure reply.
- **N3.** Near-miss phrasings go to the model, which has no feed data: "check d2l", "hey jarvis check d2l now", "check D2L now thanks". Make sure the reply guard stops it from claiming it checked D2L. This is a suspicion, not proven.
- **N4.** The cooldown ignores the hourly poll, so a manual request right after it fetches again. Overlapping sweeps could move `last_success_at` backwards; keep it monotonic.
- **N5.** A first on-demand load (up to a 10 s fetch plus several hundred statements) runs inside the reply's `waitUntil` budget. If it's cut off, no failure is recorded and Sid gets no reply. This is a suspicion, not measured.
- **N6.** "N items are current" counts cancelled rows and leaves out rejected entries.

**Next.** In this same chat:
1. Pull first. Fix S1–S3 and F1, plus N1–N6 where small.
2. Rerun the reviewer probe (it must now fail), the focused tests and the full suite once.
3. Post in AGENT_LOG when ready for re-review.

This PR authorizes no migration, secret, deploy or live request.

---
