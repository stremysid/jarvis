# Owner actions

Everything that only Sid can do. Nothing here can be done by a builder or a reviewer
session — if it could, it would be in [QUEUE.md](QUEUE.md) instead.

**One row per action.** The whole point of this file is that an action cannot be
asked for twice: if it is already here, the answer is "see the row", not a second
request. That failure has happened — Google Classroom consent was ruled out on
2026-09-17 and walked through again on 2026-09-18, because the fact lived in an
agent's memory and never in the repository.

Last regenerated: 2026-09-27, from the migrations directory and the open PRs at the tip of the
default branch. **No production system was queried by this session**, so every production line
below is somebody else's dated observation. Order within a section is the order to do them in.

## The next three actions, and why they are first

1. **Deploy.** The last recorded deploy is 2026-09-24 and predates a large amount of reviewed
   code, including the guest-call privacy fix. Nothing merged since is live.
2. **Before deploying, apply the migrations that code depends on.** They are additive and they
   fail closed, but several features cannot work at all without their schema: the web tools need
   `0049`'s capability row, and nightly consolidation needs `0048`'s recreated trigger.
3. **Then the acceptance checks below**, which are the only way any of it is proven on real
   hardware rather than in tests.

## Deploy results (2026-09-24 evening)

**Done**, from Sid's report of his `wrangler` output. This is the most recent deploy of any kind
recorded in this repository.

