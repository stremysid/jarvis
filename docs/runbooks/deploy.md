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

The gateway owns D1 migrations. The watchdog binds the same `jarvis`
database and never applies migrations. The gateway also binds the
`jarvis-archive` R2 bucket and `CALL_SESSION` Durable Object.

The owner confirmed R0 item 2 complete: Wrangler login, rotation of the
three peppers and DeepSeek key on `jarvis-cloud-gateway`, and revocation
of the old DeepSeek key. No values were shared. `PIN_VERIFIER_JSON` is
absent from the configuration and its two generators are retired. Leave
the **stored** secret alone until the new gateway has deployed in item 5;
the previously live version might still read it.

## R0 item 5: migrate, then deploy

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

## Exit evidence and recovery

R0 items 6 and 7 still require the gateway health route, watchdog must-report
list and external monitor, and hourly R2 archival. Do not infer these from a
successful deploy of items 3 and 4.

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
