# Jarvis in iPhone Calendar

Sid tracks everything in iPhone Calendar, and school is his top priority (Sid,
2026-09-23). This is a subscription to Jarvis's saved school data. It does not
collect new data from Brightspace or make an unavailable school source work.

## Enable and subscribe — owner actions

1. After independent review and a separately authorized deployment of this code,
   create a random URL-safe secret of at least 32 characters in your password
   manager. Use letters, digits, `-` and `_`. Do not reuse another credential.
2. Set the optional Worker secret `CALENDAR_FEED_TOKEN` through the Cloudflare
   dashboard, or from the approved clean deploy checkout in PowerShell 7.3+:

   ```powershell
   cd C:\javis
   $PSNativeCommandArgumentPassing = 'Standard'
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   $gateway = (Resolve-Path 'apps/cloud-gateway/wrangler.toml').Path
   & node $wrangler secret put CALENDAR_FEED_TOKEN --config $gateway --env ''
   ```

   Enter the value only at the interactive private prompt, **never piped**. Do not include it in a command,
   screenshot, ticket, chat, log, or commit. The existing `OWNER_PRINCIPAL_ID`
   binding must identify Sid; without it the feed returns 503.
3. Privately construct `https://<gateway-host>/calendar/<token>.ics` using the
   gateway's HTTPS hostname and that secret. Never post the completed URL.
4. On the iPhone, search **Settings** for **Subscribed Calendar**. Menu names
   vary by iOS version. Add a calendar subscription with the private HTTPS URL,
   give it a recognizable name such as “Jarvis — School”, and save it.
5. Show that calendar in the Calendar app. Check a known catch-up task and a
   known deadline against the saved Jarvis plan, including their date and time.
   Updates arrive when iOS next refreshes the subscription; this is not a push
   notification channel and there is no verified refresh-time guarantee.
6. If setup shows **Remove Alerts**, it must be **off** for alerts to fire.
   **Unverified on Sid's iPhone:** the menu wording and switch behavior need an
   on-device check. Check Calendar notification permissions and verify an alert
   for a known future deadline. No live subscription or alert test was performed
   by the builder. Do not rely on this feed as the only reminder until checked.

## What appears

- Every planned catch-up action for an active owner course, including saved
  past actions still marked planned: `Course: Task (25 min)`, all day on its
  saved local date. Completed and superseded actions disappear on refresh.
- Open deadlines from 14 days before the request time up to, but excluding,
  90 days after it. Their saved UTC due time is a timed event, with a display
  alarm `leadMinutes` before it. The deadline store is currently single-owner
  and has no principal column.
- Dated active university application and workflow items from
  `listApplicationItemsByDueDate` and `listWorkflowItemsByDueDate`, each titled
  `[verified]` or `[unverified]` using its saved verification state. Undated
  items are omitted. Date-only items are all day; workflow instants retain
  their absolute UTC time. These two lists are not truncated to digest limits.

The feed serializes stored plans; it does not choose tasks or assign certainty.
The subscription is read-only. Editing or completing an event on the phone does
not update Jarvis. Stable row-based UIDs allow a refreshed event to retain its
identity when a title, date or workflow revision changes. All-day events explicitly
end on the next date (an exclusive `DTEND`); timed deadlines have no invented
duration. No all-day alert time is invented.

## Privacy, rotation and failures

**Anyone with the URL can read the feed.** The URL is a bearer credential,
including anyone receiving a forwarded link or accessing a subscription account.
Keep it private. Application code does not log or echo it. Before enabling any
proxy or platform request logging, ensure it does not retain the full calendar
path; platform/access-log settings were not inspected or changed here.

To revoke a leaked URL, replace `CALENDAR_FEED_TOKEN` with a new random secret
using the same owner step, then update or recreate the iPhone subscription with
the new private URL. Once the updated secret is active, the old URL returns 404
on future requests.
Removing the secret disables the feed. Rotation cannot erase calendar data
someone has already downloaded, or cached events already on a device.

All calendar responses carry `Cache-Control: private, no-store`. An unset,
too-short or incorrect secret and malformed calendar paths return the same 404.
This is deliberately silent: a secret with a trailing newline or space, or fewer
than 32 characters, gives the same **404 Not found** as a wrong URL. Check the
value privately and re-enter it at the interactive prompt without whitespace;
do not pipe it or post the URL to diagnose it. Only GET is supported. Repository
failures return a generic 503 rather than an empty successful calendar.
The limiter runs **after authentication**: wrong credentials still get 404 and
do not consume the authenticated allowance. Authenticated requests use a separate per-isolate
allowance with the same limits as `/health`: 30 per minute, 43,200 per day.
Exceeding it returns 429. Like health, this is not a global cross-isolate limit.

No migration, secret operation, deployment, live request or iPhone verification
is part of the builder change.