| Item | Result |
|---|---|
| Migrations applied | `0040`, `0043`, `0045`, applied 2026-09-25 01:40:48–49 UTC; **D1 is recorded at `0045`** |
| Worker deployed | the revision whose tip is the tool-cap fix (#189), at about 21:41 EDT 2026-09-24. Gateway `d69bd158-3d1b-4a67-a359-f561ebbd0908` (rollback `bda73930-8240-47d1-95ba-b206b67a5362`); watchdog `3018f5fd-7f5f-4192-9c23-496718aedbef` (rollback `c940f9b7-99cf-4194-8f41-489038a34139`) |
| Health and acceptance | Both `/health` returned 200; Telegram `/status`, `/queue`, `/digest` and a normal message answered. **The migration-linked acceptance rows below are not covered by this** |

## Waiting on Sid

| Action | Why only you | State |
|---|---|---|
| **Apply the merged migrations and deploy the reviewed revision** | Only you apply a migration to the real D1 and only you deploy. On the default branch, `0047`–`0056` are merged and recorded as never applied: `0047` call PIN, `0048` note-source trigger, `0049` web tools, `0050`/`0054` owner reminders, `0051` the five confirmed actions, `0052` email inbox, `0053` deadline facts, `0055` owner access, `0056` catch-up planned cap. Apply them in number order after `0045`, following the [remote D1 scratch-proof runbook](runbooks/migration-scratch-proof.md) on a disposable database first. **Recheck the directory and every open PR for the number set before applying** — that is the rule that caught three renumberings in September. Then deploy the matching gateway | **not started; the single largest gap in the repository** |
| **Set `OWNER_ACTION_PIN`** — the four-digit PIN a call asks for before an action done as you | Only you can choose it and only you can write a Worker secret. Apply `0047` with the deploy, then set the secret from PowerShell 7 in the reviewed checkout with `wrangler secret put OWNER_ACTION_PIN`, typing exactly four digits at the prompt, and confirm it with `wrangler secret list`. **What it is for:** your five actions, and nothing else — spending money, sending an email, placing a call, submitting school work, and texting or calling somebody for you. Reading or saying anything Jarvis knows never needs it, memories included. Until it is set, an ordinary owner call works normally and an action that would ask for it goes to `/queue` on Telegram instead. You can say the PIN or key it in; five tries with a 20-second wait between them, `cancel` stops it, and a run of wrong guesses pauses new questions for up to fifteen minutes, never permanently | **not started; the code that reads it is merged and not deployed** |
| Re-enable the `Jarvis boot chain` task, **after** the two rows below pass | The elevated task is what created the Administrators-owned store folder in the first place. It stays off until the manual acceptance below shows the folder is reachable both non-elevated and elevated | **not started; blocked on the row below** |
| Run the **manual acceptance** for the store folder | Start `jarvis serve` by hand **non-elevated** and confirm `%LOCALAPPDATA%\Jarvis\data` is reachable; stop it, start it **elevated**, and confirm the same. This is the only check that meets the real DACL, and only you have an elevated shell. It is also the test nobody can run for you: it decides whether the boot task may be re-enabled | **not started** — if the startup output shows `WARNING ... is owned by`, run that one-time repair first (either `jarvis serve` once from an elevated shell, or the exact `icacls` line the refusal prints) |
| Delete `C:\jarvis-test-scratch` when you decide no further real-DACL run is needed | The scratch directory is the signal that a real-permission test is wanted, so leaving it in place means the next `uv run pytest` runs five tests that change real permissions without anyone choosing to | **not started; your call on timing** |
| Send one real D2L assignment paste | Only you have the real list. Paste it as direct Telegram text and check each course's new/already-saved counts and today's stored blocks, then re-paste to check deduplication. No migration is needed. **This is only worth doing after a deploy that includes the paste work**, which the last recorded deploy does not | **waiting on the deploy above** |
| Try one real deadline, on Telegram and once on a call | Tell Jarvis an assignment and when it is due in your own words, for example `Chem lab report. due 3pm friday`. Check the receipt shows the date and time you meant in your zone, that a day with no time reads date-only, and that Jarvis **asks** you instead of refusing when it is unsure. Mention a submitted one again and check it stays submitted | **waiting on the deploy above** |
| Accept the calendar feed, then subscribe in iPhone Calendar | `CALENDAR_FEED_TOKEN` must be a random secret of at least 32 characters, set through `wrangler secret put`; then subscribe to its private URL. Any **Remove Alerts** switch must be off. Device behaviour is **unverified**. [Setup, rotation and alert checks](runbooks/iphone-calendar-feed.md) | **not started; whether the secret is set is unverified, and the code that serves the feed is not in the last recorded deploy** |
| Accept reminder scheduling and delivery | Ask Jarvis for a study reminder once on Telegram and once on a call. Check the receipt shows your local time, zone, UTC instant and words; observe one Telegram delivery after that instant outside quiet hours; cancel another and confirm it never arrives. A failed or unconfirmed reminder may already have arrived, so check before replacing it | **waiting on the deploy above, which needs `0050` and `0054` applied** |
| **Load and pair the D2L collector on the PC and laptop** | Follow [the collector runbook](runbooks/d2l-extension.md), approve each device code in Telegram, enter the Durham hop once, and check both hosts with D2L tabs closed. The receiver fixes are merged; the extension's host-failure emission is still in [QUEUE](QUEUE.md). The shape probe was supplied on 2026-09-23 — **do not ask for it again** | **waiting on the deploy above and on the extension work**; background access remains unverified |
| Check the probe's **tabs-closed (background) pass** | The in-tab pass is done ([owner run](research/2026-09-23-d2l-probe-owner-run.md)); the background pass has never been run, so background mode is unverified. Only your Opera GX session can test it | **not started** |
| Check one fresh tier-3 confirmation on a supported tool | `0039` is applied and the tap code is deployed. What remains is one fresh confirmation on a tool that actually asks. **Do it before `0051` is applied**: after `0051`, no tool Jarvis can dispatch is among your five, so the only thing that asks is revoking a school collector, and after `0051` that stops asking too. Any confirmation pending when the tool-binding change deploys needs a fresh tap; see [the compatibility note](../KNOWN_ISSUES.md#tier-3-confirmations-issued-before-tool-binding-2026-09-24) | **remaining check, then it closes** |
| Run the live voice smoke and commit the redacted evidence | `pnpm smoke:voice`, then `pnpm release:voice-gate`. Both are built and neither has ever run against production. **They appear in no workflow**, so no CI run substitutes for them. It needs your phone and your provider credit | **not started; the release gate has never been run** |
| First live check of owner voice streaming | After a deploy and your explicit authority to use provider credit: one ordinary owner answer, one harmless named test memory, and a guided draft from a public synthetic answer. Record time to first spoken sentence, indexed tool-call fragments, exactly one completed tool receipt, and spoken text matching the final transcript. Keep only redacted protocol and timing metadata. [Streaming evidence](voice-streaming.md) | **merged, not deployed; this acceptance check not started** |
| Verify guided-assignment scribe fidelity on a real session | One Telegram session and one owner voice session, checking the draft keeps your words, ideas, order and voice without adding content. Migration `0043` is recorded as applied; the code is not in the last recorded deploy | **waiting on the deploy above** |
| **Finish the Gmail forward to Jarvis's email address** | Only your Gmail account can confirm the forwarding, and only you can read the code out of the confirmation mail. Open Gmail's forwarding settings, click **Re-send email** on the verification, then ask Jarvis for the confirmation code and enter it. The school M365 forward is already active and needs no action | **not started; `0052` must be applied and the inbox deployed first** |
| Forward one real Google Classroom notification, and say whether the forward is an **automatic M365 rule** or a **manual Outlook Forward** | The Classroom REST route is impossible on this board, so the notification email is the only route, and a parser cannot be written honestly from a guessed format. The answer matters because an automatic M365 forward preserves the original DKIM signature while a manual Forward recomposes the body, destroys it, and every message quarantines as `from_domain_unpinned` | **not started** |
| Optional: turn on `web_read`'s JavaScript rendering | Only you can create a Cloudflare API token. In the dashboard, create a token with **only** the account permission **Browser Rendering - Edit**, on this one account, then `wrangler secret put BROWSER_RENDERING_ACCOUNT_ID` and `wrangler secret put BROWSER_RENDERING_API_TOKEN` for `jarvis-cloud-gateway` from `C:\javis\apps\cloud-gateway`. Without them `web_read` works for ordinary pages and tells Jarvis the render path is not configured. Browser Rendering may be billed; nobody checked the price | **optional; `0049` must be applied first** |
| Optional: an Exa API key for `web_search` | Only you can sign up and hold the key. `web_search` is keyless by default, but Exa's free tier is rate-limited per IP and a Worker shares egress IPs, so the keyless path may answer 429. Exa's pricing was not checked | **optional; only if Jarvis reports the Exa rate limit** |
| Decide and verify R2 backup bucket-lock settings | Repository verification code cannot establish the account's bucket-lock settings, and no production configuration was queried by any audit | **unverified** |
| Configure and prove an external watchdog monitor | The watchdog's own endpoint cannot report total cron failure without an outside poller. Do this after a deployment proves the heartbeat | **not started; the last Phase 7 item** |

## Done — kept so they are not asked for again

| Action | Evidence |
|---|---|
| Load the calling bindings, and enroll the owner phone | Twilio secrets are set; `call_sessions` held six inbound owner calls from 2026-09-17 and `channel_identities` an active `voice` identity, both queried 2026-09-21 |
| Which model does `DEEPSEEK_MODEL` name? | Flash — every memory-extraction call through 2026-09-21T23:30Z was `deepseek-flash`, and extraction reads that secret. See `FACTS.md` |
| Route the school email address to the Worker | Configured (Sid, 2026-09-21). It delivers nothing useful: D2L's notification email carries no deadline |
| Is the deployed `DEFAULT_GUEST_PIN` the committed test value? | No — the committed value is a placeholder. Sid, 2026-09-19 |
| Does the reviewer keep merge authority? | Yes, for PRs it has cleared, at the exact reviewed head |
| Who reviews reviewer-authored PRs? | **Unresolved in practice and now blocking three PRs.** The standing rule is that a PR whose author is also its reviewer gets an independent pass, and the open PRs [#223](https://github.com/stremysid/jarvis/pull/223) and [#224](https://github.com/stremysid/jarvis/pull/224) need a reviewer who is not their author. See [QUEUE](QUEUE.md) |
| Set `JARVIS_ARCHIVE_PATH` and `JARVIS_MEMORY_PATH` at user scope | Set 2026-09-23 to `%LOCALAPPDATA%\Jarvis\data\archive.sqlite` and `memory.sqlite`; `jarvis config` printed `configuration ready` |
| Install the PC boot chain, elevated | Auto-login was already configured. Sid registered the `Jarvis boot chain` task on 2026-09-23 (`SID\Sid`, Interactive, RunLevel Highest, restart 3 × PT1M) and started it; `jarvis status` answered `status running`. A real reboot has not been observed, and the task is currently **off** pending the store-folder acceptance above |
| Renumber the older `0041` and `0042` migrations above the maximum | **Decision, not an application.** Sid, 2026-09-24: "okay go ahead with both then" |
| Have test calls already worked? | **Yes, owner-reported.** Sid, 2026-09-24: "ive already done test calling and it works". This does not establish the streaming, receipt or release-gate checks |
| What is the status of **St. Remy**? | **Paused.** Sid, 2026-09-24: "lets put it on pause for now". No St. Remy code was touched, and the conflicting scope instructions are deferred rather than resolved |
| Which school date source comes first? | **The email inbox.** Sid, 2026-09-24: "agreeded". It does not revive the D2L notification-email route, which carries no deadline |
| Deploy an explicitly approved main revision | Done three times in September 2026 — twice on 2026-09-23 and once at 21:41 EDT on 2026-09-24. **Nothing recorded since** |

## Rule

A session that needs something from Sid adds a row here **in the same commit** as the
work that needs it. A session that needs the same thing twice reads this file first.
