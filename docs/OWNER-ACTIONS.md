# Owner actions

Everything that only Sid can do. Nothing here can be done by a builder or a reviewer
session — if it could, it would be in [QUEUE.md](QUEUE.md) instead.

**One row per action.** The whole point of this file is that an action cannot be
asked for twice: if it is already here, the answer is "see the row", not a second
request. That failure has happened — Google Classroom consent was ruled out on
2026-09-17 and walked through again on 2026-09-18, because the fact lived in an
agent's memory and never in the repository.

Last regenerated: 2026-09-21. Order within a section is the order to do them in.

## Done — kept so they are not asked for again

| Action | Evidence |
|---|---|
| Load the calling bindings | Twilio secrets are set, and `call_sessions` holds six inbound owner calls from 2026-09-17, queried 2026-09-21 |
| Enroll the owner phone | `channel_identities` holds an active `voice` identity in production, queried 2026-09-21 |
| Apply `0038`, then deploy | `0038` applied 2026-09-20; Worker `78cb6e98` deployed 2026-09-21 from `352991e`; the gateway heartbeat records |
| Which model does `DEEPSEEK_MODEL` name? | Flash — every memory-extraction call through 2026-09-21T23:30Z was `deepseek-flash`, and extraction reads that secret. See `FACTS.md` |
| Route the school email address to the Worker | Configured (Sid, 2026-09-21). It delivers nothing useful: D2L's notification email carries no deadline |
| Is the deployed `DEFAULT_GUEST_PIN` the committed test value? | No — the committed `4827` is a placeholder. Sid, 2026-09-19 |
| Does the reviewer keep merge authority? | Yes, for PRs it has cleared, at the exact reviewed head. Sid has directed merges throughout 2026-09-20 |
| Who reviews reviewer-authored PRs? | DeepSeek reviews; GPT-5.6 Sol builds. Sid, 2026-09-20 |

## Waiting on Sid

| Action | Why only you | State |
|---|---|---|
| **Deploy `main`** | The live gateway is `352991e`. Undeployed: #137's voice change (the spent passphrase repeat) and #133's model default, which does not matter while `DEEPSEEK_MODEL` is Flash. No migration. Pull `C:\javis`, then `scripts/deploy.ps1 -Publish`. **Note `scripts/deploy.ps1` has no revision guard at all** — no `rev-parse`, no dirty-tree check, nothing comparing against `origin/main` — so this command ships whatever the checkout happens to contain and reports success. Until that guard exists, verify by hand that `C:\javis` is on `main` and clean before running it | **not started** |
| Set `JARVIS_ARCHIVE_PATH` and `JARVIS_MEMORY_PATH` **at user scope** | Only needed once #145 merges. `ops/jarvis-boot.ps1` asks the agent's own `config` before starting anything, and those two names are required, so the logon chain exits 4 with a message naming them until they exist for the account the task runs as. They are write paths for this machine's stores, which is your environment and not a builder's to create | **not started** |
| Run the live voice smoke and commit the redacted evidence | `pnpm smoke:voice`, then `pnpm release:voice-gate`. Both are built and neither has ever run against production. It needs your phone | **not started** |
| Send one real Google Classroom notification, forwarded | The Classroom REST route is impossible on this board, so the notification email is the only route. A parser cannot be written honestly from a guessed format. Forward one real notification to the school mailbox | **not started** |
| Say whether that forward is an **automatic M365 rule** or a **manual Outlook Forward** | It decides whether Classroom can work at all. An automatic M365 forward preserves the original DKIM signature; a manual Forward recomposes the body, destroys it, and every message quarantines as `from_domain_unpinned` | **not started** |
| Install the PC boot chain, elevated | Registering a scheduled task at `-RunLevel Highest` and writing `HKLM\...\Winlogon` both need an administrator session, and no builder session has one. Two commands, in the runbook: [the PC boot chain](runbooks/pc-boot-chain.md). Step 1 is a re-assertion — auto-login is **already configured** on this machine, and has been since before 2026-09-21 | **not started** |

**Not on this list, deliberately:** giving a phone call tools and one brain. That is
builder work and it is in [QUEUE.md](QUEUE.md).

## Rule

A session that needs something from Sid adds a row here **in the same commit** as the
work that needs it. A session that needs the same thing twice reads this file first.
