# Facts

**Durable facts about Sid and his environment — the things that cannot be discovered from
the code.**

This file exists because of a specific, repeated failure. On 2026-09-17 Sid said his
school account cannot reach Google Cloud Console. That fact went into an agent's private
memory. `docs/HANDOFF.md` went on calling Classroom consent *"SID'S ACTION, one sitting.
Highest value per hour in the whole plan"*, so on 2026-09-18 another session read the
handoff, opened the runbook, and walked him through an impossible setup a second time.
The same shape had already happened with the D2L calendar feed.

The lesson is not "be careful". It is that **agent memory is private to one agent and the
repository is the only thing every session reads.**

## The three rules

1. **Before asking Sid anything, search this file for the subject.** If the answer is
   here, use it. An answer he has already given once is not a question to ask again.
2. **A fact that contradicts another document is not recorded until that document is
   fixed, in the same change.** A new fact that leaves the old claim standing makes the
   repository disagree with itself, which is worse than not recording it.
3. **Every row carries a source and a date.** No bare assertions. `scripts/check-state.mjs`
   requires four cells, a nonempty fact, a non-placeholder source and a real `YYYY-MM-DD`
   observation date no more than one UTC day ahead. A row after a blank gap in the register
   fails too. Observations older than 30 UTC calendar days, or a "Still true?" cell that
   does not start with `yes`, warn. Each file gets one GitHub `::warning` with the count
   and first affected line; every row's detail stays in the plain log. Warnings do not fail CI.

## What belongs here, and what does not

| Belongs here | Goes elsewhere |
|---|---|
| Hardware, accounts, platforms, permissions, constraints about Sid or his environment | How the code works → `ARCHITECTURE.md` |
| What he has already set up, ruled out, or decided about the outside world | Defects and unproven guarantees → `KNOWN_ISSUES.md` |
| Durable operational facts a session would otherwise re-ask or re-derive | Product decisions → `DECISIONS.md` |
| | Current state → `STATE.md` · work in flight → `QUEUE.md` |

## The register

