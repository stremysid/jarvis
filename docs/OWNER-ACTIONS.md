# Owner actions

Everything that only Sid can do. Nothing here can be done by a builder or a reviewer
session — if it could, it would be in [QUEUE.md](QUEUE.md) instead.

**One row per action.** The whole point of this file is that an action cannot be
asked for twice: if it is already here, the answer is "see the row", not a second
request. That failure has happened — Google Classroom consent was ruled out on
2026-09-17 and walked through again on 2026-09-18, because the fact lived in an
agent's memory and never in the repository.

Last regenerated: 2026-09-23. Order within a section is the order to do them in.

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
| Deploy [#154](https://github.com/stremysid/jarvis/pull/154) after independent clearance and merge | **Done:** included in Sid's deploy of `a6a0efd` on 2026-09-23 at 20:41 EDT as Worker `7e027a1f-065b-4f60-8229-f3edff0160dc`; `/health` returned 200 at 20:42 EDT. Owner/reviewer report, not a builder production query. A fresh Confirm tap after deploy remains unverified; see [STATE](STATE.md#production) |
| **Deploy an explicitly approved main revision** | **Done:** Sid ran `scripts/deploy.ps1 -Publish` from `C:\javis` at `a6a0efd` on 2026-09-23. Includes #133, #137, #144, #146, #147, #149 and #154. **No migration** was applied; D1 stays at `0038`. Source: owner/reviewer report recorded in [STATE](STATE.md#production) |

## Waiting on Sid

| Action | Why only you | State |
|---|---|---|
| Rehearse and roll out guided assignment after independent review and merge | Migration `0043_guided_assignment.sql` and its gateway need owner-authorized remote D1 rehearsal, ordered migration application, and deployment. Resolve lower reserved migration numbers before applying `0043`. Then check one Telegram session and one owner voice session for scribe fidelity. The builder ran only local tests and no live call; see [the design and limits](reviews/2026-09-23-guided-assignment.md) | awaiting review and merge |
| Rehearse migration 0044 and deploy channel-parity after independent review and merge | Only Sid authorizes a real database or deployment. Recheck migration order against main/open PRs, rehearse the 19 trigger replacements on an explicitly authorized scratch database, then apply before deploying. Without 0044, voice pipeline saves fail closed. After rollout, verify a real school/university/study call, exact-wording memory confirmation and a Telegram tier-3 tap reused on voice only once. [Audit and local evidence](reviews/2026-09-23-channel-parity.md). No spoken PIN or complete cross-channel transcript is claimed | awaiting review and separately authorized rollout |
| Deploy [#167](https://github.com/stremysid/jarvis/pull/167) after independent clearance and merge | Removes the owner-retired D2L email and Classroom health warnings from scheduled and manual digests. No migration or data deletion. After deployment, check `/digest` and the next 07:30 digest; this builder has no production authority | awaiting review and merge |
| **Load the probe, click Run probe, paste the summary** | Only your Opera GX session can test LDSB access. Follow [the D2L probe runbook](runbooks/d2l-extension.md): one pass with every D2L tab closed, then one with a refreshed D2L tab open. Copy the combined shape-only summary to the reviewer, then remove the extension. This single action replaces #160's overlapping D2L capability-check and collector-probe requests; do not repeat those separately | **in-tab pass done** (2026-09-23 about 8:25 PM EDT; results in [the owner run](research/2026-09-23-d2l-probe-owner-run.md)); **tabs-closed (background) pass not run yet**, so background mode is still unverified |
| Rehearse and roll out single-use tier-3 taps after independent review | Migration `0039_tool_confirmation_consumptions.sql` and the gateway require owner authority. Recheck migration numbers against main and every open PR, rehearse on a separately authorized remote scratch database, then apply the additive migration before deploying the gateway. New code first fails closed on tier 3 until the schema exists. Let pre-cutover taps age out for ten minutes after old code stops, then use fresh confirmations for an acceptance check on a supported tool. Channel-parity makes voice pipelines dispatchable, so voice claims an approved tap before their bodies just as Telegram does. See [the rollout and evidence](reviews/2026-09-23-tier3-tap.md) | **awaiting review; no remote rehearsal, migration or deploy performed by this builder** |
| Try one real D2L assignment paste after the school-paste change is reviewed, merged and deployed | Only Sid has the real assignment list and can confirm that the saved per-course notes and proposed daily workload match his pinned capacity. Paste as direct Telegram text; check each course's new/already-saved counts and today's stored blocks, then re-paste to check deduplication. Long lists show previews plus how many more were saved. No migration is needed for this change | **waiting for reviewed deployment** |
| Set `CALENDAR_FEED_TOKEN`, then subscribe in iPhone Calendar | After the reviewed calendar-feed code is deployed under separate owner authority, set a random secret of at least 32 characters and subscribe to its private URL. [Setup, rotation and alert checks](runbooks/iphone-calendar-feed.md). Any **Remove Alerts** switch must be off; device behavior is **unverified** | **not started** |
| Accept the D2L collector on the PC and laptop after review and rollout | Match the extension's pairing code to Telegram and confirm each device. Compare one complete read against D2L, including module dates, undated work and refusals. The probe must confirm myItems and positive own-submission shapes before those adapters are called live-verified. Test expiry, revocation and a failed course. See the [collector design](plan/2026-09-23-d2l-collector-design.md) | **waiting for reviewed extension and receiver; no live acceptance performed** |
| Authorize the D2L receiver migration and deployment after reviews | The builder has not touched a real database or production. Apply assigned 0039 before 0040, then use the owner rollout procedure after independent clearance | **not started** |
| Run the live voice smoke and commit the redacted evidence | `pnpm smoke:voice`, then `pnpm release:voice-gate`. Both are built and neither has ever run against production. It needs your phone | **not started** |
| Send one real Google Classroom notification, forwarded | The Classroom REST route is impossible on this board, so the notification email is the only route. A parser cannot be written honestly from a guessed format. Forward one real notification to the school mailbox | **not started** |
| Say whether that forward is an **automatic M365 rule** or a **manual Outlook Forward** | It decides whether Classroom can work at all. An automatic M365 forward preserves the original DKIM signature; a manual Forward recomposes the body, destroys it, and every message quarantines as `from_domain_unpinned` | **not started** |
| Decide and verify R2 backup bucket-lock settings when backup retention is reviewed | Repository verification/retention code cannot establish the account's bucket-lock settings. No production configuration was queried by this audit | **unverified** |
| Configure and prove an external watchdog monitor when monitoring setup is authorized | The watchdog's own health endpoint cannot report total cron failure without an outside poller. STATE records no external watchdog; this audit did not query production | **not started** |

**Not on this list, deliberately:** giving a phone call tools and one brain. That is
builder work and it is in [QUEUE.md](QUEUE.md).

## Rule

A session that needs something from Sid adds a row here **in the same commit** as the
work that needs it. A session that needs the same thing twice reads this file first.
