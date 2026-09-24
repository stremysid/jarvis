# Owner actions

Everything that only Sid can do. Nothing here can be done by a builder or a reviewer
session — if it could, it would be in [QUEUE.md](QUEUE.md) instead.

**One row per action.** The whole point of this file is that an action cannot be
asked for twice: if it is already here, the answer is "see the row", not a second
request. That failure has happened — Google Classroom consent was ruled out on
2026-09-17 and walked through again on 2026-09-18, because the fact lived in an
agent's memory and never in the repository.

Last regenerated: 2026-09-24, approximately 19:40 UTC harness snapshot, checked against repository history. Production was not queried here. Order within a section is the order to do them in.

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
| Renumber the older `0041` and `0042` migrations above main's maximum | **Done — decision, not migration application.** Sid, 2026-09-24, when asked about both renumberings: "okay go ahead with both then". [Recorded on #168](https://github.com/stremysid/jarvis/pull/168#issuecomment-5819802422). #168 needs its builder round after #166/#174; recheck the maximum then |
| Have test calls already worked? | **Yes, owner-reported.** Sid, 2026-09-24: "ive already done test calling and it works". This does not establish the separate #171 streaming/receipt checks or full release gate |

## Waiting on Sid

| Action | Why only you | State |
|---|---|---|
| #176 L2: which date should Jarvis use when D2L myItems and folder DueDate disagree? | **A: keep both (recommended); B: use the folder date; C: use the personal date (today's behavior).** No such disagreement has been observed so far. #176 labels unequal dates without deciding the precedence for you | **waiting on Sid**, before a date-precedence change |
| Which St. Remy scope instruction is current? | [DECISIONS.md](../DECISIONS.md#planning-session-record-from-2026-09-03-unconfirmed-and-superseded-in-part) says St. Remy is "no longer off limits"; [AGENTS.md](../AGENTS.md#things-that-are-not-this-repository) says its code is out of scope for a Jarvis session. These conflict; this builder has not resolved the decision | **waiting on Sid**, before any scope change; no St. Remy code touched |
| First live check of merged #171 owner voice streaming | After its deployment and explicit authority to use provider credit, check one ordinary answer, one harmless test memory and one public synthetic guided draft. Record first-sentence latency, indexed tool fragments, one completed tool receipt and spoken/final transcript agreement. Check claim markers stay unspoken, proofs belong to this turn, unsupported claims get the honest line, and quoted/header redaction holds. Keep only redacted protocol/timing evidence. [Streaming evidence](voice-streaming.md). Sid's working-test-call report is recorded above; these narrower acceptance checks remain unverified | **merged; deployment and this acceptance check not started** |
| Roll out guided assignment (#172 merged) | `0043_guided_assignment.sql` is on main with its gateway. The reviewer completed the authorized [scratch rehearsal](reviews/2026-09-24-scratch-d1-rehearsal.md) on 2026-09-24 with Sid's "2: yes". Use the reviewed ordered migration set, then deploy and check Telegram and owner voice scribe fidelity. [Design and limits](reviews/2026-09-23-guided-assignment.md) | **scratch done / PASS; production application and deploy not started** |
| Deploy [#167](https://github.com/stremysid/jarvis/pull/167) (merged) | Removes retired D2L-email and Classroom health warnings from scheduled/manual digests. No migration or data deletion for this change. After deployment, check `/digest` and the next 07:30 digest | **merged; deploy not started** |
| **Load the probe, click Run probe, paste the summary** | Only your Opera GX session can test LDSB access. Follow [the D2L probe runbook](runbooks/d2l-extension.md): one pass with every D2L tab closed, then one with a refreshed D2L tab open. Copy the combined shape-only summary to the reviewer, then remove the extension. This single action replaces #160's overlapping D2L capability-check and collector-probe requests; do not repeat those separately | **in-tab pass done** (2026-09-23 about 8:25 PM EDT; results in [the owner run](research/2026-09-23-d2l-probe-owner-run.md)); **tabs-closed (background) pass not run yet**, so background mode is still unverified |
| **Load and pair the D2L collector on the PC and laptop** | Follow [the collector runbook](runbooks/d2l-extension.md), approve each device code in Telegram, enter the Durham hop once and check both hosts with D2L tabs closed. The receiver fixes are merged; the extension compatibility hold and host-failure follow-up remain in QUEUE. The shape probe was already supplied; do not ask for it again | **awaiting-owner after reviewed compatibility follow-up and rollout**; background access remains unverified |
| Roll out single-use tier-3 taps (#159 merged) | The reviewer completed the authorized [0039 scratch rehearsal](reviews/2026-09-24-scratch-d1-rehearsal.md) on 2026-09-24 with Sid's "2: yes". Apply `0039_tool_confirmation_consumptions.sql` before the matching gateway deploy; new code fails closed on tier 3 without the schema. Let pre-cutover taps age out for ten minutes after old code stops, then check fresh confirmations on a supported tool. [Rollout and evidence](reviews/2026-09-23-tier3-tap.md) | **scratch done / PASS; production application and deploy not started** |
| Try one real D2L assignment paste after deploying merged #164 | Only Sid can compare saved per-course notes and daily workload with his real assignment list and pinned capacity. Paste as direct Telegram text, check new/already-saved counts and stored blocks, then re-paste for deduplication. No migration for this change | **merged; deploy and owner acceptance not started** |
| Set `CALENDAR_FEED_TOKEN`, then subscribe in iPhone Calendar after deploying merged #165 | Set the required random secret through the authorized setup, then subscribe to its private URL. [Setup, rotation and alert checks](runbooks/iphone-calendar-feed.md). Any **Remove Alerts** switch must be off; device behavior remains unverified | **merged; deploy and subscription not started** |
| Accept the D2L collector on the PC and laptop after review and rollout | Confirm each device's matching Telegram code. Compare complete reads from **LDSB and Durham**, including CIA4U1, quiz dates, announcements, undated work and 403/404 evidence. The empty myItems/submission shapes are already owner-observed in #170; positive own-submission shapes remain unverified. Test expiry, revocation, pairing-delivery retry and a visible host session failure. See the [collector design](plan/2026-09-23-d2l-collector-design.md) | **waiting for reviewed extension and receiver compatibility rollout; no builder live acceptance** |
| Apply the D2L receiver migrations and deploy (#169/#175/#176 merged) | The reviewer completed the authorized [scratch rehearsal](reviews/2026-09-24-scratch-d1-rehearsal.md) on 2026-09-24 with Sid's "2: yes", including `0040` and `0045`. Quiesce collector uploads, run the linked `0045` duplicate pre-check grouped by principal and origin reference, then apply the reviewed main set `0039`, `0040`, `0043`, `0045` in order. `0044` remains on #174 and passed scratch after `0045`; include it only after review/merge and a fresh rollout check. Deploy the matching gateway, resume collectors and use the two-board acceptance row | **scratch done / PASS; production application and deploy not started** |
| Run the live voice smoke and commit the redacted evidence | `pnpm smoke:voice`, then `pnpm release:voice-gate`. Both are built and neither has ever run against production. It needs your phone | **not started** |
| Send one real Google Classroom notification, forwarded | The Classroom REST route is impossible on this board, so the notification email is the only route. A parser cannot be written honestly from a guessed format. Forward one real notification to the school mailbox | **not started** |
| Say whether that forward is an **automatic M365 rule** or a **manual Outlook Forward** | It decides whether Classroom can work at all. An automatic M365 forward preserves the original DKIM signature; a manual Forward recomposes the body, destroys it, and every message quarantines as `from_domain_unpinned` | **not started** |
| Decide and verify R2 backup bucket-lock settings when backup retention is reviewed | Repository verification/retention code cannot establish the account's bucket-lock settings. No production configuration was queried by this audit | **unverified** |
| Configure and prove an external watchdog monitor when monitoring setup is authorized | The watchdog's own health endpoint cannot report total cron failure without an outside poller. STATE records no external watchdog; this audit did not query production | **not started** |

### [PR #157](https://github.com/stremysid/jarvis/pull/157) — the store-folder work, in order

| Action | Why only you | State |
|---|---|---|
| If `%LOCALAPPDATA%\Jarvis` is owned by **Administrators**, run the one-time repair: either `jarvis serve` once from an **elevated** shell, or the exact `icacls` line the refusal prints | The DACL write is checked against the object's access, and a non-elevated process is not named on it — nothing the code can do changes that. This is the state the whole PR exists to get out of, and it is the one repair no builder may perform | **not started** — check the startup output for `WARNING ... is owned by` first; if it is absent, there is nothing to repair |
| Run the **manual acceptance**: start `jarvis serve` by hand **non-elevated**, confirm `%LOCALAPPDATA%\Jarvis\data` is reachable, then stop it and start it **elevated** and confirm the same | This is the only check that meets the real DACL, and only you have the elevated shell. It is also the test nobody can run for you: it decides whether the boot task may be re-enabled at all | **not started** — #157 is merged; do this before re-enabling the boot task |
| Re-enable the `Jarvis boot chain` task | It has to stay disabled until the row above passes — the elevated task is what created the Administrators-owned folder in the first place | **not started** — blocked on the row above |
| Delete `C:\jarvis-test-scratch` after the checkpoint-5 integration run | The scratch directory is the signal that a real-permission test is wanted, so leaving it in place means the next `uv run pytest` runs five tests that change real permissions without anyone choosing to | **not started** — after the checkpoint-5 run, and only when you decide no further real-DACL run is needed |

**Builder work stays in [QUEUE.md](QUEUE.md):** calls already have memory tools;
remaining channel parity and conversation-state work are not owner setup.

## Rule

A session that needs something from Sid adds a row here **in the same commit** as the
work that needs it. A session that needs the same thing twice reads this file first.
