# Fact-check: "Obsidian as Jarvis's memory" (2026-09-14)

**What was checked:** `scratchpad/obsidian-memory-research.md`, all sections.

**Method**
- Read-only. Nothing in the repository, Cloudflare, GitHub or any provider was changed.
- Primary pages were fetched on 2026-09-14: vendor docs, changelogs, pricing pages, the App Store, READMEs, and the GitHub REST API (unauthenticated).
- The fetch tool summarises pages. Where wording mattered, I asked for verbatim quotes. Three pages blocked or truncated the tool (the GitSync wiki, a GitHub plan-availability box, GitHub's pricing page), so I read their HTML directly.
- Repository claims were read from `origin/main` at `8150e36` and `origin/claude/r2-memory-research`.
- The coordinator stopped fetching partway through, to save credits. Claims not reached are listed in §2 and should be treated as unverifiable.

**Verdicts:** Verified, Partly, Contradicted, Unverifiable. The estimates are marked Unverifiable, with a sanity check in the note.

---

## Result in brief

| Verdict | Count |
|---|---|
| Verified | 85 |
| Partly | 7 |
| Contradicted | 3 |
| Unverifiable (1 fact plus 3 estimates) | 4 |
| **Total checked** | **99** |

**Top corrections**
1. **Branch protection and rulesets are not available on private repositories under GitHub Free.** They need GitHub Pro or higher. Plan C's "$0" and "history protected" cannot both be true. Without protection, GitSync's own **Force Push** option can overwrite `main` from the phone.
2. **A GitHub webhook cannot be C's only feed of Sid's edits.**
   - GitHub does not redeliver failed webhook deliveries automatically.
   - It requires a response within 10 s.
   - It sends no payload at all above 25 MB.
   - The `added`, `modified` and `removed` lists can be empty on very large commits.
   - Push payloads never report renames.
3. **Cloudflare Artifacts pricing is published**, contrary to the research: the first 10,000 operations a month are included, then $0.15 per 1,000; the first 1 GB is included, then $0.50 per GB-month. It is still in closed beta.
4. **The research misreads Sid.**
   - AGENT_LOG `d31153e` says to design the tree "so a later optional Obsidian view can mirror it", and "No Obsidian build now". It does not say Sid wants to browse and organise the tree in Obsidian.
   - `757fe01` records a challenge, not a confirmed choice.
   - Sid later said: "why would i want notes to show in my phone? im confused".
5. **The approved Obsidian spec also rejected a read-only export (§3.2).** The research does not mention this. C-lite reopens that option, so the reason (Sid's later words) must be recorded.
6. **The 3 Sep roadmap says only the Obsidian app can write through Obsidian Sync.** That was already false: the official headless client has been in open beta since February 2026.
7. **Two estimates need adjusting.**
   - 7–10 builder sessions looks low for two-way sync (my estimate is 9–13).
   - "$1–5 a month" leaves out the GitHub Pro plan that C's own design needs.

**Recommendation:** C-lite. The D1 ledger and index stay authoritative. The ledger is built ready for C. Jarvis writes a one-way Obsidian-format export of the topic tree, only if Sid agrees to GitHub holding a copy. Two-way editing waits until Sid asks to edit notes himself.

---

## 1. Claim table

### A. Transports

| # | Claim (research) | Verdict | Source | Note |
|---|---|---|---|---|
| A1 | Remotely Save: last release 0.5.25 on 20 Oct 2024; last commit 10 Nov 2024 | Verified | https://api.github.com/repos/remotely-save/remotely-save/commits | Latest commit `34db181` ("fix typos…"), 10 Nov 2024. `pushed_at` is the same day. |
| A2 | Open issue "Is this plugin Dead?" (27 Feb 2026) | Verified | https://github.com/remotely-save/remotely-save/issues/1151 | Open, 9 comments, last activity 13 May 2026. |
| A3 | "Auto sync only works when Obsidian is being opened … technically impossible … in background" | Verified | https://github.com/remotely-save/remotely-save | Verbatim in the README. |
| A4 | Free version keeps newer or larger; PRO has Smart Conflict; E2EE in openssl or rclone-crypt format; vault name not encrypted | Verified | same | |
| A5 | R2 has no bucket versioning | Verified | https://developers.cloudflare.com/r2/api/s3/api/ | `PutBucketVersioning` and `GetBucketVersioning` are both marked ❌. |
| A6 | LiveSync remotes: CouchDB, object storage (S3, MinIO, R2), WebRTC P2P | Verified | https://github.com/vrtmrz/obsidian-livesync | P2P still needs "a signalling relay". |
| A7 | Live sync requires CouchDB or P2P | Verified | https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md | "This requires a CouchDB or WebRTC P2P remote server. It is not supported for S3-compatible Object Storage." |
| A8 | "Keep replication active in the background" is desktop only | Verified | same | "Desktop only; uses more battery and network." |
| A9 | Merges automatically only with "a safe shared base" | Verified | same | Verbatim. |
| A10 | Object storage holds journals and chunks, not readable notes, so a Worker would have to reimplement the protocol | Partly | https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/releases/0.25.md | The release notes show CouchDB-style replication over object storage (`_revisions`, `new_edits: false`), plus optional E2EE and path obfuscation. No page describes the bucket layout plainly. "Not readable by a Worker" is a sound inference, and the rejection stands. |
| A11 | Fly.io "no longer free"; IBM Cloudant suggested | Verified | https://github.com/vrtmrz/obsidian-livesync | |
| A12 | LiveSync 1.0.28 on 9 Sep 2026, MIT | Verified | GitHub API releases | 12,319★. |
| A13 | The official headless client exists and is in open beta | Verified | https://obsidian.md/help/headless | "Obsidian Headless (open beta)". |
| A14 | npm 0.0.14 (30 Jul 2026), licence "UNLICENSED" | Verified | https://registry.npmjs.org/obsidian-headless | Published 2026-07-30T15:23Z. |
| A15 | Proprietary, closed-source client | Verified | https://github.com/obsidianmd/obsidian-headless | The repo holds only a minified 218 KB `cli.js` (172 lines), a birthtime add-on, a README, a CHANGELOG and `package.json` (`"license": "UNLICENSED"`). There is no source and no licence. |
| A16 | Needs Node ≥22 and an active Sync subscription | Verified | https://obsidian.md/help/sync/headless | |
| A17 | Needs Linux or a container | Partly | same; https://developers.cloudflare.com/containers/get-started/ | The client itself runs on Windows (prebuilt win32 x64, arm64, ia32), macOS and Linux. Linux comes in only because the PCs-off host would be a Cloudflare Container, which "must be able to run on the `linux/amd64` architecture". Route (c′) already says this correctly. |
| A18 | Bidirectional, pull-only and mirror-remote modes; merge or conflict strategy; don't use desktop Sync and headless on one device | Verified | https://obsidian.md/help/sync/headless | |
| A19 | A moderator warned in March 2026 to "expect more breaking changes" | Verified | https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740 | WhiteNoise, 5 Mar 2026: "Expect more breaking changes in this beta period." |
| A20 | Unattended sign-in relies on reusing the `auth_token` file | Verified (community) | same | A community reply: there is "not a easy/supported way to get the token without an interactive environment". |
| A21 | Sync Standard $4 (annual) or $5 (monthly): 1 GB, 1 vault, 1 month history. Plus $8 or $10: 10 GB, 12 months | Verified | https://obsidian.md/sync | Also: Standard allows a 5 MB maximum file. Plus goes up to 100 GB, 10 vaults and 200 MB files. |
| A22 | Markdown merges with diff-match-patch; other files last-modified-wins; "Create conflict file" since 1.9.7, set per device; notes auto-created on two devices can be lost | Verified | https://obsidian.md/help/sync/troubleshoot | |
| A23 | Sync does not run in the background on mobile | Verified | https://forum.obsidian.md/t/sync-not-pushing-full-update/96274 | WhiteNoise, 7 Jan 2026: "sync does not work in the background … Sync picks back up when you reopen the app." |
| A24 | GitSync is free; Premium $24.99 unlocks more repositories; scheduled sync is a separate purchase | Verified | https://apps.apple.com/us/app/gitsync/id6744980427; https://gitsync.viscouspotenti.al/wiki/faq | FAQ: "The free app syncs one repository." Premium also adds git filters (LFS, git-crypt). Enhanced Scheduled Sync is a subscription; its price is not on the listing. |
| A25 | 4.3★ from 25 ratings; v1.8.65 (11 Sep 2026); GPL-3.0 | Verified | App Store; GitHub API | |
| A26 | The wiki recommends a Shortcuts automation: Obsidian Is Opened or Is Closed → Sync Now, Run Immediately | Verified | https://gitsync.viscouspotenti.al/wiki/sync-options/background/app-based | "This is the recommended approach for notes apps like Obsidian on iOS … Set to Run Immediately (no confirmation prompt)". |
| A27 | iOS App triggers exist and automations can run without asking | Verified | https://support.apple.com/guide/shortcuts/setting-triggers-apde31e9638b/ios; https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/ios | "Turn off Ask Before Running, then tap Don't Ask". |
| A28 | How GitSync opens Obsidian's iOS folder is unverified [U] | Verified (now resolved) | https://viscouspotenti.al/posts/gitsync-all-devices-tutorial | GitSync's author: a direct clone into "On this device > Obsidian > the name of the vault". The Obsidian Git plugin "will interfere with GitSync" and must be disabled on the phone. |
| A29 | Git on a phone can raise conflicts the user has to resolve | Verified | https://gitsync.viscouspotenti.al/wiki/merge-conflict-resolution | During a conflict, "Sync methods other than Force Push and Force Pull are disabled". Sync stops until Sid acts. Free scheduled sync on iOS "may start much slower (sometimes days)" and is disabled when the app is closed (wiki, Scheduled Sync). |
| A30 | Obsidian Git on mobile is "very unstable" and the README points to GitSync | Verified | https://github.com/Vinzent03/obsidian-git | It uses isomorphic-git, has no SSH, is limited by RAM, and can crash on clone or pull. |
| A31 | Obsidian Git works on the Windows PCs | Verified | https://publish.obsidian.md/git-doc/Installation | Needs Git for Windows 2.29 or later with Git Credential Manager. "Installing GitHub Desktop is not enough". It runs only while Obsidian is open [E]. |
| A32 | Obsidian Git 2.39.0 (12 Aug 2026), last push 8 Sep 2026, MIT, 11,971★ | Verified | GitHub API | |
| A33 | No official server API writes into iCloud Drive; only unofficial wrappers such as pyicloud with a 2FA-trusted session | Verified | https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html; https://github.com/picklepete/pyicloud | Apple's web API reaches an app's own CloudKit container ("container ID begins with `iCloud.`"); server-to-server keys reach only the public database. No iCloud Drive document access is documented. The absence is inferred from that scope. pyicloud (third-party) can upload after 2FA. |
| A34 | "iCloud Drive on Windows may lead to file duplication or corruption" | Verified | https://obsidian.md/help/sync-notes | |
| A35 | Obsidian recommends iCloud for iOS and macOS | Verified | same | Under iPhone and iPad: "Recommended options: Obsidian Sync, iCloud". |

### B. Cloudflare

| # | Claim | Verdict | Source | Note |
|---|---|---|---|---|
| B1 | Vectorize changelog of 30 Jun 2026: median under 30 s, p99 under 2 min (was 2 and 5 min) | Verified | https://developers.cloudflare.com/changelog/post/2026-06-30-improved-wal-throughput/ | The page is dated **1 July 2026** (the URL slug says 06-30). Cloudflare's client API reference still says "typically takes a few seconds" (https://developers.cloudflare.com/vectorize/reference/client-api/), so the docs disagree. Plan on the changelog figures. |
| B2 | Workers have no filesystem | Partly | https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/ | `node:fs` gives a virtual filesystem (`nodejs_compat`, compatibility date 2025-09-01 or later). `/tmp` "is not persistent and unique to each request", and it is held in memory. There is no persistent filesystem, so the conclusion stands. |
| B3 | D1 supports FTS5 | Verified | https://developers.cloudflare.com/d1/sql-api/sql-statements/ | Includes `fts5vocab`. The earlier fact-check confirmed `wrangler d1 export` cannot export FTS5 tables. |
| B4 | Artifacts exists: Workers binding, REST API and Git access | Verified | https://developers.cloudflare.com/artifacts/ | |
| B5 | Artifacts is in closed beta | Verified | same; https://developers.cloudflare.com/artifacts/platform/changelog/ | "Currently in closed beta". The changelog shows "private beta" on 16 Apr 2026, and later entries (18 May, 17 Jun, 13 Aug) announce no public beta. The blog's expected "public beta … early May" did not arrive. |
| B6 | Artifacts "Pricing not published" / "Pricing unpublished" | **Contradicted** | https://developers.cloudflare.com/artifacts/platform/pricing/; https://blog.cloudflare.com/artifacts-git-for-agents-beta/ | First 10,000 operations a month included, then $0.15 per 1,000. First 1 GB included, then $0.50 per GB-month. Not available on Workers Free. The launch blog, which the research itself cites, gives the same prices. |
| B7 | Workflows limits suit a sync pipeline | Verified | https://developers.cloudflare.com/workflows/reference/limits/ | On Paid:<br>- 10,000 steps by default (25,000 maximum).<br>- 30 s CPU per step by default (5 min maximum).<br>- 1 MiB per step result and per event payload.<br>- 1 GB persisted state, 30-day retention.<br>- 10,000 subrequests per instance by default.<br>Pass file lists through D1 or R2, not as step results. |
| B8 | Container disk is ephemeral; snapshots "coming soon" | Verified | https://developers.cloudflare.com/containers/faq/ | "All disk is ephemeral." |
| B9 | Route (c) means a Linux container | Verified | https://developers.cloudflare.com/containers/get-started/ | `linux/amd64` only. |
| B10 | Vectorize median query time about 30 ms (2024 redesign) | Verified | https://blog.cloudflare.com/workers-ai-bigger-better-faster/ | 26 Sep 2024: "from 500 ms to 30 ms". |
| B11 | D1 reads from Workers: average 8.4 ms, p95 14.2 ms [C] | Verified (community figure) | https://pickuma.com/for-dev/cloudflare-d1-serverless-database-review/ | Primary-key SELECTs in one app; updated 21 Aug 2026. FTS5 was not measured. |

### C. GitHub

| # | Claim | Verdict | Source | Note |
|---|---|---|---|---|
| C1 | The contents API needs the old blob SHA and "must use these endpoints serially" | Verified | https://docs.github.com/en/rest/repos/contents | |
| C2 | Contents API size limits; private tarball links expire after 5 minutes | Verified | same | Full features up to 1 MB; raw only from 1 to 100 MB; 1,000 files per directory listing. |
| C3 | Update ref with `force: false` is fast-forward only; failure returns 422 | Partly | https://docs.github.com/en/rest/git/refs | The fast-forward default is right. The docs list **409 Conflict** as well as 422 ("Validation failed, or the endpoint has been spammed"), so handle both. |
| C4 | Atomic multi-file commits through the Git database API | Verified | https://docs.github.com/en/rest/git/trees | `base_tree`; `sha: null` deletes a file. A recursive "Get a tree" is capped at 100,000 entries or 7 MB, beyond which it is truncated. |
| C5 | Plain HTTPS from a Worker works | Verified | https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api | Set a User-Agent: "Requests with no `User-Agent` header will be rejected." |
| C6 | 5,000 requests/hour; 80 content-creating/min and 500/hour | Verified | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api | App installations get 5,000–12,500 an hour; 100 concurrent requests; 900 points a minute. |
| C7 | A push webhook carries added, modified and removed paths, up to 2,048 commits and 25 MB, signed with `X-Hub-Signature-256` | Partly | https://docs.github.com/en/webhooks/webhook-events-and-payloads; https://raw.githubusercontent.com/octokit/webhooks/main/payload-schemas/api.github.com/common/commit.schema.json; https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries; https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks | True, but it omits the failure modes:<br>- Over 25 MB, "GitHub will not deliver a payload".<br>- The file lists "may be empty" on extremely large commits.<br>- There is no rename field.<br>- No event fires when more than 5,000 branches are pushed at once.<br>- The receiver must answer within 10 s.<br>- "GitHub does not automatically redeliver failed webhook deliveries".<br>C needs a scheduled catch-up sweep. |
| C8 | Detecting renames is a trial item [U] | Verified (now resolved) | https://docs.github.com/en/rest/commits/commits | Push payloads carry no renames. The Compare API marks files `renamed` with `previous_filename`, but lists at most 300 files per comparison. A bulk reorganisation needs a tree diff. |
| C9 | Branch protection on a private repo under a free personal account is unverified and may need a paid plan [U] | Verified (now resolved: paid plan needed) | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches; https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets | "Protected branches are available in public repositories with GitHub Free … also available in public and private repositories with GitHub Pro, GitHub Team…". Rulesets split the same way. A Free private repo has neither. |
| C10 | Force pushes are blocked by default on protected branches | Verified | about-protected-branches (above) | |
| C11 | App installation tokens "expire after 1 hour" and can be scoped to one repo and chosen permissions | Verified | https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app; https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app | Installation offers "Only select repositories". |
| C12 | Private repos are $0 | Verified | https://github.com/pricing | "Unlimited public/private repositories". |
| C13 | Up to 10 GB on disk, 3,000 entries per directory, depth 50 | Verified | https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits | Also: 1 MB recommended object size (100 MB enforced) and a 2 GB push limit. |
| C14 | Any policy limit on using a private repo as a data store | Verified: no explicit ban | https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies | Forbids "excessive automated bulk activity" and "undue burden on our servers through automated means". Excessive bandwidth can lead to suspension. One commit per run is far below any limit [E]. |
| C15 | GitHub would be a new third party holding plain text | Verified | https://docs.github.com/en/site-policy/github-terms/github-terms-of-service (§E) | Private repos are "confidential to you", but GitHub may access them for security, "automated scanning or manual review", support, integrity of the service, and legal obligations. GitSync's own FAQ: "a private repository is readable by whoever runs the server." |
| C16 | Price of the paid GitHub plan that branch protection needs | Unverifiable | https://github.com/pricing | GitHub's public pricing page does not list Pro (705 KB page searched), and the plans doc gives no price. Third-party sites say $4 a month. |

### D. Ecosystem

| # | Claim | Verdict | Source | Note |
|---|---|---|---|---|
| D1 | Khoj Cloud shut down on 15 Apr 2026 | Verified | https://app.khoj.dev/ | "Khoj Cloud Has Been Sunset … April 15, 2026"; self-hosting only. |
| D2 | Karpathy's "LLM Wiki" (April 2026): immutable raw sources, "The LLM owns this layer entirely", a schema file, ingest, query and lint, works at "~hundreds of pages" | Verified | https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f | Created 4 Apr 2026. Also: "The wiki is just a git repo of markdown files", with Obsidian open beside the agent. |
| D3 | OpenClaw: "plain Markdown in the agent workspace. The files are the source of truth" | Verified | https://github.com/openclaw/openclaw/blob/e321f21d/docs/concepts/memory.md | Daily `memory/YYYY-MM-DD.md` plus an optional `MEMORY.md`. The workspace sits on the host (`~/.openclaw/workspace`). |
| D4 | QMD "BM25 + vectors + reranking"; "`memory_search` never blocks on indexing; results can be slightly stale" | Verified | same | |
| D5 | The memory-wiki plugin has an Obsidian render mode | Verified | https://docs.openclaw.ai/plugins/memory-wiki | `vault.renderMode: obsidian`; optional. |
| D6 | OpenClaw 389,634★, v2026.9.4 (11 Sep 2026) | Verified | GitHub API | 389,637★ today. |
| D7 | Nymaxxx/obsidian-telegram-agent: Linux VPS with Docker, headless client plus Sync | Verified | https://github.com/Nymaxxx/obsidian-telegram-agent | "a Linux VPS (1 vCPU, 1 GB RAM minimum)"; Sync "required". **0★**. Always-on host. |
| D8 | smixs/iva: Telegram on "your server", private git repo, verbatim daily logs rolled up to `CORE.md` (≤1,200 chars), sanitizer gaps; 211★, v0.4.3 | Verified | https://github.com/smixs/iva | Now `iva-agent`. Runs on a VPS or an owned Ubuntu or Debian machine under systemd. Always-on host. |
| D9 | komrxn/Mnemo: own machine (Docker), git sync with Obsidian Git, conflicts not auto-resolved, immutable transcripts with a derived graph | Verified | https://github.com/komrxn/Mnemo | **3★**. Always-on host. |
| D10 | Olduck1067/agent-second-brain: "$5 VPS", systemd, GitHub push | Verified | https://github.com/Olduck1067/agent-second-brain | **0★**; last push 26 Feb 2026. |
| D11 | evannagle/ludolph: the vault stays on a Mac; a Pi wakes the Mac | Verified | https://github.com/evannagle/ludolph | **1★**. |
| D12 | About ten Telegram assistants on Obsidian, and every PC-off setup uses an always-on machine | Verified (with a scale caveat) | D7–D11; GitHub API for 8 repos | The research lists 8 Telegram projects plus 1 Claude Code project. All 5 READMEs read need an always-on host. Star counts are 0–3, except iva at 211. The *pattern* is common, but no mature product uses it. |
| D13 | eddmann/obsidian-mcp: git-backed, AWS Lambda, 14★, last push 3 Dec 2025 | Verified | GitHub API | |
| D14 | obsidian-mcp-tools archived 13 May 2026 | Verified | GitHub API | |
| D15 | kepano/obsidian-skills 48,292★, MIT | Verified | GitHub API | 48,293★. |
| D16 | Plugins can access files and the internet and install programs; Obsidian "cannot reliably restrict" them; it scans every version | Verified | https://obsidian.md/help/plugin-security | |

### E. Repository

| # | Claim | Verdict | Source | Note |
|---|---|---|---|---|
| E1 | The spec rejects "Git repository, or Git worktree roots", defers "mobile vault synchronization", and says "Jarvis never cloud-syncs the vault directory itself" | Verified | `docs/superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md:41-43, 69-73, 1150` | Scope is the local Windows adapter ("Sid's Windows machine"). Line 717 ties the git rule to the Jarvis repo and worktrees, but line 42 and plan line 26 ("outside Git repositories/worktrees") state it generally. It also says "The vault files remain local-only." |
| E2 | Spec §3.1 rejects the vault as the only memory store | Verified | spec `:77-83` | It lacks "transactional ordering, immutable provenance, fact promotion, supersession, principal scoping, or crash recovery". |
| E3 | The Obsidian spec is "approved" | Verified | spec `:4`; roadmap `:58, :64-68` | "Approved base". The roadmap says it was written by "Codex, unsupervised", and calls the Codex amendments "approved on paper, mostly unbuilt". |
| E4 | DECISIONS, 3 Sep: "Jarvis's own two-tier memory is the source of truth. Obsidian is the readable, editable window, synced as a git-backed vault so notes reach every device with the PCs off." | Verified | `DECISIONS.md:84-87` | The same list records the "one small always-on server" that `CLAUDE.md` says Sid did not ask for (`:73-77`). |
| E5 | The roadmap's R2 exit test includes Obsidian on the phone | Verified | `docs/plan/2026-09-03-jarvis-roadmap.md:448-451` | "Open Obsidian on the phone; the fact is there as a note with its source. Write a note on the phone; `/vault` finds it within a cycle." |
| E6 | What the roadmap says about the phone | Verified | roadmap `:311-316, :326, :441-444, :609-611` | Jarvis commits from the home node; "the Obsidian Git plugin on the iPhone and each PC"; "iPhone (window only)"; Obsidian Sync "not needed … never required". |
| E7 | Roadmap: "Obsidian Sync would need a PC on … because only the Obsidian app can write through it" | **Contradicted** | roadmap `:315-316`; https://github.com/obsidianmd/obsidian-headless | The headless Sync client repo was created 27 Feb 2026 and was in open beta well before the 3 Sep roadmap. |
| E8 | The spec and the 3 Sep decision contradict each other, and nobody reconciled them | Verified | spec `§2`; `DECISIONS.md:84-87`; roadmap `:64-68, :368`; earlier research `:485` | Real on paper. Roadmap §6 re-scoped the Obsidian *plan* (O8–O10 moved to R2 "on the home node"; O5, O7 and O11 deferred) and says the roadmap outranks the Codex amendments. It never amended the spec's §2 root and sync rules. The earlier research flagged only the iPhone plugin. |
| E9 | The earlier report removed Obsidian from the exit test | Verified | earlier research `:481, :541` | "not part of the R2 exit test". |
| E10 | "He wants to browse and organise a tree of areas the way Obsidian lets him [R AGENT_LOG `d31153e`]"; plan A "fails requirement 5 as Sid means it" | **Contradicted** | commit `d31153e` (`docs/AGENT_LOG.md`) | The log calls the tree a memory-structure requirement "taken from what he liked about Obsidian". It says "Design the tree so a later optional Obsidian view can mirror it" and "No Obsidian build now". It says nothing about Sid browsing or organising it himself. |
| E11 | "Sid has now confirmed that he wants Obsidian [R AGENT_LOG `757fe01`]" | Partly | commit `757fe01` | It records that Sid "challenged the storage recommendation" and pointed to others' Obsidian builds. It keeps "The requirements themselves are unchanged; only the storage mechanism is open." That is a question about storage, not a confirmed wish to use Obsidian as his interface. |
| E12 | ARCHITECTURE rules: "The database enforces the invariant, not the code that writes to it", and rules 1, 2 and 4 | Verified | `docs/ARCHITECTURE.md:13, 29, 41, 52` | |
| E13 | KNOWN_ISSUES: no redactor runs over vault observations | Verified | `KNOWN_ISSUES.md:509-519` | |
| E14 | Voice gate: p95 first audible ≤4 s over 20 turns; 8 s to first model token | Verified | foundation design `:154`; `docs/runbooks/voice-smoke.md` (inbound sample paragraph) | |
| E15 | `jarvis node` refuses non-Linux; roadmap `:231` and `:428` | Verified | `apps/local-agent/jarvis_local/node.py:239-240`; roadmap `:231, :428` | |
| E16 | The earlier plan's steps 1–10 take about 4–6 builder sessions | Verified | earlier research `:546` | |

### F. Estimates and costs

| # | Claim | Verdict | Source | Note |
|---|---|---|---|---|
| F1 | Index retrieval about 0.1–0.4 s [E] | Unverifiable (estimate) | B10, B11 | Plausible. The query-embedding call and FTS5 on Jarvis's data are unmeasured, so the embedding is the likely long pole. Measure it in the build. |
| F2 | Reading 5–10 vault files per turn takes 1–3 s or more [E] | Unverifiable (estimate) | Three contents-API GETs from Sid's PC, not a Worker: 214, 118 and 156 ms | Sequential reads come to about 0.6–2 s; parallel reads about 0.2–0.5 s. The extra model step to choose files, plus GitHub sitting in the call path, is the real cost. The conclusion (voice reads the index, never files) stands. |
| F3 | 7–10 builder sessions for M1–M5 [E] | Unverifiable (estimate): likely low | E16 and reasoning | Two-way reconcile adds a catch-up sweep (C7), rename handling past the 300-file cap (C8), a quarantine guard, an inbound redactor and phone support. My estimate is **9–13** for C and **5–8** for C-lite [E]. |
| F4 | Default about $1–5 a month; "about $0" extra (§1) | Partly | earlier fact-check [F]; C9; C16 | The model ($1.04–3.80) plus Vectorize (≤$0.60) plus GitHub Free comes to about $1.05–4.40. But C's §7.4 wants branch protection, which needs a paid plan (price unverifiable; third parties say $4 a month). §1 says "$1–6" and §7.7 says "$1–5". |
| F5 | With Obsidian Sync, about $7–15 a month [E] | Verified (arithmetic, Standard plan) | A21; earlier fact-check (Containers) | $1.04–3.80 + $4–5 + $1.74–4.60 = $6.78–13.40. On the Plus plan, $10.78–18.40. |

---

## 2. Not re-checked (treat as unverifiable here)

The coordinator's stop came before these, and they carry little weight for the storage decision:
- **Obsidian docs:** O1 (licence date), O9, O11, O14 and O15 (format details: properties, block IDs, callouts, embedded queries), O22 (the "File over app" quote).
- **Plugin and tool pages:** P1–P3, P5, P6 and P9–P12 (MCP and plugin details), P14, P20 (maintainer comment), P21 and P30 (community reports), Basic Memory Cloud's $15 price (P8).
- **Community write-ups and other READMEs:** G4 (BetterClaw), G6–G8, G10, G13–G17 (apart from the metadata already checked), G5 (Anthropic memory tool).
- **Cloudflare:** C1 (R2 `onlyIf` returns null), C3 (R2 event notifications), C5 and C6 (Container persistence patterns).
- **Security:** S1 (OWASP).

---

## 3. Corrections to the research

1. **§4.1 route (b), §4.2, §7.4 and §8.4: branch protection on a private repo needs GitHub Pro, Team or Enterprise.** Rulesets are split the same way (C9). Either budget for a paid plan or drop the protection. Without it, three things can rewrite `main`:
   - GitSync's Force Push, offered right in its conflict flow (A29);
   - a leaked phone token;
   - any token with contents-write access.
2. **§5.5, §5.8 and §7.4: webhooks are not a reliable sole feed (C7).**
   - No automatic redelivery.
   - A 10 s response deadline.
   - No payload above 25 MB.
   - File lists can be empty.
   - No renames: use the Compare API (300-file cap) or tree diffs (C8).
   C needs a scheduled reconcile sweep against `main`. The 422-only retry should also handle 409 (C3).
3. **§4.1 (b′), §8.1 and §8.7: Artifacts pricing is published (B6).** It is still in closed beta, so "Later" stands.
4. **§2.2 and §8.5: the reading of Sid is wrong (E10, E11).** Requirement 5 is a *memory structure* requirement with an *optional later* view. Nothing in the log says Sid wants to edit a vault. Plan A's "fails requirement 5" does not follow.
5. **§7.9 misses a point.** Spec §3.2 *rejected a read-only export* as "too little benefit", on the premise (§1) that the vault "gives Sid a normal notes interface for reading and editing". That premise came from an unsupervised Codex design (E3) and conflicts with Sid's 14 Sep words. Adopting C-lite must record that change in `DECISIONS.md`.
6. **§1 item 6 and §7.1 ("notes reach your iPhone…"), plus §6 row 8 ("no taps"):** true only at app open or close, through Shortcuts (A26, A27). Conflicts stop sync until Sid resolves them (A29). Free background sync on iOS may run days apart, and reliable background sync is a subscription (A24, A29). So C still gives Sid homework.
7. **§2.3 and §3.1: Workers do have a filesystem API**, but it is per-request and in memory (B2). The conclusion is unchanged.
8. **§5.5 and §8.6: Cloudflare's own docs conflict on Vectorize lag** ("a few seconds" in the client API page against the changelog's <30 s median and <2 min p99). Use the changelog, and note the page date of 1 Jul 2026 (B1).
9. **§7.5 and §7.7:** 7–10 sessions is probably low (F3). "$1–5" leaves out the paid GitHub plan C's own design calls for (F4). §1 and §7.7 disagree ($1–6 against $1–5).
10. **§4.1 (d):** the LiveSync object-storage format is inferred, not documented (A10). The rejection stands on A7 anyway.
11. **§3.2 and §3.3:** say the Telegram-on-Obsidian projects are hobby-scale (0–3★ except iva at 211) and all need an always-on host (D12). "Lots of people use it" is true of the pattern, not of any proven product.
12. **Roadmap §5.4 (context for the research's §2.4):** the claim that only the Obsidian app can write through Sync was already false on 3 Sep (E7).

---

## 4. Critical assessment: C vs C-lite

### 4.1 What Sid said, and what it implies

| Sid's words (this project's conversation) | Implication |
|---|---|
| "all that i want is for jarvis to have the best memory possible … like a personal assistant whose sole job is to be ur assistant" | The goal is memory *quality*: store everything, remember what matters, recall anything. |
| "i dont care for me end, all i want for my end is use jarvis not whats behind him" | His interface is Jarvis (Telegram and calls), not a notes app. No homework. |
| "why would i want notes to show in my phone? im confused" | Notes on the iPhone, C's centrepiece, solve a problem he says he doesn't have. |
| "why dont we just use obsdian its already established and better than whatever we build?" | His worry is a home-made, inferior store. He wants the proven pattern and format. |
| "i think u need to research obsdian properly a lot of people use it for their version of jarvis" | Decide from evidence. The evidence (D2–D12) shows Obsidian supplies the **format and viewer**. Every project still builds its own capture, distillation, index and sync around the files, on an always-on host. |
| A huge, highly organised library or brain: St. Remy, then Website and PC App, and so on | A topic tree Jarvis files into and walks. The folder shape is what he liked. |

"Just use Obsidian" cannot remove the build: Obsidian contributes no memory logic, and a Worker cannot hold the files (B2).

On Sid's fleet the canonical copy lives either in Cloudflare (D1) or in a git host. The only thing C adds over C-lite that Sid would *feel* is editing notes in Obsidian, and his own words reject that.

### 4.2 Comparison

C = Obsidian vault as Sid's editable view, D1 ledger underneath, two-way git sync, GitSync on the iPhone.
C-lite = D1 ledger and index authoritative, topic tree in D1, one-way Obsidian-format export to a private GitHub repo that Sid may open whenever he likes. Two-way editing is an optional later upgrade.

| Criterion | C | C-lite |
|---|---|---|
| **Store everything, auto-remember, recall anything** | Yes; same D1, R2 and index | Yes; identical |
| **Guesses flagged; receipts; forget** | Strong (ledger) | Strong (ledger); identical |
| **Organised like a brain** | Folders both ways; Sid can re-file | D1 topic tree walked by "what do you know about St. Remy"; the export mirrors it as folders |
| **Every PC off; voice ≤4 s** | Yes (index path) | Yes; identical |
| **No homework** | **No**: phone install and folder pick (A28), two Shortcuts automations (A26), a one-week trial (M0), conflict dialogs that stop sync (A29), quarantine questions on Telegram | **Yes**: nothing to install or resolve. Opening the export is optional. |
| **"Use the established thing"** | Obsidian as editor | Obsidian's format and the LLM-Wiki shape: a git repo of Markdown, folder-index notes, history (D2) |
| **Sync drift** | Many sources: missed or oversized webhooks, empty file lists (C7), renames (C8), iOS background limits (A23, A29), conflicts blocking sync, Force Push (A29). Needs a periodic full reconcile. | One direction only. The export can lag, but it can be rebuilt from the ledger at any time. |
| **Data loss** | Vault deletions are authoritative (guarded by quarantine). A free-plan repo has no protection against force pushes (C9, A29). Wrong phone merges are recoverable from history. | Memory cannot be lost through the repo. A broken export is regenerated. |
| **Prompt injection and tampering** | Every vault edit is ingested. An edit to a Facts line becomes an owner fact, so anyone with repo write access (phone token, PC credential, GitHub account) can plant authoritative memory. Pasted text enters the index. | The repo is output only and **never read back** into memory or prompts. A compromised repo can only deface a view, and the next run repairs it. |
| **Build effort [E]** | 9–13 sessions (research: 7–10) | 5–8 sessions: the earlier 4–6 [E16] plus the topic tree and a one-way render |
| **Cost per month** | About $1–4.40, plus a paid GitHub plan if protection is kept (price unverifiable; third parties say $4). The Sync route adds $4–5 plus a $1.74–4.60 Linux container. | About $1–4.40. GitHub Free. No GitSync Premium, no Pro, no Sync, no Linux. |
| **Privacy** | GitHub holds plain text (C15). Whatever Sid types, secrets included, is pushed. A write-capable token lives on the phone. | GitHub holds plain text, but Jarvis's code decides the scope. Sensitive classes and raw transcripts are left out, no token lives on the phone, and it can stay off entirely. |
| **Reversibility** | Moving back to C-lite later means unwinding Sid's editing habits and edits | **High**, if the ledger is C-ready from day one (§4.4). C then adds only the inbound path. |

**Privacy options for either plan**
- git-crypt encrypts file *contents* only. It "does not encrypt file names, commit messages", so topic names like `St. Remy/Website.md` stay visible. The docs call it "not the best tool for encrypting most or all of the files in a repository" (https://github.com/AGWA/git-crypt). The phone would need GitSync Premium (A24).
- Keep the export only in R2, so no new custodian is added. That makes opening it in Obsidian harder [E].

### 4.3 Recommendation

**Choose C-lite.** It meets every requirement Sid stated as well as C does, with far less risk, homework and cost. It gives him the thing he credited Obsidian for: an organised, portable Markdown brain he can open. It avoids the part he said he doesn't want: notes on his phone, and managing sync. Build the ledger ready for C, and add two-way editing only if Sid later says he wants to edit notes himself.

R2 exit test (every PC off):
1. Tell Jarvis something on Telegram.
2. Ask about it on a call, within the voice gate.
3. `/why` shows the receipt, and `/forget` hides the item.
4. "What do you know about St. Remy?" walks the tree.
5. If the export is on, the fact appears in the right topic note in the repo after the next run.

Drop the iPhone-Obsidian exit items from R2.

### 4.4 What C-lite must include to stay reversible [E]

- **Stable item IDs with versioned text** (not content-hash IDs), topic IDs, and append-only topic move history.
- **The same note grammar C would use:** folder = topic, `jarvis_id` in frontmatter, one block ID per memory line, Facts and Guesses sections, a folded sources box.
- **A GitHub App on one repo** with contents write and no webhook. One commit per run, fast-forward only; on 409 or 422, re-read `main` and render again.
- **The repo is never read back** into memory, the index or prompts.
- **If `main` has non-Jarvis commits,** leave non-Jarvis files alone and tell Sid once on Telegram that edits there are not memory, and he should tell Jarvis instead.
- **Export scope excludes** health, money, credentials, other people's private details and raw transcripts. The export stays off until Sid answers Q1.

---

## 5. Questions for Sid (yes/no)

**For C-lite (recommended)**
1. **Custody:** Can Jarvis keep a private, read-only copy of its organised notes about you on GitHub, a second company besides Cloudflare that does not encrypt it end to end? **Recommended: yes**, with health, money, passwords and other people's private details left out. A "no" changes nothing else.
2. **Physical (only if Q1 is yes):** Will you approve, once, on GitHub while signed in, Jarvis's access to just that one private repository? **Recommended: yes.**

No money question: the model cap Sid already set ($5 a month) is unchanged, and GitHub Free costs $0.

**Only if the reviewer chooses C instead**
3. **Money:** Will you pay for GitHub Pro (GitHub doesn't show the price publicly; other sites say $4 a month) so the notes' history can't be overwritten from a phone? **Recommended: yes, if C.**
4. **Physical:** Will you install Obsidian and GitSync on your iPhone, point GitSync at the vault, add two Shortcuts automations, and try it for a week? **Recommended: no**, unless you want to edit notes on your phone yourself.
5. **Privacy:** Is it OK that anything you type into those notes, passwords included, gets copied to GitHub? **Recommended: no**; keep a private folder that never syncs.
6. **Money and platform:** Would you pay $4–5 a month for Obsidian Sync, which also needs Jarvis to run a small Linux container inside Cloudflare? **Recommended: no.**
