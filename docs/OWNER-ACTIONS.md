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
| Load the calling bindings | A real call has been placed and worked, 2026-09-19 |
| Enroll the owner phone | `channel_identities` holds an active `voice` identity in production, queried 2026-09-21 |
| Apply `0038`, then deploy | 2026-09-20: `0038` applied, Worker `74f2a003` and watchdog `c940f9b7` deployed; the gateway heartbeat now records |
| Is the deployed `DEFAULT_GUEST_PIN` the committed test value? | No — the committed `4827` is a placeholder. Sid, 2026-09-19 |
| Does the reviewer keep merge authority? | Yes, for PRs it has cleared, at the exact reviewed head. Sid has directed merges throughout 2026-09-20 |
| Who reviews reviewer-authored PRs? | DeepSeek reviews; GPT-5.6 Sol builds. Sid, 2026-09-20 |

## Waiting on Sid

| Action | Why only you | State |
|---|---|---|
| Check which model `DEEPSEEK_MODEL` is set to | Secrets are write-only; the name is visible, the value is not. The code default is now `deepseek-flash`, but if the binding says `deepseek-v4-pro` Jarvis runs a model you did not choose at roughly seven times the price. Cloudflare dashboard → the `jarvis-cloud-gateway` Worker → Settings → Variables and Secrets | **unanswered** |
| Run the live voice smoke and commit the redacted evidence | `pnpm smoke:voice`, then `pnpm release:voice-gate`. Both are built and neither has ever run against production. It needs your phone | **not started** |
| Send one real Google Classroom notification, forwarded | The Classroom REST route is impossible on this board, so the notification email is the only route. A parser cannot be written honestly from a guessed format. Forward one real notification to the school mailbox | **not started** |
| Say whether that forward is an **automatic M365 rule** or a **manual Outlook Forward** | It decides whether Classroom can work at all. An automatic M365 forward preserves the original DKIM signature; a manual Forward recomposes the body, destroys it, and every message quarantines as `from_domain_unpinned` | **not started** |
| Point `school@onesid.ca` at the Worker | The `email()` handler is deployed and has **never received a single email** — both D2L tables are empty in production. The routing rule most likely still sends school mail to Gmail; check it in the Cloudflare dashboard under Email Routing. Until it points at the Worker, D2L deadlines never reach Jarvis | **not started** |

**Not on this list, deliberately:** giving a phone call tools and one brain. That is
builder work and it is in [QUEUE.md](QUEUE.md).

## Rule

A session that needs something from Sid adds a row here **in the same commit** as the
work that needs it. A session that needs the same thing twice reads this file first.
