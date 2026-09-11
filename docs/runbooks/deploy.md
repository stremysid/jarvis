# Deploy the gateway and watchdog

R0 deploys the existing Workers. Calling remains R1. Complete the R0 review
with Claude Opus 5 at high effort before publishing. Record the reviewed
commit and obtain the owner's production confirmation before migrations or
deployment. A successful bundle is not evidence that production works.

## Local checks and exact targets

Use Node 24.19.0 or later in the Node 24 line, the pinned pnpm dependencies,
and PowerShell 7.3 or later (`pwsh`). From the repository root:

```powershell
pnpm install --frozen-lockfile
node --test scripts/test/deploy.test.mjs
pwsh -NoProfile -File scripts/deploy.ps1
pwsh -NoProfile -File scripts/deploy-watchdog.ps1
```

Both scripts default to a local Wrangler dry-run. `-Publish` selects a real
deployment and prompts for confirmation; `-Publish -WhatIf` displays the
target without invoking Wrangler. Neither script applies migrations.

| Script | Config | Production Worker |
|---|---|---|
| `scripts/deploy.ps1` | `apps/cloud-gateway/wrangler.toml` | `jarvis-cloud-gateway` |
| `scripts/deploy-watchdog.ps1` | `apps/watchdog/wrangler.toml` | `jarvis-watchdog` |

Production is the **top-level environment**, not a named `production`
environment. `env.test` is only for tests. Every command below explicitly
passes `--env ''`, equivalent to `--env=""`. PowerShell's Standard native
argument mode preserves that empty value. Invoke Node directly, because a
`.cmd` wrapper can parse it again. The script tests measure the arguments
received by a native Node process, including from paths with spaces.

For the manual commands below, first run this in PowerShell 7.3+ from the
repository root:

```powershell
$PSNativeCommandArgumentPassing = 'Standard'
$wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
$gateway = (Resolve-Path 'apps/cloud-gateway/wrangler.toml').Path
$watchdog = (Resolve-Path 'apps/watchdog/wrangler.toml').Path
```

## Secrets and settings

Enter values only into Wrangler's interactive secret prompt, with shell
transcription off. Never put values in arguments, source, fixtures, logs,
chat, or a local secrets file. This is the command pattern; replace
`SECRET_NAME` with a name from the tables:

```powershell
& node $wrangler secret put SECRET_NAME --config $gateway --env ''
```

For watchdog names, use `$watchdog` instead. Check presence using
`secret list` with the same config and empty environment; record names and
presence only. Do not dump authentication profiles or binding values.

The gateway declares exactly these four non-optional strings from `env.ts`
in `[secrets].required` and `[env.test.secrets].required`:

- `OWNER_VOICE_IDENTITY_ID`
- `GUEST_PIN_PEPPER_V1`
- `AUTHENTICATION_BUDGET_PEPPER`
- `IDENTITY_CHALLENGE_HMAC_PEPPER`

`required` checks that a secret exists before deployment. It does not
create, retain, rotate, or delete a stored secret. Test configuration uses
synthetic values for all four; it never needs production credentials.

All other string bindings are optional in `env.ts`, so they stay out of
`required`. Their presence still determines which R0 capabilities work:

| Capability | Optional binding names to configure for that capability |
|---|---|
| Telegram text | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` |
| Model responses | `DEEPSEEK_API_KEY`; `DEEPSEEK_MODEL` overrides the model |
| Device sync | `SYNC_CONTINUATION_SECRET` |
| Scheduled jobs and digest | `OWNER_PRINCIPAL_ID`, `DIGEST_TIMEZONE` |
| Gateway heartbeat | `WATCHDOG_HEARTBEAT_URL`, `WATCHDOG_HEARTBEAT_SECRET` |
| Private repository polling | `GITHUB_TOKEN` with read-only access to tracked repositories |
| R1 calling, deferred | `PUBLIC_ORIGIN`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_E164`, `DEFAULT_GUEST_PIN` |
| Classroom ingestion, deferred | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |

`OWNER_PRINCIPAL_ID` must identify the existing owner. `DIGEST_TIMEZONE`
is the owner's IANA timezone, and `TELEGRAM_BOT_USERNAME` omits the `@`.
`WATCHDOG_HEARTBEAT_URL` is the watchdog's actual HTTPS `/heartbeat` URL.
The heartbeat secret must agree between the two Workers.

The watchdog has its own settings and must use its own bot and chat:

| Purpose | Binding names |
|---|---|
| Independent alert channel | `WATCHDOG_TELEGRAM_BOT_TOKEN`, `WATCHDOG_TELEGRAM_CHAT_ID` |
| Authenticated heartbeat reception | `WATCHDOG_HEARTBEAT_SECRET` |
| Optional self-monitoring overrides | `WATCHDOG_SELF_COMPONENT`, `WATCHDOG_SELF_INTERVAL_SECONDS` |
| Must-report components | `WATCHDOG_REQUIRED_COMPONENTS` (non-secret var, R0: `cloud-gateway`) |

