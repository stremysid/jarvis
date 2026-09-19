# Google Classroom OAuth owner setup

> ## THIS ROUTE IS DEAD FOR SID. DO NOT SEND HIM HERE.
>
> **Established 2026-09-17, by Sid, and re-confirmed by him on 2026-09-18 after
> a reviewer session sent him here a second time.**
>
> **His school account cannot reach `console.cloud.google.com`.** The board runs
> Microsoft 365 and does not allow Google accounts. No Cloud Console means no
> OAuth client, which means no client id, no client secret and no refresh token.
> Every step below depends on the first one, and the first one is impossible.
>
> A personal Google account does not rescue it: the Classroom data belongs to
> the school account, so consent must come from the school account, and the
> board blocks it.
>
> **The route that works** is the one already built and already live on his side:
> Classroom notification emails reach his school mailbox, his Outlook web rule
> forwards them to `school@onesid.ca`, and Cloudflare Email Routing delivers
> them to the gateway's `email()` handler. What is missing is ours, not his —
> `d2l-email-parser.ts` understands D2L notifications only, so a Classroom
> notification currently arrives and is ignored.
>
> **Do not ask Sid to do anything in this file.** Asking him again costs him
> effort and trust, and it has now happened twice.

## Historical: what the flow would have been

Kept because the Worker-side code, the three bindings and the failure codes are
real and would be reused if the board ever permits Google accounts.

This runbook is for Sid. It creates the three production Worker secrets that
let the hourly Cloudflare job read Sid's own Classroom courses and coursework
while every Windows PC is off. It does **not** deploy this branch, apply a
migration, change a deadline, or grant write access to Classroom.

Do this only after the Classroom ingestion PR has passed Claude review, merged,
and the owner has separately approved production setup. Stop if the school
Google Workspace administrator blocks the app or either read-only scope. Do
not work around an administrator policy with a personal account.

Official references:

