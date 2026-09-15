## 2026-09-15 06:35 UTC — Claude Opus 5, PR #43 review at 5729b09: cleared with follow-ups F1–F2

This reviews the R5 Classroom hourly ingestion. The branch merges cleanly with main, and no lockfile change or migration is included.

**Local checks on 5729b09** (Windows 11, `jarvis-pr39`): lint and typecheck pass. `pnpm test` passed **2,920 of 2,920** in 138 files with 0 timeouts.

**What was checked (reviewer reading of the full diff):**
- **Credentials and OAuth** (`google-oauth.ts`): refresh-token exchange only at Google's fixed token endpoint, with `redirect: "error"` so a redirect can't replay the secret to another origin. Malformed credentials are refused before any request. Errors carry fixed codes only and never Google's response body (tested). The token is cached per invocation with a 60 s skew. Concurrent calls share one refresh.
- **Classroom client:** the local-time interpretation knob is removed. Timed `dueDate`/`dueTime` are UTC per the API contract, which is correct and tested (18:30 UTC stays 18:30 UTC). Date-only work maps to 23:59:59.999 local, documented as synthetic, consistent with #41's corrected plan. Every Classroom error message is a fixed code.
- **Job wiring** (`job-table.ts`):
  - With all three secrets absent, nothing contacts Google and no source is created.
  - Partial configuration, or configuration removed after a source existed, records a visible source failure without a request.
  - Unknown exceptions map to the stable `classroom_ingestion_failed`.
  - `ensureSource` is idempotent and doesn't reactivate an owner-disabled source (tested).
  - A failed sweep computes no disappearances, so nothing is marked gone.
- **Digest:** last-known deadlines stay visible while a failed source is named with a fixed kind label, not source-supplied text. That keeps "source could not be read" distinct from "nothing due".
- **Runbook** (`google-classroom-oauth.md`): exactly two read-only scopes, with a note that `coursework.me.readonly` can expose grades. It names the admin and under-18 preflights and the 7-day Testing expiry, says to stop rather than work around policy, puts no secrets in chat or files, uses PowerShell 7 with `cd` first and `npx.cmd`, and verifies read-only afterwards. It correctly states that it authorizes no deployment.

**F1 (Low). Staleness isn't surfaced when the sweep stops running.** The digest names a source only when `last_failure` is set. If the hourly job stops firing (cron misconfiguration, or a deploy without the trigger), `last_success_at` just ages and the digest keeps showing old deadlines as current, against the plan's "stale vs no work" rule. Add a gap when an active source's `last_success_at` is older than a threshold (for example 3 h for the hourly Classroom sweep), with a test.

**F2 (Low). A D1 error in the Classroom bootstrap fails the whole hourly job.** `readSource`, `ensureSource` and the configuration-missing `ingest` run outside `pollClassroom`'s try. A thrown D1 error there propagates out of `poll()` after archival has run, and skips the project poll. Wrap the whole Classroom step so a failure becomes a detail string (`classroom_ingestion_failed`) and the project poll still runs, with a test.

**Order note.** The revised #41 plan makes Classroom slice 3. Merging this early is fine, because nothing activates without Sid's OAuth setup and a reviewed deployment. The school chat's next PR should still be slice 1, the catch-up conversation.

**Next.** Sid may merge #43. F1 and F2 go into the next school PR that touches the digest or jobs (the Brightspace feed PR at the latest). Activation stays a separate owner-attended step: OAuth runbook, secrets, deploy.

Sid retains merge authority. Merging deploys nothing and sets no secret.
