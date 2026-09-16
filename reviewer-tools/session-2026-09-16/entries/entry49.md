## 2026-09-15 17:37 UTC — Claude Opus 5, PR #49 xhigh review at 4d511f2: changes requested

This review covers the Brightspace private iCalendar feed (`brightspace-ical-client.ts`, the hourly `pollBrightspace` job, `BRIGHTSPACE_ICAL_URL`) plus the #43 follow-ups F1 (the digest names a stale hourly source) and F2 (`safeSourcePoll` wraps the Classroom bootstrap). The branch is based on `1130694`; `git diff origin/main...` holds only this PR's work, and it adds no migration. `b630200` and `d4b19ed` change only the mailbox. Main has since moved to `60ae90d` (#47), which touches none of these files.

**Local checks on b630200** (Windows 11, `jarvis-pr39`):
- The six related test files pass 72/72 with 0 timeouts: Brightspace client and poll job, digest job, Classroom poll job, deadline ingestion, Google OAuth.
- The full suite and the mutation pass over the client's guards wait for the fix round, because B1 changes the fetch path. The PR reports 3,145/3,145.

**B1. In production the feed request can never be sent.**
- **Where:** `brightspace-ical-client.ts:488` passes `redirect: "error"` to `fetch`.
- **What goes wrong:** workerd does not implement that value.
  - `Request` and `fetch` throw `TypeError: Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code)`.
  - `collectDeadlines` catches it as `brightspace_feed_unavailable`. Every hourly poll fails, and the digest reports a Brightspace gap forever. The runbook calls that code a blip that "retries normally".
  - The tests inject `fetchImplementation`, so no test ever builds a real `Request` with this init.
- **Runtime proof:** reviewer probe `pr49/zz-reviewer-pr49-redirect.test.ts` ran in the workerd test pool at `b630200`. All three cases pass, so the bug is real:
  - P1: `new Request(url, { redirect: "error" })` throws that message.
  - P2: the global `fetch` rejects with it before any network.
  - P3: the production client with the default fetch returns `brightspace_feed_unavailable`.
  - The adversarial agent reproduced it separately with the repo's bundled workerd, the PR's compatibility date and a local stub. Under `redirect: "manual"`, a 302 comes back unfollowed.
- **Same class already on main:**
  - `deadlines/google-oauth.ts:109`: the Classroom token refresh from #43, so Classroom can never sync once configured.
  - `providers/capacity-readers.ts:37`: the DeepSeek and Twilio capacity readers used by `archive/production-capacity.ts`.
- **Fix:** use `redirect: "manual"` at all three sites. Treat any 3xx, `type === "opaqueredirect"` or status 0 as the fixed redirect/unavailable failure, cancel the body, and never follow.
- **Test:**
  - Give each client a `fetchImplementation` that first runs `new Request(url, init)` inside the workerd pool, so an invalid init fails the test.
  - Add a 302-with-`location` case expecting `brightspace_feed_redirected` and no second request.
  - The reviewer's P1–P3 must then fail.

**S1. One unusual calendar entry blanks the whole Brightspace source.**
- **Where:** `parseComponents`, `one`, `calendarInstant` and `parseBrightspaceCalendar` throw `brightspace_feed_invalid` for the entire feed on a single-entry problem.
- **Runtime-proven** by reviewer probe `pr49/zz-reviewer-pr49-strict.test.ts`, with one good event plus one odd event:
  - a non-IANA `TZID` such as `Eastern Standard Time` (the kind a `VTIMEZONE` block defines);
  - an extension property name containing `_` (`X-MS_OLK-FLAG`);
  - a `TZID=America/Toronto` time inside the spring-forward gap;
  - two components with the same UID and no `RECURRENCE-ID`.
- **By reading:**
  - two `CATEGORIES` lines, which RFC 5545 allows (`one()` throws on more than one);
  - a duplicated `STATUS` or `UID` within one component.
- **Not claimed:** the reviewer's probe for an unknown text escape (`\:`) did not reproduce.
- **Consequence:** one teacher's odd event stops every Brightspace update. Last-known deadlines stay visible with a gap, but new and moved deadlines from every course stop arriving.
- **Fix:**
  - Fail the whole feed only for structural faults: no single `VCALENDAR`, unbalanced `BEGIN`/`END`, or the size and count bounds.
  - Otherwise reject the individual component: skip it and count it in the ingestion report's rejected list.
  - Take the first `CATEGORIES` value.
  - Resolve a `TZID` through the feed's `VTIMEZONE` when possible; otherwise reject that component.