- [Google's Classroom scope list](https://developers.google.com/workspace/classroom/guides/auth)
- [Google's OAuth Playground](https://developers.google.com/oauthplayground/)
- [Google's offline-access and refresh-token flow](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
- [Google's refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Google Workspace administrator app-access controls](https://support.google.com/a/answer/7281227)
- [Google's coursework-list endpoint](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork/list)

## What Sid approves

The consent screen should request exactly these scopes:

```text
https://www.googleapis.com/auth/classroom.courses.readonly
https://www.googleapis.com/auth/classroom.coursework.me.readonly
```

The second scope can expose Sid's coursework and grades even though this first
slice reads only coursework metadata. Do not add roster, teacher, write, Drive,
email, or profile scopes. The Cloudflare Worker uses offline access so it can
refresh an access token when Sid's PCs are off.

## Create the refresh token in Google's browser UI

1. In [Google Cloud Console](https://console.cloud.google.com/), Sid taps to
   create or select a project and enables the Google Classroom API.
2. Preflight the school policy before generating a credential. A Workspace
   administrator can block unconfigured third-party apps, and Education
   accounts designated under 18 can have stricter controls. If consent says the
   institution must review the app, Sid may tap to request that review; stop
   rather than weakening the scopes or using someone else's account.
3. Configure the OAuth consent screen for Sid's school account. An external
   app in **Testing** normally issues a refresh token that expires after seven
   days when it requests more than basic identity scopes. That is acceptable
   only for a labelled short preflight, not an always-on production connector.
   Before activation, establish the durable publishing/audience state and any
   Google or school verification it requires. If that cannot be established,
   keep using owner-reported deadlines.
4. Create an OAuth client of type **Web application**. Add this exact authorized
   redirect URI:

   ```text
   https://developers.google.com/oauthplayground
   ```

5. Open [Google's OAuth Playground](https://developers.google.com/oauthplayground/).
   In its settings, select **Use your own OAuth credentials**, **Server-side**,
   **Offline**, and **Consent Screen**. Google states that the Playground sends
   these credentials to its server to proxy the flow and does not log them.
6. Paste that client's ID and secret into the Playground. Enter only the two
   scopes above, authorize them while signed in as Sid's school account, then
   exchange the authorization code for tokens.
7. Keep the resulting refresh token private. Do not paste the client secret or
   either token into chat, a repository file, a command argument, a screenshot,
   or an evidence log. Google's generic Playground credentials issue refresh
   tokens that expire after 24 hours; **Use your own OAuth credentials** avoids
   that Playground-specific expiry. It does **not** override Google's separate
   seven-day expiry for an external app left in Testing.
8. After the refresh token exists, remove the Playground redirect URI from the
   OAuth client. The already-issued refresh token does not use a redirect URI.

If no refresh token appears, revoke the test grant in the Google account and
repeat with Offline and Consent Screen selected. Do not substitute the short-
lived access token for `GOOGLE_REFRESH_TOKEN`.

## Store the three Worker secrets from PowerShell 7

Use the reviewed deployment checkout. The first command is the directory
change, as required:

```powershell
cd 'C:\Users\Sid\jarvis-deploy'
pnpm.cmd install --frozen-lockfile
npx.cmd wrangler whoami
```

Confirm `whoami` names the intended Cloudflare account. If PowerShell
transcription is active, stop it before entering secrets. Each command below
opens Wrangler's interactive prompt; paste the value only there. Omitting
`--env` intentionally targets the top-level production Worker configuration.

```powershell
npx.cmd wrangler secret put GOOGLE_CLIENT_ID --config .\apps\cloud-gateway\wrangler.toml
npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET --config .\apps\cloud-gateway\wrangler.toml
npx.cmd wrangler secret put GOOGLE_REFRESH_TOKEN --config .\apps\cloud-gateway\wrangler.toml
npx.cmd wrangler secret list --config .\apps\cloud-gateway\wrangler.toml
```

The last command must show all three names. Record names and presence only,
never values. Clear the clipboard after all three prompts if it still holds a
credential. Secret creation alone does not publish code; activation still
requires the separately reviewed and owner-approved gateway deployment.

## Verify after an approved deployment

Wait for the next hourly firing, then use this read-only check in the same
PowerShell 7 window:

```powershell
npx.cmd wrangler d1 execute jarvis --remote --config .\apps\cloud-gateway\wrangler.toml --command "SELECT source_id, active, last_success_at, last_failure, last_failure_at FROM deadline_sources WHERE source_id = 'google-classroom';"
```

Expected outcome: one active `google-classroom` row, a recent
`last_success_at`, and null failure fields. Then verify one real Classroom item
whose teacher set both a date and a time: the stored instant and the morning
digest must represent the same Ontario wall-clock deadline shown in Classroom.
This is **live acceptance**, not established by the local tests.

The current deadline schema stores only an instant. For coursework with a date
but no teacher-set time, this slice uses the end of that day in
`DIGEST_TIMEZONE` as a conservative reminder. It cannot preserve or display
native date-only precision without a later schema migration; do not describe
that synthetic end-of-day value as a time the teacher set.

Failure meanings:

- `classroom_configuration_incomplete`: one or two of the three bindings are
  missing or empty. Check secret names; do not print their values.
- `classroom_configuration_missing`: a source synced before but all three
  bindings are now absent. Restore the reviewed secrets or deliberately mark
  the source inactive; do not let stale deadlines look current.
- `google_oauth_rejected`: the grant, client, or refresh token was rejected.
  Re-authorize through the consent flow; do not keep retrying copied tokens.
- `classroom_rejected`: Google accepted OAuth but refused the Classroom call.
  Check school administrator policy and the exact two scopes.
- `google_oauth_unavailable` or `classroom_unavailable`: retryable Google-side
  or network failure. The morning digest retains the last known deadlines and
  names the source failure instead of reporting a false empty list.