The must-report list is comma-separated component names, not URLs. Its R0
default and checked-in value are `cloud-gateway`. Add local nodes only when
their later milestone deploys them. Missing rows alert without fabricating
heartbeats; duplicate names are assessed once. Empty names or malformed
lists make watchdog health return 503 and prevent a healthy cycle record.
Verify the effective dashboard value too: deployment preserves existing vars.

The gateway owns D1 migrations. The watchdog binds the same `jarvis`
database and never applies migrations. The gateway also binds the
`jarvis-archive` R2 bucket and `CALL_SESSION` Durable Object.

The owner confirmed R0 item 2 complete: Wrangler login, rotation of the
three peppers and DeepSeek key on `jarvis-cloud-gateway`, and revocation
of the old DeepSeek key. No values were shared. `PIN_VERIFIER_JSON` is
absent from the configuration and its two generators are retired. Item 5's
gateway deployment is now complete; deletion of the stored legacy secret
still requires the separate owner confirmation in step 5 below.

## R0 item 5: migrate, then deploy

**Done 2026-09-11.** Migrations `0008`-`0013` applied at 04:39 UTC and
verified against `d1_migrations`; both Workers published from the reviewed
commit. The steps below remain the procedure for any later deployment, and
for reconstructing what was done. Never assume live state from repository
contents -- query it, as step 2 does.

1. Finish local checks and the required cross-vendor review. Record the
   commit, the current deployed version IDs, and the D1 recovery point in a
   protected operator record. Verify the Cloudflare account and the config
   targets above without copying private account identifiers into evidence.
2. Check pending migrations against the production database:

   ```powershell
   & node $wrangler d1 migrations list jarvis --remote --config $gateway --env ''
   ```

   For the initial R0 deploy, expect unapplied files from
   `0008_autonomy.sql` through `0013_scheduled_runs.sql`. Stop on unexpected
   earlier or later migrations and reconcile the database before applying.
   Do not assume `migrations apply` is limited to those six files: it applies
   every pending migration in the configured directory.
3. After the owner's confirmation of that inventory and production target:

   ```powershell
   & node $wrangler d1 migrations apply jarvis --remote --config $gateway --env ''
   ```

   Stop on a nonzero exit. Earlier successful migrations remain applied
   if a later migration fails. List again and confirm none of the six
   remains pending; never deploy after an unresolved migration failure.
4. Verify the capability settings above, including the watchdog's separate
   bot. Publish each Worker with its own confirmation:

   ```powershell
   ./scripts/deploy.ps1 -Publish
   ./scripts/deploy-watchdog.ps1 -Publish
   ```

   The scripts preserve dashboard variables with `--keep-vars` and refuse
   conflicting remote edits with `--strict`. They disable autoconfiguration
   so Wrangler does not rewrite this deployment's configuration.
5. After the item 5 gateway deploy is confirmed, the owner can retire the
   stored legacy secret as a separate, explicitly confirmed deletion:

   ```powershell
   & node $wrangler secret delete PIN_VERIFIER_JSON --config $gateway --env ''
   ```

   Do not run this during item 3 or recreate the retired verifier. A
   rollback to an older version that reads it needs separate assessment.

## A first-deployment DOWN alert must eventually recover

The watchdog alerts on a required component it has never seen, and the
gateway cannot heartbeat until `WATCHDOG_HEARTBEAT_URL` names a watchdog
that exists. If the watchdog checks before the first successful heartbeat,
it sends `DOWN cloud-gateway -- required component has never reported`.
PR #7 records that initial alert. Once settings are in place and the gateway
runs successfully, verify that the watchdog actually receives the heartbeat
and closes the alert. Continued absence is not proof of a harmless startup
condition: check the scheduled heartbeat result and deployed URL/secret
configuration without exposing values or manufacturing a heartbeat.

This is the alarm working. Do not undo any configuration in response to it.
Setting `WATCHDOG_REQUIRED_COMPONENTS` to an empty string to suppress it
does not work either: an empty list fails validation and degrades watchdog
health instead.

### Diagnose the actual heartbeat result

On September 11 at 05:15:20 UTC, a real gateway cron reported
`sent: false, reason: rejected, detail: status 404`. An external unauthenticated
POST to the public endpoint returned 401 at 05:19:30 UTC. These are different
requests and statuses; the latter does not prove that the two Workers hold
different secrets.

1. Worker secrets cannot be read back. Sid re-sets `WATCHDOG_HEARTBEAT_URL`
   to the exact public endpoint below, then observes the next real cron.
   This publishes a production setting and is an owner action. The literal
   is a public URL, not an authentication credential; never substitute a
   credential into a command like this. With the PowerShell setup above:

   ```powershell
   'https://jarvis-watchdog.twilight-tree-70b1.workers.dev/heartbeat' |
     & node $wrangler secret put WATCHDOG_HEARTBEAT_URL --config $gateway --env ''
   ```