- **Tests:** one feed with a good event plus each odd form above. The good event is ingested, each odd one is counted as rejected, and the source records success.

**Adversarial pass** (one Opus agent). The reviewer verified each item below against the code.

**S2. A large feed can exhaust the hourly run's D1 query budget.**
- **Where:** each item costs about three D1 queries every hour, past and unchanged items included: `#readRow`, the `last_seen_at` UPDATE, then `#requireDeadline` (`deadline-repository.ts:361-420`).
- **Why it matters:**
  - This runs in the same scheduled invocation as archival, Classroom and project polling.
  - A year-long "All Calendars and Tasks" feed of a few hundred entries approaches the Workers per-invocation D1 query limit.
  - Past that, the sweep aborts midway. Its own failure write can also be refused, and the later project poll fails.
  - The real feed size is unverified.
- **Fix:**
  - Ingest only a bounded window, for example due from 14 days ago to 180 days ahead.
  - Make the unchanged path a single statement: a conditional `UPDATE … WHERE content_hash = ?` checked by `changes`, with no re-read.
- **Test:** a 600-event feed stays under a counted query budget, using a counting D1 wrapper.

**S3. A teacher's explicit cancellation leaves the deadline open.**
- **Where:** `toDeadline` returns `null` for `STATUS:CANCELLED`/`COMPLETED`, so the item is treated as merely absent. It stays open and keeps reminding.
- **Why this differs from absence:** unlike a missing item, this is a positive signal from the source.
- **Fix:** carry the cancelled state through ingestion and close that source's matching open deadline. If that needs a repository change larger than this PR, record it in KNOWN_ISSUES instead.

**Low (fix if small, otherwise record in KNOWN_ISSUES):**
- **N1.** On timeout, `Promise.race` settles while `requestAndRead` later rejects with the abort error, and nothing handles that rejection. Attach a no-op `catch` to the losing promise.
- **N2.** `/digest` (`index.ts` `runDigestNow`) doesn't pass `unconfiguredDeadlineSourceKinds`, so a manual digest omits "Brightspace: not set up".
- **N3.** With the secret removed, the digest says "not set up" while still listing that source's last-known deadlines. Say they are last-known.
- **N4.** An invalid `DIGEST_TIMEZONE` surfaces as `brightspace_feed_invalid`, which the runbook maps to re-copying the URL. Give it its own code.
- **N5.** Archival still runs unwrapped before both source polls (`job-table.ts:181-183`), so an archive fault skips both deadline sweeps.
- **N6.** D2L may emit separate availability and due entries per item (unverified). Check D2L's documented feed format, and ingest only due entries if they can be told apart. Don't ask Sid for his feed.

**Confirmed sound by reading:**
- The URL is used only as the request target. Failures are fixed codes, and neither the URL nor the body reaches source health, digest text or job detail.
- The URL must be HTTPS with no credentials or fragment.
- The body is capped at 1 MiB, both declared and streamed, with 2,000 components and 256 properties each. Decoding is strict UTF-8, with no recursion or backtracking-prone regex.
- `UTC`, `TZID`, floating and date-only entries land on the right Toronto day. Recurrence exceptions get their own key.
- With no URL there is no request and no source row. A removed URL records `brightspace_configuration_missing` and keeps last-known deadlines. An owner-disabled source is not reactivated.
- F1: an active hourly source with no success in 3 hours, or that has never synced, shows as a digest gap, with its label chosen from the validated kind.
- F2: the Classroom and Brightspace polls are each wrapped.
- The runbook is PowerShell 7 with `cd` first, sets the secret only through Wrangler's interactive prompt, and is read-only after deploy.

**Next.** In this same chat:
1. Pull first. Fix B1 at all three call sites, S1–S3 and N1–N6.
2. Run the focused tests, then the full suite once.
3. Post in AGENT_LOG when ready for re-review. The re-review reruns P1–P3 and the strict probes (both must fail), plus a mutation pass over the client's guards.

This PR authorizes no migration, secret, deploy or live request.

---
