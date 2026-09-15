# Brightspace calendar-feed owner setup

This runbook is for Sid. It stores the one private calendar-subscription URL
that lets the hourly Cloudflare job read Brightspace calendar events while
every Windows PC is off. Jarvis does not log in to Brightspace, copy a browser
session, or receive a school password. This runbook does **not** deploy code,
apply a migration, contact the school, or prove the feed covers every course.

Do this only after the Brightspace feed PR has passed Claude review, merged,
and the owner has separately approved production setup and deployment. If the
school has disabled calendar feeds, stop. Do not work around that setting with
browser automation or ask for another person's feed.

Official setup reference: [D2L's calendar-feed instructions](https://community.d2l.com/brightspace/kb/articles/18042-manage-course-events-with-the-calendar-tool).

## Copy Sid's private feed URL

1. Sign in to the school's normal Brightspace site in Sid's browser.
2. Open **Calendar**, then **Settings**.
3. Select **Enable Calendar Feeds** and save.
4. Choose **Subscribe**, then **All Calendars and Tasks** so course deadlines
   are not omitted by selecting one calendar.
5. Copy the subscription URL. Treat it as a bearer credential: do not paste it
   into chat, a repository file, a command argument, a screenshot, or an
   evidence log. Jarvis needs the feed URL, not a downloaded `.ics` file.

D2L describes the feed as calendar events and tasks. It does not provide
grades or authoritative submission/missing-work state. Those remain a later,
separately approved connector.

## Store the Worker secret from PowerShell 7

Use the reviewed deployment checkout. The first command is the directory
change:

```powershell
cd 'C:\Users\Sid\jarvis-deploy'
pnpm.cmd install --frozen-lockfile
$PSNativeCommandArgumentPassing = 'Standard'
$wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
$gateway = (Resolve-Path 'apps/cloud-gateway/wrangler.toml').Path
& node $wrangler whoami
```

Confirm `whoami` names the intended Cloudflare account. If PowerShell
transcription is active, stop it. The next command opens Wrangler's interactive
prompt; paste the URL only there. The explicit empty environment targets the
top-level production Worker.

```powershell
& node $wrangler secret put BRIGHTSPACE_ICAL_URL --config $gateway --env ''
& node $wrangler secret list --config $gateway --env ''
```

The list must show `BRIGHTSPACE_ICAL_URL`. Record the name and presence only,
never the value. Clear the clipboard if it still holds the URL. Creating the
secret does not deploy the reviewed code.

## Verify after an approved deployment

Wait for the next hourly firing, then use this read-only query in the same
PowerShell 7 window:

```powershell
& node $wrangler d1 execute jarvis --remote --config $gateway --env '' --command "SELECT source_id, active, last_success_at, last_failure, last_failure_at FROM deadline_sources WHERE source_id = 'brightspace-ical';"
```

Expected outcome: one active `brightspace-ical` row, a recent
`last_success_at`, and null failure fields. Confirm one real event's date and
time against Brightspace and the next morning digest. This is **live
acceptance**; local parser, ingestion, and digest tests do not establish it.

Date-only entries use 23:59:59.999 in `DIGEST_TIMEZONE` as a conservative
reminder because the current deadline table stores only instants. A floating
calendar time also uses that configured owner timezone; a calendar time with
an explicit `TZID` or UTC marker keeps that meaning. Do not describe a
synthetic end-of-day time as a time the teacher supplied.

With no URL configured, the hourly job makes no feed request and the digest
says `Brightspace: not set up`. If a previously configured URL is removed, the
stored source records `brightspace_configuration_missing` and retains its
last-known deadlines rather than claiming the feed is empty.

Failure meanings are fixed codes and never contain the private URL or response
body:

- `brightspace_feed_url_invalid`: the configured value is not an acceptable
  HTTPS subscription URL. Re-copy it through the attended setup above.
- `brightspace_feed_redirected`: the feed redirected. Jarvis refuses redirects
  so a bearer request cannot turn into a login/browser flow or move silently
  to another origin.
- `brightspace_feed_rejected`: Brightspace refused the request. Re-copy or
  revoke/reissue the feed through Brightspace; do not supply a password.
- `brightspace_feed_unavailable`: a timeout, rate limit, server error, or
  network failure. The next hourly run retries normally.
- `brightspace_feed_too_large` or `brightspace_feed_invalid`: the response is
  outside the bounded iCalendar contract. Last-known deadlines stay visible
  and the digest names the source failure.