2. If a real cron still gets 404 after that URL reset, investigate the
   gateway's outbound Worker-to-Worker routing. This occurred again at
   05:30:19 UTC after the mailbox reported both settings re-set. Read-only
   metadata for the gateway deployed at 05:24:28 UTC shows no
   `global_fetch_strictly_public` flag or watchdog service binding.
   Cloudflare's [fetch documentation](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
   requires one of those mechanisms for Worker-to-Worker fetch; its
   [compatibility-flag documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
   explains how the flag sends requests through public routing. PR #8 adds
   that flag to the gateway, preserving the existing HTTP design. It changes
   global fetch routing for the gateway. After cross-vendor review, Sid
   deploys it through the existing gateway script and records the version.
   Local mocks and a dry-run cannot verify Cloudflare's edge routing; require
   a subsequent real cron's heartbeat receipt before declaring it fixed.
3. A 401 from the gateway's actual configured request supports checking the
   shared secret on both Workers; Sid handles any required correction.
   `not_configured` means missing settings; `unreachable` means the request
   threw or timed out. Retain only the structural outcome/status from logs,
   never authorization headers, request bodies or unfiltered traces.
4. After an owner correction, observe a real cron, an advancing
   `component_liveness` row for `cloud-gateway`, and recovery of its open
   DOWN alert. Do not manually insert the row or post a fabricated heartbeat.

## R0 item 6: owner action, external watchdog monitor

1. After item 5, record the watchdog URL returned by the first deployment.
   The URL to monitor is
   `https://jarvis-watchdog.<sid-subdomain>.workers.dev/health`.
   The September 11 deployment's verified target is
   `https://jarvis-watchdog.twilight-tree-70b1.workers.dev/health` (200 at
   05:16 UTC). Use that target in UptimeRobot. The shape above is retained
   for future deployments under another subdomain. Do not use the gateway's
   `/health` here.
2. In Sid's UptimeRobot account, create an HTTPS monitor using **HTTP GET**
   every **5 minutes**. Accept **200 only**. Alert on any non-200 response
   (including 503), timeout, DNS failure, or TLS failure. No body keyword or
   JSON parsing is needed. The free-tier monitor is the selected service.
3. Select **Sid's verified UptimeRobot notification destination** and verify
   delivery using the service's test notification. Keep the address or
   other private destination details in the account, not repository evidence.
   Record the monitor name, interval, and test-delivery outcome only.
4. Verify GET returns 503 before a first cycle is recorded or when required
   configuration is missing, and 200 after the configured watchdog records
   a healthy, recent cycle. The default self-heartbeat age allowance is
   900 seconds; stale self state returns 503. Confirm the monitor sees a
   successful check and that the watchdog's independent Telegram channel
   can deliver an alert. An absent gateway heartbeat should produce its
   must-report alert. Do not fabricate a heartbeat to make this check pass.
5. Record external-monitor completion separately from deployment. Until
   these actions are observed complete, **nothing watches the watchdog**.
   A timer inside the same Worker is not a substitute.

## R0 items 6/7: code behavior to verify after deployment

The gateway now routes GET `/health` to its existing coarse liveness handler
and supports a bodyless HEAD. It reveals no private readiness snapshot and
does not query D1. Its independent per-isolate allowance is 30 requests per
minute (429 when exhausted). It proves the HTTP process answers, not that
scheduled work or dependencies are healthy.

The existing `0 * * * *` job now calls `ArchivalWorker`/`ArchivalService`
once per claimed hour, even without GitHub configuration. It publishes at
most one new segment of 24 events, plus the service's existing bounded
reconciliation. Retention, verified R2 readback, sealing, circuit checks,
and delivered-only D1 purge are unchanged. Old undelivered events may be
copied but remain in D1; young events are retained. A failed upload records
a failed hourly run; other jobs' heartbeats do not certify archival. GitHub
polling runs afterward when configured; adding its credential after an hour has
already been claimed takes effect on the next hour.

## Exit evidence and recovery

Items 6/7 passed cross-vendor review, merged in PR #6 and are deployed.
The external-monitor owner actions above remain pending. Green gateway
scheduled runs are not proof of heartbeat delivery; inspect both the
gateway result and the watchdog's `cloud-gateway` row.

Record the exact commit and deployed versions, migration outcomes, and UTC
times for CI green on `main`, owner Telegram `/status` and `/queue` replies,
a real cron followed by its watchdog heartbeat, and the actual morning
digest saying "nothing due". Keep payloads and credentials out of evidence.
A manually invoked digest does not prove the morning schedule.

If a deployed Worker regresses, stop further mutations, choose a previously
recorded compatible version, and get owner confirmation before rollback:

```powershell
& node $wrangler rollback VERSION_ID --config $gateway --env ''
```

Use `$watchdog` for the watchdog. Rollback restores Worker code, not D1/R2
data or schema. Verify compatibility with applied migrations and current
secrets first; never undo append-only tables to make old code run. Recheck
the affected live behavior after recovery.

Command and configuration references: [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
