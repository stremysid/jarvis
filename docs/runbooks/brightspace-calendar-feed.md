# Brightspace calendar-feed owner setup

> ## THIS ROUTE IS DEAD FOR SID. DO NOT SEND HIM HERE.
>
> **Sid's board (LDSB "Minds Online" Brightspace) has NO Calendar tool and no
> personal iCal export.** He said so on 2026-09-16 after being asked for the
> link: *"i thought i went over this, there is no calnder in d2l"*. It was
> already recorded in the expansion plan (deleted by
> [#131](https://github.com/stremysid/jarvis/pull/131)), and PRs #49 and #51
> built the feature anyway. The current register is [FACTS.md](../FACTS.md).
>
> **Never ask Sid for a D2L calendar or feed URL.**
>
> **CORRECTED 2026-09-21: the notification-email route is dead too.** This banner
> previously said *"the live route is D2L notification email into
> `school@onesid.ca`, which he has already configured"*. That was wrong, and it
> was the fourth time this project pointed a session at a D2L route that cannot
> work.
>
> Measured by Sid on 2026-09-21 with every notification option enabled: D2L's
> email is an **activity summary** — *"Activity summary for `<course>`"*, a count
> such as *"76 New Emails"*, and a link. **No assignment name, no course, no due
> date.** It is sent per course and once for the board as a whole, and both link
> to the same D2L inbox, which is behind a login.
>
> So the email carries nothing a parser can turn into a deadline, and the dates
> live behind authentication. **There is no working automated D2L route for this
> board.** Do not propose one without new evidence from the board.
>
> The replacement route is the **browser collector on the PC and laptop** — see
> [the collector runbook](d2l-extension.md) for its rollout and acceptance limits.
>
> Still current from this banner: the calendar tool does not exist, and the
> ingestion code below is kept because its failure codes are real and would be
> reused if the board ever exposes a feed.
>
> Kept because the ingestion code and its failure codes are real and would be
> reused if that board ever exposes a feed.

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

D2L describes the feed as calendar events and tasks. Its documentation also
says availability start/end dates and due dates can both appear in Calendar,
but does not document an iCalendar property or title convention that reliably
distinguishes those meanings. Jarvis therefore treats each dated event/task as
a candidate deadline and does not guess from untrusted titles. Live acceptance
must compare the resulting list with the Brightspace UI before relying on it.
The feed does not provide grades or authoritative submission/missing-work
state. Those remain a later, separately approved connector.

References: [availability and due dates in Content](https://community.d2l.com/brightspace/kb/articles/3378-add-availability-and-due-dates-in-content),
[Calendar events and tasks](https://community.d2l.com/brightspace/kb/articles/18042-manage-course-events-with-the-calendar-tool),
and [upcoming work in Brightspace Pulse](https://community.d2l.com/brightspace/kb/articles/33744-view-upcoming-work-in-brightspace-pulse).

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
`last_success_at`, and either null failure fields or the bounded partial-result
code described below. Confirm one real event's date and time against
Brightspace and the next morning digest. This is **live acceptance**; local
parser, ingestion, and digest tests do not establish it.

Date-only entries use 23:59:59.999 in `DIGEST_TIMEZONE` as a conservative
reminder because the current deadline table stores only instants. A floating
calendar time also uses that configured owner timezone; a calendar time with
an explicit `TZID` or UTC marker keeps that meaning. Do not describe a
synthetic end-of-day time as a time the teacher supplied.

With no URL configured, the hourly job makes no feed request and the digest
says `Brightspace: not set up`. If a previously configured URL is removed, the
stored source records `brightspace_configuration_missing` and retains its
last-known deadlines rather than claiming the feed is empty.

After setup and an approved deployment, Sid can say `check D2L now` in his
ordinary Telegram conversation. This is an owner-only natural-language turn,
not a slash command. It uses the same bounded feed path as the hourly job and
allows at most one request per five minutes across Worker isolates. The reply
names a successful refresh time in the configured owner timezone, a fixed
failure code with the timestamped last-known snapshot, or the timestamped
snapshot used during the cooldown. It makes no feed request while the URL is
absent or the source is disabled. The first production load still needs the
runtime-duration acceptance recorded in [KNOWN_ISSUES.md](../../KNOWN_ISSUES.md).

Source-health meanings are fixed codes and never contain the private URL or
response body:

- `brightspace_feed_url_invalid`: the configured value is not an acceptable
  HTTPS subscription URL. Re-copy it through the attended setup above.
- `brightspace_feed_redirected`: the feed redirected. Jarvis refuses redirects
  so a bearer request cannot turn into a login/browser flow or move silently
  to another origin.
- `brightspace_feed_rejected`: Brightspace refused the request. Re-copy or
  revoke/reissue the feed through Brightspace; do not supply a password.
- `brightspace_feed_unavailable`: a timeout, rate limit, server error, or
  network failure. The next hourly run retries normally.
- `brightspace_timezone_invalid`: `DIGEST_TIMEZONE` is not an IANA timezone.
  Correct Worker configuration; re-copying the private feed URL will not help.
- `brightspace_feed_too_large` or `brightspace_feed_invalid`: the response is
  outside the bounded iCalendar contract. Last-known deadlines stay visible
  and the digest names the source failure.
- `source_items_truncated:<count>`: the refresh succeeded, but the
  14-days-past/120-days-ahead window exceeded its bounded write set. Jarvis
  keeps upcoming live items first (soonest first), then the newest past-due
  live items, and separately keeps the 180 cancellations nearest to now. It
  records every omitted live item or cancellation and reports that bounded
  partial result in the digest instead of treating the whole source as failed.
  A stale bounded source reports both the truncation and stale-sync gaps.
