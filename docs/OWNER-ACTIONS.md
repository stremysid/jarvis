# Owner actions

Everything that only Sid can do. Nothing here can be done by a builder or a reviewer
session — if it could, it would be in [QUEUE.md](QUEUE.md) instead.

**One row per action.** The whole point of this file is that an action cannot be
asked for twice: if it is already here, the answer is "see the row", not a second
request. That failure has happened — Google Classroom consent was ruled out on
2026-09-17 and walked through again on 2026-09-18, because the fact lived in an
agent's memory and never in the repository.

Last regenerated: 2026-09-21. Order within a section is the order to do them in.

D2L research actions added 2026-09-23; unrelated deployment/voice rows have not been re-verified.

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
| Set `JARVIS_ARCHIVE_PATH` and `JARVIS_MEMORY_PATH` at user scope | Set 2026-09-23 to `%LOCALAPPDATA%\Jarvis\data\archive.sqlite` and `memory.sqlite`. Sid ran `jarvis config` from `C:\javis` at `ec5ebb5` and it printed `configuration ready` |
| Install the PC boot chain, elevated | Auto-login was already configured. Sid registered the `Jarvis boot chain` task on 2026-09-23 (`SID\Sid`, Interactive, RunLevel Highest, restart 3 × PT1M) and started it; `jarvis status` answered `status running`. A real reboot has not yet been observed |

## Waiting on Sid

| Action | Why only you | State |
|---|---|---|
| **Run the short D2L read-only capability check, after reviewing the design** | Only your existing logged-in browser can establish the board's student access. Follow [E1–E3](plan/2026-09-23-d2l-access-design.md#e1--establish-the-session-and-supported-versions-3-minutes); return only versions, endpoint templates, statuses, field names and counts, never credentials, host, identities or private bodies. E5/E6 add expiry and coverage observations during ordinary use | **unrun; design research only** |
| **Test the collector probes after inspecting them** | [E4](plan/2026-09-23-d2l-access-design.md#e4--tabless-gx-worker-termination-and-alarms-5-minutes-per-machine-after-probe-exists) gives a small unrun probe recipe and needs both actual Opera profiles. E7 is conditional on an existing authorized Safari distribution route; E8 needs a separately authorized isolated P2 login. No purchase, enrollment, Windows configuration change or school write is authorized by this row | **unrun; recipe only, no probe installed or executed** |
| **Inspect Pulse's documented export options only if already available** | [E12](plan/2026-09-23-d2l-access-design.md#e12--pulses-legitimate-export-boundary-2-minutes-if-already-installed) can establish a legitimate export contract if one exists; do not extract app tokens or change accounts | **optional, unverified; does not block Windows research** |
| **Review existing school policy and installation permission before a live collector rollout** | [E10](plan/2026-09-23-d2l-access-design.md#e10--policy-and-distribution-35-minutes-owner-only) checks personal automation/data-transfer terms and managed-profile restrictions. Technical access is not policy permission. No school contact or repeated OAuth-key request is needed for this review | **unverified** |
| **Deploy `main`** | The live gateway is `352991e`. Undeployed: #137's voice change (the spent passphrase repeat) and #133's model default, which does not matter while `DEEPSEEK_MODEL` is Flash. No migration. Pull `C:\javis`, then `scripts/deploy.ps1 -Publish`. **Note `scripts/deploy.ps1` has no revision guard at all** — no `rev-parse`, no dirty-tree check, nothing comparing against `origin/main` — so this command ships whatever the checkout happens to contain and reports success. [#150](https://github.com/stremysid/jarvis/pull/150) adds the guard; once it merges, `-Publish` refuses a stale or dirty checkout and names both revisions. Until then, verify by hand that `C:\javis` is on `main` and clean. **At 22:33 UTC on 2026-09-22 it was neither:** it was on `688fe02`, and `apps/local-agent/jarvis_local/transport/pipe_server.py` has an uncommitted change nobody has claimed. Decide whether to keep that change before you pull. No builder may touch `C:\javis` | **not started** |
| Run the live voice smoke and commit the redacted evidence | `pnpm smoke:voice`, then `pnpm release:voice-gate`. Both are built and neither has ever run against production. It needs your phone | **not started** |
| Send one real Google Classroom notification, forwarded | The Classroom REST route is impossible on this board, so the notification email is the only route. A parser cannot be written honestly from a guessed format. Forward one real notification to the school mailbox | **not started** |
| Say whether that forward is an **automatic M365 rule** or a **manual Outlook Forward** | It decides whether Classroom can work at all. An automatic M365 forward preserves the original DKIM signature; a manual Forward recomposes the body, destroys it, and every message quarantines as `from_domain_unpinned` | **not started** |

**Not on this list, deliberately:** giving a phone call tools and one brain. That is
builder work and it is in [QUEUE.md](QUEUE.md).

## Rule

A session that needs something from Sid adds a row here **in the same commit** as the
work that needs it. A session that needs the same thing twice reads this file first.
