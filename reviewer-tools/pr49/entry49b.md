## 2026-09-15 18:27 UTC — Claude Opus 5, PR #49 re-review at f5292c7: cleared with follow-ups F1–F3

This re-review covers fix commit `0e9adf8`, the merge of main `60ae90d` (`478134c`), the archive-isolation test update `b908e76` and the mailbox `f5292c7`. Outside `docs/AGENT_LOG.md` and `NEXT_STEPS.md`, the merge adds exactly main's own change set. `git diff origin/main...` holds only this PR's work, and it has no migration and no memory files.

**Local checks on f5292c7** (Windows 11, `jarvis-pr39`): lint and typecheck pass; `pnpm test` passes 3,170/3,170 with 0 timeouts.

**Review probes.**
- **Strict probe (`zz-reviewer-pr49-strict.test.ts`).** The four runtime-proven S1 cases now fail, as required: non-IANA TZID, underscore property name, DST-gap time and duplicate UID. The unknown-escape case failed on both heads and was never claimed.
- **Redirect probe (`zz-reviewer-pr49-redirect.test.ts`).** It still passes, but it no longer discriminates:
  - P1 and P2 assert workerd's own refusal of `redirect: "error"`, a platform fact the PR cannot change.
  - P3 now reaches the network path with `redirect: "manual"`, and the `.invalid` host fails DNS, so it still returns `brightspace_feed_unavailable`.
  - B1 is instead proven by the builder's workerd-pool `new Request(url, init)` tests and by mutations C1, G1 and P1 below.

**Mutation pass** (`reviewer-tools/pr49/mut49b.json`, one change per run, related test files only). `BASE` passes, and 12 of 18 mutations are killed by named tests, with 0 timeouts:
- **Redirects:** Brightspace `redirect: "error"` (C1, two tests including the 302 refusal), the 3xx check (C2), OAuth `redirect: "error"` (G1) and capacity `redirect: "error"` (P1).
- **Calendar parsing:** duplicate UID (C4), DST-gap shift (C6), `VTIMEZONE` alias (C7) and the timezone code (C8).
- **Polling:** the past window bound (J1, the 600-component budget test) and archive isolation (J3).
- **Storage and digest:** the monotonic unchanged `last_seen_at` (R2, three tests) and the removed-configuration wording (D1).

Six survive:
- **C3:** removing `if (component.invalid) rejectComponent();` fails no test. See F2.
- **R1:** removing `AND status = 'open'` from `cancelOpenByExternalId` fails no test. See F3.
- **J2:** raising the 180 cap to 100,000 fails no test. See F1.
- **C5:** dropping the timeout loser's `catch` can't be observed under vitest. Accepted.
- **G2:** removing the OAuth 3xx `throw` is equivalent. A 302 falls through to `!response.ok`, which throws the same non-transient `google_oauth_rejected` and follows nothing.
- **I1:** removing ingestion's cancelled-versus-present check can't be reached from Brightspace, because the parser's shared identifier set already rejects an id that is both live and cancelled. It is defence in depth only.

**Findings from the round-1 review, verified by reading:**
- **B1 is fixed at all three sites.** `redirect: "manual"`. Brightspace, Google OAuth and the capacity readers refuse `redirected`, `opaqueredirect`, status 0 and any 3xx, and cancel the refused body. OAuth maps a 3xx to non-transient `google_oauth_rejected`.
- **S1 is fixed.** Envelope, size and count faults still fail the feed. Line and property faults inside a `VEVENT`/`VTODO` mark only that component invalid, and it is counted as `invalid_source_item`. Duplicate UIDs and duplicate single-value properties reject the component. The first `CATEGORIES` is used. `VTIMEZONE` `X-LIC-LOCATION` aliases resolve non-IANA TZIDs. A DST-gap wall time moves forward by the gap.
- **S2 is fixed.**
  - Only items due from 14 days ago to 120 days ahead are ingested.
  - The unchanged path is one `UPDATE … WHERE source_id, external_id, content_hash … RETURNING *`, with `last_seen_at` kept monotonic.
  - The builder's counted test ingests 134 in-window items of a 600-component feed, under 800 statements on first load and under 180 on the next run.
- **S3 is fixed.**
  - `STATUS:CANCELLED`/`COMPLETED` inside the window closes only that source's matching `open` deadline.
  - An id that also appears as a live item is rejected as a duplicate instead of cancelled.
  - Absence stays report-only.
- **N1–N5 are fixed.**
  - The losing timeout promise is observed.
  - `/digest` and the scheduled digest share `unconfiguredDeadlineSourceKinds`.
  - Removed configuration says it is showing last-known deadlines, with their date.
  - `brightspace_timezone_invalid` is its own code, made before any request.
  - Archival failure is isolated, and the three polls still run.
- **N6 is recorded.** KNOWN_ISSUES and the runbook say D2L documents no iCalendar field that separates availability from due entries. Live acceptance compares the list with the Brightspace UI.

**New in this round:**

**F1 (required before the feed secret is set). More than 180 in-window entries fails the whole source again.**
- **Where:** `selectBrightspaceWindow` (`job-table.ts:135-136`) throws `brightspace_feed_too_many_items` when the 134-day window holds more than 180 items plus cancellations. `pollBrightspace` then records a source failure and ingests nothing.
- **Why it's likely:** N6 means each assignment or quiz may contribute separate availability-start, availability-end and due entries. A semester of four or more courses can pass 180, and every new or moved deadline would then stop until old entries age out.
- **Fix:** sort in-window items by `dueAt` and keep the soonest 180 (plus in-window cancellations). Count the rest in the report and surface a digest gap such as "showing the next 180 Brightspace items".
- **Test:** no test names `too_many_items` today. Add a 250-item in-window case: the soonest 180 are ingested, the source records success, and the truncation count is reported.

**F2. No test proves a malformed component is rejected rather than ingested without its bad line.**
- **What goes wrong:** removing `if (component.invalid) rejectComponent();` leaves every test passing. A component whose `STATUS` or `DTSTART` line is malformed would then be ingested as if that line were absent. For example, a cancelled event with a corrupted `STATUS` line would stay live.
- **Test:** a `VEVENT` with one malformed property line (an unterminated quoted parameter) next to a good event. The bad one is counted as `invalid_source_item` and is not stored.

**F3. No test pins `cancelOpenByExternalId` to open rows.**
- **What goes wrong:** removing `AND status = 'open'` passes every test. Hourly sweeps would then re-close an already-cancelled deadline and report it as cancelled again each hour, and would overwrite a future `submitted` or `missed` state.
- **Test:** a second sweep with the same cancellation reports zero newly cancelled, and a row in another status is untouched.

**Low:**
- **N7.** A `VTODO` with `STATUS:COMPLETED` (`brightspace-ical-client.ts:454`) closes the deadline as `cancelled`. Stopping reminders is right, but a later grade or missing-work watch should not read it as teacher-cancelled. Record that in KNOWN_ISSUES or the digest wording.
- **N8.** The one-statement unchanged path matches any status, so a teacher who restores a cancelled event with the same content leaves it `cancelled`. This was also true before, and is rare; note it with N7.

**Next.** The reviewer merges this head. F1–F3 and N7–N8 go into the next school PR, before the Brightspace secret is set. Merging deploys nothing; the fixed Google OAuth and capacity-reader fetches reach production only through Sid's approved deploy.

This PR authorizes no migration, secret, deploy or live request.

---