| Fact | How we know | Observed | Still true? |
|---|---|---|---|
| Sid approved the Opera GX session-API D2L collector on the PC and laptop, with separate school-only keys and an owner Telegram pairing tap; the PC login-and-scrape reader is parked | Sid's explicit D2L receiver builder instruction; [collector design](plan/2026-09-23-d2l-collector-design.md) | 2026-09-23 | yes |
| A complete per-tool D2L HTTP 403 is normal because teachers lay out courses differently; retain it as refused evidence without failing the read | Sid's explicit PR #169 fix-round instruction; [independent review](https://github.com/stremysid/jarvis/pull/169#issuecomment-5806221250) | 2026-09-23 | yes |
| School catch-up is Sid's top priority; he plans to paste D2L assignment lists directly into Telegram | Sid's school-paste builder brief, 2026-09-23; owner-reported intent | 2026-09-23 | yes |
| Sid tracks everything in iPhone Calendar. School is his top priority | Sid's calendar-feed task instruction | 2026-09-23 | yes |
| The school account is **Microsoft 365**; it cannot reach `console.cloud.google.com`, so Google Classroom OAuth credentials cannot be obtained | Sid stated it directly; a reviewer session had walked him through the setup a second time before recording it | 2026-09-17 | yes |
| Consequence: **Classroom has no usable route.** The REST client is wired but credential-blocked; no Classroom handling exists in the email parser; the notification-email route was proposed, not built | Code read at `5a8acf3`; `GOOGLE_CLASSROOM_EMAIL_FROM_DOMAINS` occurs zero times in `src` | 2026-09-18 | yes |
| LDSB Brightspace exposes **no calendar or iCal feed**, so `BRIGHTSPACE_ICAL_URL` has no value to hold. **Never ask him for one** | `KNOWN_ISSUES.md`; the board's configuration | 2026-09-15 | yes |
| The fleet is a **Windows 11 home PC, a Windows 11 laptop, an iPhone 16**, and a Tesla as an integration rather than a host. There is **no server, NAS or VPS** | `CLAUDE.md`; Sid | 2026-09-18 | yes |
| **There is no Linux machine and Sid has never used Linux.** A bash, `systemd` or `chmod` instruction is not something he can run | Sid, repeatedly | 2026-09-18 | yes |
| The home PC is on **08:00–23:00** and off overnight while he sleeps, so "always-on" means "on except overnight". **Hours stated by Sid 2026-09-21** — the earlier row gave none | Sid, 2026-09-21 | 2026-09-21 | yes |
| **Sid is out 08:00–11:00 and not home until 17:00–18:00**, so **08:00 to about 17:00 is unattended** — a guaranteed window. This corrects the inference that "off overnight" means cloud-only: the PC is the better host for most work, because it has a real filesystem, a real browser and real credentials, none of which a Worker has | Sid, 2026-09-21 | 2026-09-21 | yes |
| **The school account has no MFA.** Signing in is a password and a click; a stale session logs you out and needs a second attempt. So the PC can hold the school login and read D2L itself | Sid, 2026-09-21 | 2026-09-21 | yes |
| Sid uses separate Brightspace sessions at **ldsb.elearningontario.ca** and **durham.elearningontario.ca**. Durham renewal starts from a live LDSB session and its **My Courses in Other Boards** course link; never attempt a separate Durham login. The hop is entered in extension setup, not committed | Sid's collector brief, including the 20:55 Durham addition | 2026-09-23 | yes |
| Real D2L probe shapes show paginated enrollments, sparse assignment DueDate, empty grade/submission arrays and per-tool refusals. Null dates mean no date known; refused submissions do not mean unsubmitted. Read only active accessible course offerings; skip the preloaded DCE D2L BrightSpace Orientation | Sid's supplied shape-only probe results, read by the collector builder; no independent account access | 2026-09-23 | yes |
| Background access in Opera GX and direct Durham course URLs restoring federation are **unverified**. They require the owner-run collector checks; in-tab probe success does not prove either | Sid's collector brief and probe notes | 2026-09-23 | unconfirmed |
| The Jarvis gateway origin is **https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev**, with no trailing path. This is the collector's only non-D2L host | Sid supplied the exact origin and reported GET /health 200 at 23:31 EDT; builder did not repeat a live request or inspect secrets | 2026-09-23 | yes |
| **D2L's notification email cannot carry a deadline.** Sid enabled every notification option; D2L sends an activity summary naming the course with a count (*"76 New Emails"*) and a link. No assignment name, no due date. Per course and once for the board, both linking to a login-walled inbox. **The D2L email route is closed, and the board exposes no calendar tool** | Sid, 2026-09-21 | 2026-09-21 | yes |
| His timezone is **Eastern**; the machine reports UTC−4 during daylight saving and will report UTC−5 after it ends | Machine clock, 2026-09-19 | 2026-09-19 | yes |
| DeepSeek **peak** pricing is UTC 01:00–04:00 and 06:00–10:00, **Monday–Friday**; everything else is off-peak at half price. In his time that is 9 pm–midnight and 2–6 am | The published Beijing 9–12/14–18 footnote, verified against the project's own cost code | 2026-09-19 | yes |
| The repository now lives at **`stremysid/jarvis`** (an organisation), not `ksid1229-ops/jarvis`. The old URL redirects, so pushes still work, but anything hardcoding the old path is stale | The transfer, verified 2026-09-19 | 2026-09-19 | yes |
| That organisation is on a **GitHub Enterprise trial** — 50,000 Actions minutes a month versus 2,000 on Free. No payment method is attached, so overage stops rather than bills | Org settings; GitHub's own plan documentation | 2026-09-19 | yes |
| CI was dead from 2026-09-12 on billing and **came back on 2026-09-19** when the repository moved into the organisation. **That was true repo-wide before it was true for `main`**: of 33 non-cancelled runs on `main` since then, 7 passed and 26 failed, and the passing ones all follow the fixes that landed on 2026-09-20. The last five on `main` pass | `gh run list --branch main`, counted 2026-09-21 | 2026-09-21 | yes |
| **No payment method is attached to the personal GitHub account**, deliberately, after an unexpected usage charge. Metered usage there stops rather than bills | Sid | 2026-09-19 | yes |
| **A user-scope environment variable set after a process started is invisible to that process, and to every process already running.** The registry value is written immediately and read at the next logon, not broadcast. Measured 2026-09-21: `JARVIS_DEVICE_KEY_PATH` is `REG_SZ` under `HKCU\Environment` and `[Environment]::GetEnvironmentVariable` reads it back at user scope, while a pwsh session started before it was set sees it as unset — with `JARVIS_CLOUD_BASE_URL`, `JARVIS_DEVICE_ID` and `JARVIS_PRINCIPAL_ID` present in that same session. So "the agent's configuration is missing" can mean "one variable was set after this shell started" | Registry read plus `[Environment]::GetEnvironmentVariable` at user and process scope, from a shell started before the write | 2026-09-21 | yes |
| The only Windows user profile on this machine is **`Sid`**. The `Ksid1` profile named by older documents never existed | The filesystem | 2026-09-18 | yes |
| `python` on `PATH` resolves to a real Python 3.12.6, and `uv` is on `PATH`. | `python -V` | 2026-09-18 | yes |
| The agent presets are **outside the repository**, under `~/.dsh/.agent-presets/` — `jarvis-builder` and `jarvis-auditor`. They carry the standing rules for headless sessions | The preset files; `reviewer-tools/dsh-relay.ps1` layers them | 2026-09-19 | yes |
| **Jarvis runs on DeepSeek V4.1 Flash, everywhere.** Frontier models are equivalent for an assistant's daily work, so the decision is cost and latency, and nothing matches Flash on either. Do not "fix" the code toward Claude on the strength of an older document | Sid, asked directly | 2026-09-20 | yes |
| **Telegram and voice read two different memory stores, with no bridge.** Telegram writes `memory_items`; `D1ContextRetriever` reads `memory_fact_projection_*`, whose only writer is `http/sync-routes.ts` when the Windows local agent pushes. Production holds 5 `memory_items` and **0 projection facts**, so a phone call reads an empty store and nothing said by text reaches it | Traced all three paths in the code, then queried both counts in production | 2026-09-20 | yes |
| **`ModelAdapterStreamInput` has no `tools` field**; tools exist only on `ModelAgentCompletionInput`, consumed by `DeepSeekAgentProvider`. So voice gets tools the way Telegram does — an agent loop behind a `ModelAdapter` — not by widening the type (`DECISIONS.md`, *"Voice gets tools behind `ModelAdapter`"*) | Read `model/model-adapter.ts` and `providers/provider-types.ts` | 2026-09-20 | yes |
| **Production runs DeepSeek Flash.** `DEEPSEEK_MODEL` is a write-only secret, but memory extraction reads it (there is no `MEMORY_EXTRACTION_MODEL` binding), and every one of the 30 rows in `memory_cost_ledger`, through 2026-09-21T23:30Z, is `deepseek:deepseek-flash`. The only way chat could differ is if the secret were set to a blank value | `memory_cost_ledger` grouped by `model_id`; `wrangler versions view` on the live version; extraction model selection in `index.ts` at `352991e` | 2026-09-21 | yes |
| **The gateway heartbeat works.** `component_liveness` records `cloud-gateway` on every cron, so the watchdog can tell a broken Jarvis from a quiet one | Queried `component_liveness` directly after deploying Worker `78cb6e98`: last seen `2026-09-21T21:25:47Z` | 2026-09-21 | yes |
| **Gateway deployed as of `a6a0efd`; D1 stays at `0038`.** Sid ran `scripts/deploy.ps1 -Publish` from `C:\javis` at 20:41 EDT on 2026-09-23 (00:41 UTC on 2026-09-24): Worker `jarvis-cloud-gateway`, version `7e027a1f-065b-4f60-8229-f3edff0160dc`. `/health` returned 200 at 20:42 EDT. No migrations applied. Includes #133, #137, #144, #146, #147, #149 and #154; #156 is local-only and merged later | Owner Sid and reviewer report supplied to PR #158 round 2; [review](https://github.com/stremysid/jarvis/pull/158#issuecomment-5805607554) corroborates deploy source/version prefix; full observation and pre-deploy D1 bookmark in [STATE](STATE.md#production). Not a builder production query | 2026-09-23 | yes |
| **`C:\javis` is the live deploy checkout and goes stale.** `wrangler d1 migrations list` reads the migrations directory of whatever revision is checked out there, so a stale checkout reports "No migrations to apply" truthfully and misleadingly. **Pull before listing, always** | 2026-09-20: the checkout was 8 commits behind and hid `0038` | 2026-09-20 | yes |
| **The test for whether something belongs in code: if a chat model could do it with every permission granted, do not code it.** The test is "can the model do it at all", never "might the model get it wrong" | Sid, 2026-09-20. Recorded in the roadmap's core rule | 2026-09-20 | yes |
| **Jarvis states its own certainty.** Whether a fact was stated, inferred or confirmed is judgment, and judgment is the model's. `extraction-policy.ts` currently assigns it at the validation boundary and `FORBIDDEN_PROPOSAL_KEYS` blocks the model from setting it — that is code doing a job the model can do, and it is queued to change | Sid, 2026-09-20, ruling on a question the reviewer raised | 2026-09-20 | yes |
| **What Jarvis is: a personal chat model outside the sandbox**, with memory that does not end at a context window and permissions Sid has actually granted. It sends the email or uses the card because it was asked and is authorized, not because a safety rule was removed. Tier 3 and confirmations exist so Sid knows before money moves, not because the model is distrusted | Sid, 2026-09-20 | 2026-09-20 | yes |
| **A real Twilio call has been placed and it worked.** The only defect observed was that **calling had no memory attached**. | Sid stated it directly | 2026-09-19 | yes |
| Calling's remaining gap is the **brain**, not the phone plumbing. The voice path composes its own adapter and **cannot carry tools as a matter of type**, and it reads a **different memory store** from Telegram — see the two rows above — so a call can talk, cannot act, and cannot recall anything said by text | Traced in code; store counts queried in production | 2026-09-21 | yes |
| **Voice and Telegram use different retrievers over different stores.** `index.ts` composes `TelegramMemoryRetriever`; only `production-runtime.ts` composes `D1ContextRetriever`. They read `memory_item_fts`/`memory_item_versions` versus `memory_fact_projection_fts`/`events`. And `D1ContextRetriever implements ContextRetriever` **only**, while `TelegramMemoryRetriever` also implements **`TelegramMemoryTargetFinder`** — so voice cannot name a specific memory to act on | `src/index.ts` and `src/voice/production-runtime.ts` at `0611803`; the two `implements` clauses read directly | 2026-09-21 | yes |
| A git **worktree's `.git` is a file, not a directory** — `gitdir: C:/javis/.git/worktrees/<name>`. Anything that writes inside `.git` (a commit-message file, for one) fails with *"a parent path segment is not a directory"*. Write the message outside the worktree | Hit directly: writing into `C:\w\p5\.git\` was refused; `Test-Path .git -PathType Leaf` is true | 2026-09-20 | yes |
| **Auto-login is already configured on the home PC**, and has been since before 2026-09-21. `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon` holds `AutoAdminLogon=1`, `DefaultUserName=Sid`, `DefaultDomainName=SID` and a `DefaultPassword` value. **The password is therefore plaintext in the registry today**, not as a consequence of any change in this repository. `docs/briefs-pc-controls.md` describes the mechanism but records it as a plan, and no document recorded that it is **already set** until now. Sid accepted the exposure when he asked for the boot chain (2026-09-21) | `Get-ItemProperty` on that key, read unelevated; reported by `ops/jarvis-autologon.ps1 -Status` without printing the value | 2026-09-21 | yes |
| **`Sid` is a local account on a machine whose computer name is `SID`.** There is no domain, so every place Task Scheduler or Winlogon wants a domain, the answer is the computer name | `whoami` → `sid\sid`; the pre-existing `DefaultDomainName` | 2026-09-21 | yes |
| **The local agent's control channel is fully implemented for Windows and has no Windows launcher.** `transport/pipe_server.py` is a tested `NamedPipeServer` over a SID-restricted pipe, and `node.py` — the only thing that binds it — refuses any platform that is not Linux. So `jarvis status` on Windows has nothing to talk to, and the P1 boot chain necessarily ends at "elevated, no agent" | Read `node.py`'s `NodeSettings.from_config` platform check and the `pipe_server` call graph; there is no other caller | 2026-09-21 | yes |
| **The home PC's PowerShell is Store version 7.6.6.** The MSI host `C:\Program Files\PowerShell\7\pwsh.exe` is absent. `Get-Command pwsh` resolves to the real executable under `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\`; the separate App Execution Alias is `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`. Appx reports family `Microsoft.PowerShell_8wekyb3d8bbwe`, Microsoft publisher, `SignatureKind=Store`, and `IsDevelopmentMode=false` | Builder for issue #24 re-ran `$PSVersionTable`, `Get-Command`, `Test-Path`, and the absolute OS-hosted `Get-AppxPackage` query on the home PC | 2026-09-23 | yes |
| **Sid wants every reply from a session to end with a list or table of what happens next**, and each step to carry its own timing — a date, or a named trigger such as "when X merges". A bare "do this next" with no time attached is not what he asked for. He also wants sessions to assume he is skimming | Sid, 2026-09-22, stated as a standing preference for how sessions report to him | 2026-09-22 | yes |

## Adding a row

One line. `fact | how we know | date observed | still true?` — and if it contradicts
something, fix that something in the same commit.
