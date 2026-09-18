# D2L notification-email owner setup

This runbook is for Sid. LDSB Minds Online does not expose a calendar or
iCalendar feed for his account, so the calendar-feed runbook is not an
alternative for this board. This route receives D2L notifications at one
unguessable `school-<random>@onesid.ca` capability address, after the school
Microsoft 365 mailbox forwards them. It does not use Sid's school or personal
mailbox as Jarvis's destination.

Do this only after the email-ingestion PR has passed review, migration `0033`
has passed the scratch rehearsal and been applied by Sid, and the reviewed
Worker has been deployed with separate production approval. The steps below
change live DNS, mail routing, Worker configuration, and D2L settings. They are
owner-attended actions, not part of the build PR.

Cloudflare's current Email Routing instructions are
[Create rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
and [Route to an Email Worker](https://developers.cloudflare.com/email-service/get-started/route-emails/).
D2L's current owner-facing path is documented under
[Change personal settings](https://community.d2l.com/brightspace/kb/articles/18036-change-personal-settings-in-brightspace).

## Prepare the capability and exact sender-domain pins

1. In a password manager, generate at least 24 random lowercase letters and
   digits. Construct `school-<random>@onesid.ca`. Do not reuse an address,
   substitute `school@onesid.ca`, or put the address in chat, source, a commit,
   a screenshot, a shell command argument, or an evidence log.
2. From a real D2L notification already visible in the school mailbox, record
   only the exact domain after `@` in its visible `From:` address. Do not
   guess it and do not substitute the Microsoft forwarding tenant or an
   envelope-sender domain.
3. If no real example exists, use `untrusted.invalid` as that source's
   temporary deny-all pin. After the first routed message is quarantined, use
   the safe query below to read its domain, verify that domain against the real
   message in Outlook, replace the temporary pin, and ask D2L to send a new
   verification message. Never approve the first message merely because it
   reached the capability address. The `.invalid` value is a bootstrap block,
   not an expected sender domain and not live acceptance.

Store the values only through Wrangler's interactive secret prompt. Use
the reviewed deployment checkout in PowerShell 7, with the directory change
first:

```powershell
cd 'C:\Users\Sid\jarvis-deploy'
pnpm.cmd install --frozen-lockfile
$PSNativeCommandArgumentPassing = 'Standard'
$wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
$gateway = (Resolve-Path 'apps/cloud-gateway/wrangler.toml').Path
& node $wrangler whoami
```

Confirm `whoami` names Sid's existing Cloudflare account. Stop any PowerShell
transcription before continuing. Each command below opens an interactive
prompt; paste only into that prompt:

```powershell
& node $wrangler secret put SCHOOL_EMAIL_INGEST_ADDRESS --config $gateway --env ''
& node $wrangler secret put D2L_EMAIL_FROM_DOMAINS --config $gateway --env ''
& node $wrangler secret list --config $gateway --env ''
```

The domain value is a comma-separated list of exact domains, without `@`,
spaces, wildcards, or URLs. Keep `untrusted.invalid` until the real domain is
known; never broaden a pin to a board parent domain merely to make setup pass.
The list must show both variable names; record names and presence only, never
values. These commands update configuration but do not by themselves prove the
route or parser works.

The `From:` pin only decides which messages are worth examining. It authorises
nothing: a message creates a deadline or a grade only when it also carries
positive authentication evidence -- a DKIM signature naming the pinned
domain, the receiving MTA's own `dkim=pass` for a pinned signer, or an ARC
chain sealed by a forwarder Sid has pinned whose original authentication
passed. Anything else is quarantined as `authentication_unproven`, and a
message with no evidence at all is never treated as a quiet success.

`D2L_EMAIL_ARC_SEALER_DOMAINS` is optional and is only needed if Microsoft
365 forwarding rewrites `From:` or breaks D2L's DKIM signature. If the first
real notification quarantines as `authentication_unproven` while the school
mailbox did forward it, look at the stored header names and the ARC seal your
tenant added, then set that secret to the exact `d=` domain of the seal (an
`onmicrosoft.com` tenant domain or the board domain) and ask D2L to send again.
Leave it unset otherwise: an unpinned chain is never believed.

## Route the exact address to the gateway in Cloudflare

1. In the existing Cloudflare account, open **Compute**, **Email Service**,
   **Email Routing**, and select `onesid.ca`.
2. If Email Routing is not enabled, choose **Onboard domain** and review the
   offered MX and TXT changes before accepting them. Stop if they would replace
   an existing mail service that must keep receiving mail.
3. Under **Routing rules**, choose **Create rule**.
4. Enter only the exact random local part after **Custom address** and select
   `onesid.ca`. Do not create `school@onesid.ca`, a wildcard, or a catch-all
   route to the gateway.
5. For **Action**, choose **Send to a Worker** and select the reviewed Jarvis
   cloud-gateway Worker. Save the rule and leave it active.
6. Confirm there is no earlier overlapping rule. Cloudflare applies the first
   matching custom-address rule, so an earlier match can keep the Worker from
   receiving the message.

The Worker also compares the delivery's envelope recipient with the configured
capability. A delivery for any other address is quarantined even if Cloudflare
routes it to this Worker by mistake.

## Point the existing school-mail forward at the capability

Update Sid's existing Microsoft 365 school-mail forwarding destination to the
same capability address. Keep a copy in the school mailbox only if Sid wants
one for diagnosis; Jarvis must not forward through or deliver to a personal
mailbox. If the board blocks external forwarding, stop and record the block.
Do not add browser automation or a second Cloudflare account as a workaround.

## Verify and enable notifications in D2L

1. Sign in to LDSB Minds Online in Sid's normal browser.
2. Open Sid's username menu, choose **Notifications**, then under **Contact
   Methods** choose **Change your email settings**.
3. Select **Use custom email**, enter the exact capability address, and save.
4. D2L sends an address-verification message. Wait for Jarvis's fixed Telegram
   notice. It includes the link or code and says Jarvis did not open it. Sid
   opens the link or enters the code himself; Jarvis never follows it, and the
   only link it will ever relay is one on a pinned D2L host.
5. If instead the notice says the verification message was refused, nothing
   was opened and no link was passed on. That means the message carried no
   authentication evidence, or its link pointed somewhere other than a pinned
   D2L host. Verify the address in D2L itself, then read the refusal reason
   with the query in the acceptance section below.
6. Return to **Notifications**. Under **Instant Notifications**, select email
   delivery for assignment due or updated, feedback or grade released, new
   content, and announcements. Under **Customize Notifications**, enable grade
   values if Sid wants numeric grades in the digest, then save.

If the D2L page does not offer custom email, that permission is board-managed;
D2L documents the controlling permission under
[Notifications permissions](https://community.d2l.com/brightspace/kb/articles/4502-notifications-permissions).
Stop and record the block rather than supplying Jarvis with a school password.

## Read-only acceptance after setup

In the same PowerShell 7 window, inspect only non-secret receipt fields:

```powershell
& node $wrangler d1 execute jarvis --remote --config $gateway --env '' --command "SELECT status, event_kind, quarantine_reason, from_domain, header_names_json, received_at, processed_at FROM d2l_email_messages ORDER BY received_at DESC LIMIT 10;"
& node $wrangler d1 execute jarvis --remote --config $gateway --env '' --command "SELECT source_id, active, last_success_at, last_failure, last_failure_at FROM deadline_sources WHERE source_id = 'd2l-notification-email';"
```

Do not select `raw_mime_base64`, `authentication_json`, the ingestion key, or
the configured address into a terminal log. Expected acceptance evidence is:

- one real verification message surfaces exactly once on Telegram and Sid,
  not Jarvis, completes it;
- a verification message that cannot be proven to come from D2L produces the
  refusal notice instead, with no link in it;
- one real assignment notification creates or updates one Toronto-time
  deadline, and re-delivery does not create another;
- one real grade notification appears in the existing school digest path;
- a message from an unpinned domain is quarantined and creates no deadline,
  grade, or memory; and
- the stored header-name list shows what Cloudflare and Microsoft actually
  supplied. Authentication-header absence remains `unknown`, not `pass`, and
  a date-only due date is stored with `dueTimeSupplied: false` rather than an
  invented time.

Refused mail is evidence, not a record: the newest five quarantined receipts
per owner are kept, anything older than 30 days is pruned, and a message
refused on its recipient or its visible `From:` keeps only its hash, header
names and reason. The digest says `nothing received in 7 days` when this
source goes quiet, because mail that never arrives is the one failure it
cannot report any other way.

Local fixtures establish parser and guard behaviour, not live template,
sender-domain, forwarding, header-provenance, Telegram, or delivery acceptance.
