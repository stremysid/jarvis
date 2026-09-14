# Obsidian as Jarvis's memory: research and recommendation (2026-09-14)

Read-only research by Claude Opus 5, commissioned by the reviewer. Nothing in the
repository, Cloudflare, GitHub or any provider was changed, queried with write
access, or deployed. Repository basis: `origin/main` at `8150e36`. The earlier
recommendation and its fact-check were read from `origin/claude/r2-memory-research`.

How claims are marked:

- **[V Xn]**: verified on 2026-09-14 against source Xn in section 9. Sources are official docs, READMEs, the GitHub API, the App Store and the official Obsidian forum.
- **[F]**: verified by the 2026-09-14 fact-check of the earlier report (`docs/research/2026-09-14-jarvis-memory-research-factcheck.md`), which lists the original URL.
- **[R]**: read in the repository (file named).
- **[C]**: a community write-up or project README. The page says it, but I did not confirm it independently.
- **[E]**: my estimate or design proposal, with the reasoning given.
- **[U]**: unverified.

---

## 1. For Sid (plain words)

1. You were right. Lots of people use an Obsidian vault as their AI's memory, and it fits what you want.
2. New plan: Jarvis's memory lives in your Obsidian notes, sorted into folders by area, like St. Remy → Website.
3. You can read, fix, move or delete any memory on your phone or PC. Jarvis follows your change, with no tapping to approve.
4. Guesses sit in their own "Guesses" part of each note, so you always know what is sure.
5. Behind the notes, Jarvis still keeps every chat and call and a record of where each memory came from. That keeps calls fast and lets it answer "why do you think that?".
6. It all works with every PC off. Notes reach your iPhone through a free sync app when you open Obsidian.
7. Extra cost: about $0 on top of the $1–6 a month already planned. Obsidian's own sync ($4–5 a month) is smoother but needs a helper that is still in testing.
8. Nothing is built yet. One choice for you: the free sync app, or Obsidian's paid sync.

---

## 2. The answer in one page

### 2.1 Recommendation: (C) Obsidian-shaped memory with a cloud ledger

From R2 onward, an Obsidian-compatible Markdown vault is **the form Jarvis's memory
takes and Sid's main way to see and shape it**. It is no longer an optional window
added later. Its folder tree is the topic tree. Sid's edits, moves and deletions in
Obsidian take effect without a confirmation tap.

Underneath, Cloudflare keeps three things Markdown cannot guarantee:

1. The raw record of every Telegram turn and call. This is unchanged: D1 `events` plus the R2 archive [R `docs/ARCHITECTURE.md`].
2. A **memory ledger** in D1. For every memory item it holds a stable ID, its status (fact, guess, forgotten or replaced), its receipts, its change history and the history of topic moves.
3. A **derived index**: D1 FTS5 plus Vectorize over events, memory items and notes. Telegram and voice read only this.

How writes and edits flow:

- Jarvis writes to the ledger first. It then renders its sections of each note into a private git repository through the GitHub API.
- Sid's pushes come back through a GitHub webhook and are recorded in the ledger as owner actions.
- The iPhone syncs with the free GitSync app, triggered automatically when Obsidian opens and closes. The PCs use the Obsidian Git plugin.
- Obsidian Sync, with the official headless client in a Cloudflare Container, is the upgrade path if Sid prefers it after a trial. It needs his agreement first because the container runs Linux [R `CLAUDE.md`].

### 2.2 Why not (A), the earlier plan

- **It fails requirement 5 as Sid means it.** He wants to browse and organise a tree of areas the way Obsidian lets him [R AGENT_LOG commit `d31153e`]. Plan A kept the tree in D1 and Telegram answers, and made Obsidian "optional, later" [R research §5.4, §7 step 13].
- **It adds upkeep.** Plan A treated his note edits as proposals needing a tap [R research §5.2].
- **It dropped something the recorded plan had.** The roadmap's own R2 exit test included "Open Obsidian on the phone; the fact is there as a note with its source. Write a note on the phone; `/vault` finds it within a cycle" [R `docs/plan/2026-09-03-jarvis-roadmap.md` R2 Exit]. The earlier report removed it from the exit test.

### 2.3 Why not pure (B), the vault as the only store of what Jarvis knows

- **Every setup that works with the user's computer off runs an always-on machine that holds the vault.** The phone-reachable "Jarvis on Obsidian" projects I found use a VPS, a Raspberry Pi plus a Mac, or a Docker host [C G9–G15]. I found none on serverless compute without a filesystem [U, absence of evidence]. Sid has no such machine [R `CLAUDE.md`]. A Cloudflare Worker has no filesystem, so the vault would have to live in a git host, Obsidian's servers or R2.
- **Every transport to those places has a verified weak spot:**
  - The Obsidian headless client is an open beta, and a moderator warned in March 2026 to "expect more breaking changes" [V O19].
  - Remotely Save has had no commit since 10 Nov 2024 [V P32].
  - Git on a phone can raise conflicts that the user has to resolve [V P27].
- **Plan B would weaken the guarantees.** If the vault were the only durable store, a sync fault could lose or corrupt memory. "Guess", "confirmed" and "forgotten" would become text markers that any edit or merge can flip. The codebase's rule is that "the database enforces the invariant, not the code that writes to it" [R `docs/ARCHITECTURE.md` rule 3].
- **The approved design rejected the same idea.** It rejected "vault as the only memory store" because Markdown lacks ordering, provenance, promotion, supersession and crash recovery [R `docs/superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md` §3.1]. That reasoning still holds.

Plan C takes what the community evidence says works:

- Markdown notes in a folder tree with index notes [V G1, G2; C G6].
- An immutable raw log kept apart from curated notes [V G1, G2; C G11, G12].
- A derived search index [V G2, P8].
- Git history as the undo button [V G1; C G11, G12, G14].

It keeps Jarvis's receipts and speed on top.

### 2.4 What changes versus the earlier plan

| Area | Earlier plan (A) | Now (C) |
|---|---|---|
| Obsidian | Optional window, "not yet", later route A | Core R2 scope; the vault is memory's shape and Sid's main view |
| Sid's edits in Obsidian | Proposals that need a tap | Authoritative owner actions, with guards against mass deletion and secrets |
| Topic tree | D1 only | Vault folders, both ways, with move history in D1 |
| Facts | Immutable fact rows | Versioned memory items: Sid can edit the wording, and each version is kept |
| Transport to the phone | Obsidian Sync headless container, later | Private GitHub repo written by the Worker; GitSync on the iPhone; Obsidian Git on the PCs; Obsidian Sync as an optional upgrade |
| Index | Facts, summaries, events | The same plus vault notes, including Sid's own writing |
| "Why do you think that?" | Telegram `/why` | `/why` plus a folded "Where these came from" box in each note |
| Linux | None | None on the default path; the Obsidian Sync upgrade needs a Linux container, so ask Sid first |

The Sep 3 decision recorded "Jarvis's own two-tier memory is the source of truth. Obsidian is the readable, editable window, synced as a git-backed vault so notes reach every device with the PCs off" [R `DECISIONS.md`]. Plan C is close to it. The differences:

- Jarvis commits from the Cloudflare Worker, not a Linux home node.
- The iPhone uses GitSync, because the Obsidian Git plugin's author advises against mobile use [V P26].
- Sid's edits in the window count as his decisions, not as proposals.

---

## 3. How people build Jarvis-style assistants on Obsidian (question 1)

### 3.1 Survey table

Status columns come from the GitHub API on 2026-09-14 [V P32] unless marked otherwise.

| Tool or pattern | Where the vault lives | Works with the PC off? | How the AI reads and writes | Retrieval | Status | Known problems | Use for Jarvis |
|---|---|---|---|---|---|---|---|
| **Obsidian Local REST API** | On the device running Obsidian | **No**: needs Obsidian running [V P1] | HTTPS REST API on port 27124 with an API key. Read, create, update and delete `/vault/{path}`. PATCH targets a heading, block or frontmatter. `/commands/`; an `/mcp/` endpoint [V P1] | `/search/simple/`, JsonLogic `/search/` [V P1] | 5.1.0, 1 Aug 2026; MIT; 2,919★ | Certificate limited to 127.0.0.1 and localhost [V P1] | No: tied to the PC |
| **MCP servers built on the REST API**: `mcp-obsidian`, `cyanheads/obsidian-mcp-server`, `obsidian-mcp-tools` | Same | **No**. "You need the Obsidian REST API community plugin running" [V P2]. cyanheads wraps REST API v4–5 [V P3] | MCP tools: list, get, search, patch, append, delete [V P2] | Through the plugin | mcp-obsidian: 4,409★, MIT, no releases. cyanheads: v3.5.3, 13 Sep 2026, Apache-2.0. obsidian-mcp-tools: **archived 13 May 2026** [V P4, P32] | Depend on a desktop app being open | No |
| **MCP servers that read files directly** | Any folder; some are meant for a server or NAS | Only if hosted on an always-on machine. istrejo: "works even if Obsidian is closed" [V P5]. ykoellmann expects "a server or NAS where your vault is continuously synced (via Syncthing, git, rclone, or Obsidian Sync)" and supports API keys or GitHub OAuth for claude.ai web and mobile [V P6] | File I/O with path-traversal guards, backlinks, frontmatter edits [V P5, P6] | Full-text or regex search, in-memory graph [V P5, P6] | Many small projects, mostly single maintainers [C] | The host must be up and the vault synced to it | Pattern evidence only |
| **Git-backed MCP server** (`eddmann/obsidian-mcp`) | Git remote, cloned by the server | Yes, on AWS Lambda | "Server clones/pulls your vault from git … automatically commits and pushes changes". Lambda plus DynamoDB sessions [V P7] | Fuzzy search [C] | 14★; last push 3 Dec 2025 [V P32] | No documented conflict strategy [V P7] | Closest serverless precedent for route (b) |
| **Basic Memory** (Basic Machines) | `~/basic-memory` or configured projects [V P8] | Local: no. **Cloud: yes**. A hosted MCP endpoint `https://cloud.basicmemory.com/mcp` works from Claude web and mobile with no install [V P9] | MCP `write_note`, `read_note`, `edit_note`, `move_note`, `search_notes`, `build_context` and more. "Obsidian reads/writes the same Markdown directly" [V P8] | SQLite or Postgres FTS plus optional FastEmbed vectors and reranking [V P8] | v0.23.2, 25 Aug 2026; AGPL-3.0; 3,952★. Cloud $15/month during beta [V P8] | Mobile only through Cloud [V P8]. How Cloud reaches a phone's Obsidian vault is unverified [U] | Borrow its note grammar (`- [category] fact`, `- relation [[Target]]`). Not the store: a third party would hold memory, with no receipts or voice budget control [E] |
| **Smart Connections** | Inside Obsidian; index in `.smart-env/` [V P10] | No | Plugin UI only. No external API or MCP [V P10] | Bundled local embedding model; related notes and lookup [V P10] | 4.7.2, 6 Aug 2026; source-available licence; 5,451★; 491 open issues | Works on mobile but only inside the app [V P10] | No |
| **Copilot for Obsidian** | Inside Obsidian | No. Agent mode is desktop-only [V P11] | Agent can create files; hosted "Plus" features send requests to Brevilabs [V P11] | Local "Miyo" index kept on the device [V P11] | 4.0.8, 12 Sep 2026; AGPL-3.0; 7,710★ | Agent mode not on mobile | No |
| **Khoj** | Plugin uploads vault files to a Khoj server; default URL `app.khoj.dev`, sync interval 60 [V P12, P14] | Needs a Khoj server. **Khoj Cloud was shut down on 15 Apr 2026**; self-hosting only [V P13] | Server-side chat and search | Server-side semantic search | 2.0.0-beta.28, 26 Mar 2026; AGPL-3.0 [V P32] | A merged sync change could delete earlier batches (PR review comment) [C] | No |
| **Claude Code or Codex working in the vault** | The PC's vault folder | **No**: the agent runs on the PC | `CLAUDE.md` points to a vault index note; the agent edits notes directly [C G6, G7, G20] | The agent reads the index, then the notes it needs [C G6] | jaredrhod/ai-memory-vault: 651★, CC-BY-SA-4.0 [V P32]. Obsidian's CEO publishes agent skills for Obsidian Markdown, Bases, JSON Canvas and the CLI for "Claude Code, Codex, and Open Code" (48,292★, MIT) [V O23, P32] | The Obsidian CLI needs the app running [V O8]. Drift into a "junk drawer" without index discipline [C G6] | Borrow conventions (folder index notes, flavoured Markdown). Not the runtime |
| **LLM Wiki / second-brain pattern** (Karpathy, April 2026) | A git repo of Markdown | Depends on the host | Raw sources are immutable. "The LLM owns this layer entirely". A schema file (`CLAUDE.md` or `AGENTS.md`), plus ingest, query and **lint** operations [V G1] | `index.md` first, then pages. "Works surprisingly well at moderate scale (~100 sources, ~hundreds of pages) and avoids the need for embedding-based RAG" [V G1] | Implementations include erikschlegel/jarvis-vault, which adds MCP retrieval [C G16] | Beyond hundreds of pages it needs search [V G1 implies; C G16] | Adopt the raw-versus-curated split, index notes, lint and git history |
| **OpenClaw** (389,634★) | Agent workspace on the host [V G2] | Only on an always-on host. For a VPS, "you need a sync layer" to see memory in Obsidian [C G4] | "OpenClaw memory is plain Markdown in the agent workspace. The files are the source of truth". `MEMORY.md` plus dated daily files [V G2] | Per-agent SQLite vector index, or QMD "BM25 + vectors + reranking. Markdown stays the source of truth" [V G2]. The memory-wiki plugin has an Obsidian render mode [V G3] | v2026.9.4, 11 Sep 2026 [V P32] | "`memory_search` never blocks on indexing; results can be slightly stale" [V G2] | Strongest mainstream evidence that Markdown-canonical plus a derived index works, on a host Sid doesn't have |
| **Anthropic memory tool** | Wherever the app stores it | n/a | File-style commands: view, create, str_replace, insert, delete, rename. "You control where and how the data is stored" [V G5] | n/a | Official API feature | Path traversal and sensitive data are the app's responsibility [V G5] | A file-shaped memory API can sit on any backend, D1 or git included [E] |

### 3.2 Phone-reachable "Jarvis on Obsidian" projects

These READMEs were read on 2026-09-14. They are community projects [C]. Star counts and dates are [V P32] where shown.

| Project | Channel | Where the vault lives | How it reaches the phone | Memory design | Problems they name |
|---|---|---|---|---|---|
| Nymaxxx/obsidian-telegram-agent [G9] | Telegram, voice notes | Linux VPS (Docker) | Obsidian Headless plus Obsidian Sync; "everything you capture … shows up in Obsidian within seconds" | Claude Code with shell access to the vault | Needs a VPS and a Sync subscription |
| EmanueleMeazzo/LazyLogger [G10] | Telegram | Docker host | `ob sync --continuous` container plus agent container | Daily note memory entries, link notes | Needs a server and Sync |
| smixs/iva (now iva-agent; 211★, v0.4.3, 14 Sep 2026) [G11] | Telegram | "Your server" | Private git repo | Verbatim daily logs → day, week, month and year summaries → `CORE.md` (≤1,200 characters) plus typed cards | Prompt-injection sanitizer does not screen every input type (it says so itself) |
| komrxn/Mnemo [G12] | Telegram | Own machine (Docker) | Git sync, then Obsidian Git on devices | "`90_Transcripts/*.md` is the literal immutable log … the typed graph is a derived projection" | "Vault git-sync with conflict alerts to Telegram (no auto-resolve)" |
| Olduck1067/agent-second-brain [G13] | Telegram voice | "$5 VPS", systemd | GitHub push | Ebbinghaus-style memory tiers, MOC notes | Needs a VPS |
| mishablank/Engram [G14] | Telegram | Laptop, home server, or cloud volume | Obsidian Sync, Syncthing or rclone mirror from the cloud volume | "The vault is git-snapshotted before every rewrite" | Cloud copy must be mirrored |
| evannagle/ludolph [G15] | Telegram | "Vault stays on your Mac" | Raspberry Pi thin client; "if your Mac is asleep, the Pi wakes it" | MCP tools on the Mac | Mac must be wakeable |
| pdoteter/obsidian-ai-agent [G17] | Telegram | Docker host | "Synchronizes the vault using Git with automated conflict resolution" | Daily notes | Needs a server |
| rsprudencio/jarvis [G8] | Claude Code or Codex | PC | Git audit trail | Vault documents plus PostgreSQL/pgvector memories with decay | PC-bound |

### 3.3 What the evidence says

1. **Markdown notes in a folder tree, with index or map notes, are the dominant memory shape** for personal agents in 2026 [V G1, G2; C G6, G11–G13].
2. **Every working PC-off setup has an always-on machine that holds the vault** (VPS, Pi plus Mac, Docker host) and syncs it with Obsidian Sync headless or git [C G9–G15].
3. **Serious builds keep an immutable raw log apart from curated notes**: Karpathy's `raw/`, Mnemo's transcripts, Iva's verbatim daily logs, OpenClaw's dated files [V G1, G2; C G11, G12]. Jarvis already has this in D1 and R2 [R].
4. **They add a search index beside the files**: SQLite FTS and vectors, QMD, pgvector [V G2, P8; C G8]. Karpathy's index-note method works to "hundreds of pages" [V G1]. Sid's full-history recall of calls and chats is far beyond that [E].
5. **Git is the usual history and undo** [V G1; C G11, G12, G14].
6. **Reported weak spots**: sync conflicts (Mnemo does not auto-resolve), needing a host, and prompt injection from captured content (Iva's sanitizer) [C G11, G12]. Enforced guess flags, verifiable receipts and owner-gated forgetting appear in none of the READMEs I read [U, based on those READMEs].
---

## 4. Making a vault reachable with every PC off (question 2)

### 4.1 Reachability table

| Route | How it works | Conflicts when Sid and Jarvis edit together | iOS reliability | Encryption and privacy | Cost | How a Cloudflare Worker reads and writes | Verdict |
|---|---|---|---|---|---|---|---|
| **(a) Remotely Save → R2** | Plugin syncs the vault to S3-compatible storage, R2 included, free tier [V P15]. R2 setup: object read/write key, region `us-east-1`, "Bypass CORS" [V P16]. Object key = remote prefix + vault path. `MTime` is stored as object metadata; listing uses `LastModified` unless "accurate mtime" is on [V P18] | Free tier: keep newer or keep larger. PRO "Smart Conflict" merges small Markdown [V P15]. v3 also offers "keep both and rename" and "show warning" [V P17]. ETags are captured but not used to detect conflicts [V P18]. Result: a file-level winner, so one side's edit can be dropped silently [E] | "Auto sync only works when Obsidian is being opened … technically impossible to auto sync while Obsidian is in background" [V P15]. Users report unreliable iPhone autosync [C P21] | Optional E2EE in openssl or rclone-crypt format; the vault name is not encrypted [V P15]. With E2EE on, the Worker must implement rclone crypt [E] | $0 plugin. R2 $0.015/GB-month, 10 GB free [F] | Native R2 binding. `put` with `onlyIf.etagMatches` is compare-and-swap and "returns null" on failure; writes are strongly consistent [V C1]. Event notifications on create and delete go to a Queue [V C3]. **No bucket versioning** (`PutBucketVersioning` ❌) [V C2] | **Reject.** Last release 0.5.25 on 20 Oct 2024; last commit 10 Nov 2024 [V P32]. Open issue "Is this plugin Dead?" (27 Feb 2026) [V P19]. File-level conflict winner plus no versioning is unsafe for canonical memory |
| **(b) Git vault on a private GitHub repo** (recommended default) | Vault = repo. The Worker builds commits and moves `main` with `force` false: "make sure the update is a fast-forward"; failure returns 422 [V H2]. The single-file contents API needs the old blob SHA and "must use these endpoints serially" [V H1]. A push webhook carries added, modified and removed paths, up to 2,048 commits and 25 MB, signed with `X-Hub-Signature-256` [V H3] | Git merges non-overlapping edits. Same-line edits conflict. The phone resolves in GitSync's merge-conflict screen [V P27]. The Worker never force-pushes; on 422 it re-reads and re-renders [E]. Force pushes are blocked by default on protected branches [V H6]. Whether a private repo on a free personal account can use branch protection is unverified; it may need a paid GitHub plan [U] | **GitSync** (free; Premium $24.99 unlocks more repos; scheduled sync is a separate purchase) [V P29; F]. Its wiki recommends a Shortcuts automation "Obsidian Is Opened / Is Closed → Sync Now … Run Immediately" [V P28]. iOS supports App triggers and automations that "run without asking" [V A1, A2]. Obsidian Git plugin on mobile: "very unstable! I would not recommend" [V P26]. How GitSync opens Obsidian's iOS folder is unverified [U]. A different app, GitSync.md, documents cloning into "On My iPhone → Obsidian" [C P30] | GitHub stores plain text; a new third party holds the notes [E]. Tokens: GitHub App installation tokens "expire after 1 hour" and can be limited to one repo and chosen permissions [V H5] | $0 private repos [F H8]. REST limits 5,000/hour; content-creating 80/min and 500/hour [F H7]. Repo guidance: ≤10 GB on disk, ≤3,000 entries per directory [V H4]. GitSync $0 [V P29] | Plain HTTPS from the Worker, no container. Atomic multi-file commits through the Git database API. Tarball download for backups; private links expire after 5 minutes [V H1] | **Use.** The only route that works with PCs off in both directions with no Linux, no beta and no cost, and it includes full history. Weak spot: phone sync experience and occasional conflicts [U: frequency] |
| (b′) Git vault on **Cloudflare Artifacts** | Git-compatible storage with a Workers binding, REST API and Git protocol [V C7] | As (b) | As (b) | Stays inside Cloudflare [V C7] | Pricing not published [U] | Workers binding [V C7] | **Later.** "Currently in closed beta" [V C7] |
| **(c) Obsidian Sync + official headless client in a Cloudflare Container** | `ob` CLI, open beta, Node ≥22, needs a Sync plan. `ob sync --continuous`; modes bidirectional, pull-only, mirror-remote; `--conflict-strategy merge\|conflict`. "Do not use both the desktop app Sync and Headless Sync on the same device" [V O3, O4]. npm 0.0.14 (30 Jul 2026); licence "UNLICENSED" [V O6, P32] | Sync merges Markdown with diff-match-patch; other files are last-modified-wins. Since 1.9.7, "Create conflict file" is an option, set per device [V O7]. Daily notes auto-created on two devices can lose the local copy [V O7] | Best phone experience (official), but "sync does not work in the background"; it resumes when the app reopens [V O17; O18] | E2EE available; the container must hold the vault password [V O3; F] | Standard $4/month billed annually or $5 monthly: 1 GB, 1 vault, 1 month of history. Plus $8–10: 10 GB, 12 months [F O16]. Always-on `lite` container about $1.74–4.60/month [F] | A Worker cannot run the client (native `better-sqlite3`, a filesystem, long-running sync) [E from V O6]. Needs a Container, which is a Linux VM. "All disk is ephemeral"; persist state with FUSE-mounted R2 or Durable Object storage; snapshots "coming soon" [V C4, C5, C6]. Unattended sign-in: community images reuse `~/.config/obsidian-headless/auth_token` via `OBSIDIAN_AUTH_TOKEN` [C G18, G19; O19]. Keychain failure fixed in 0.0.3 [V O20]. Stale `.sync.lock` after a hard kill [V O21]. One user reports a fresh folder being treated as authoritative [C O21] | **Upgrade path, after a trial and Sid's OK on a Linux container** [R `CLAUDE.md`]. Beta, proprietary client, persistence work. VPS precedents exist [C G9, G10] |
| (c′) Headless client on the **Windows home PC** | Same client; prebuilt Windows binaries [V O3] | As (c) | As (c) | As (c) | $4–5/month | Worker ↔ PC through the existing signed sync routes [R] | **Fallback only.** No Linux, but the vault stops syncing overnight when the PC is off [R `CLAUDE.md`]. Acceptable only because memory itself stays in Cloudflare under plan C [E] |
| **(d) Self-hosted LiveSync** | CouchDB, Object Storage (S3, MinIO, R2) or WebRTC P2P [V P22]. Object Storage uses "Journal Sync": packed replication journals and chunks [V P25; C readme summaries] | "Automatically merges only when the available revision history supplies a safe shared base" [V P23] | "Keep replication active in the background" is desktop only [V P23] | E2EE recommended; path obfuscation optional [V P23] | Fly.io "no longer free"; IBM Cloudant suggested [V P22] | The Worker would have to reimplement LiveSync's chunk and journal protocol to read one note [E]. "LiveSync requires a CouchDB or WebRTC P2P remote server" for live sync [V P23] | **Reject.** CouchDB or Cloudant is a server or service (no-server constraint). The R2 journal is not readable notes. P2P needs a peer online. Very actively maintained (1.0.28, 9 Sep 2026) [V P32] |
| **(e) iCloud Drive** | Obsidian recommends iCloud for iOS and macOS [V O2] | File-level; details unverified [U] | Syncs outside the app [C O18] | Apple account | Apple storage plan | No official server API. Only unofficial web-API wrappers such as pyicloud with a 2FA-trusted session [V P31]. "iCloud Drive on Windows may lead to file duplication or corruption" [V O2] | **Reject.** No supported way for a cloud Jarvis to write, and the PCs are Windows |

### 4.2 Why git wins as the default transport, and what would change it

- **Fits every constraint.** It is the only route that satisfies Sid's constraints without a container, a beta client or a subscription. Jarvis's side uses stable, documented HTTP APIs with compare-and-swap semantics [V H2], signed change notifications [V H3] and scoped short-lived tokens [V H5].
- **Built-in history.** Every change by Sid or Jarvis is kept, and branch protection stops history rewrites [V H6], if Sid's GitHub plan allows it on a private repo [U]. That is a free undo and audit trail.
- **Switch to (c), Obsidian Sync, if either happens:**
  1. The one-week phone trial (milestone M0) shows GitSync is fiddly, meaning missed syncs or conflict screens Sid dislikes.
  2. Sid does not want GitHub holding a plain-text copy.
  - Plan C makes the switch cheap: only the transport adapter changes, because the ledger and index do not depend on it [E].
---

## 5. Hybrid design sketch (question 3)

This section designs plan C. It also answers each question-3 item for plan B, where B differs.

### 5.1 Layers and who owns what

| Layer | Where | Authoritative for | Written by |
|---|---|---|---|
| L0 Raw record | D1 `events`, then R2 archive (exists) [R] | What was said and heard, every Telegram turn and call | Gateway ingress (exists) |
| L1 Memory ledger | D1, new tables (§7.3) | Each memory item's ID, status, version history, receipts and sensitivity; the topic tree and its move history; every change's actor and channel | Distiller, owner commands, vault reconciler |
| L2 Vault | Private git repo → Obsidian on the iPhone and PCs | Wording and placement as Sid last left them; Sid's own notes; the folder tree | Jarvis renderer (its sections only) and Sid (anything) |
| L3 Index | D1 FTS5 + Vectorize | Nothing; fully rebuildable | Indexer |

**One conflict rule.**

1. An owner action, whether a vault edit or a Telegram command, is recorded in the ledger. It wins over anything Jarvis wrote before it.
2. Jarvis renders notes only after ingesting every commit up to the current `main` head, under a single-flight lease.
3. Model output never overrides an owner action.
4. Telegram and voice read L3, then re-check L1 state for every hit, so a forget takes effect at once [E, same as R research §4.3].

### 5.2 Vault layout: the topic tree as folders and links

```
Jarvis Memory/                  its own vault (separate from any personal vault)
  Home.md                       map of all areas; Jarvis-maintained index note
  Areas/
    St. Remy/
      St. Remy.md               area note: summary, sub-areas, key facts
      Website/
        Website.md              topic note
      PC App/
        PC App.md
    Health/ …
  People/
    Mom.md
  Jarvis Daily/2026/2026-09-14.md   what happened today, links to what was learned
  Inbox/                        Sid's quick notes; Jarvis files them within a day
  Guesses.md                    live list of every unconfirmed guess
  _Jarvis/README.md             how this vault works (display only, never instructions)
```

- **Folders are areas and sub-areas** (Sid's example: St. Remy → Website, PC App → deeper) [R AGENT_LOG `d31153e`].
- **A note with the same name as its folder is that topic's page.** This matches the community's "index discipline" [C G6] and Karpathy's `index.md` [V G1].
- **People and cross-area relations are `[[links]]`**, so Obsidian's backlinks and graph show them [V G1].
- **Keep the tree shallow and wide.** GitHub guidance allows up to 3,000 entries per directory and depth 50 [V H4].
- **Daily files go under `Jarvis Daily/`**, not the core Daily Notes path. Obsidian warns that notes auto-created on two devices can lose one side [V O7].
- **`Guesses.md` can be a live embedded search**, a `query` code block using `line:` [V O15]. Jarvis never has to rewrite it.

### 5.3 Note format and metadata

```markdown
---
jarvis_kind: topic
jarvis_id: t-01J9ZQ3K8M
aliases: []
updated: 2026-09-14
---
# Website

> [!summary] Jarvis's summary
> The St. Remy shop site. Moving off Shopify is the current big job.

## Facts
- Sid wants to leave Shopify before December. ^m-01J9ZQ4A7X
- Sid wants dark mode on the admin pages. ^m-01J9ZQ4B2K

## Guesses
- ❓ Sid may be redesigning the checkout page. ^m-01J9ZQ4C9P

> [!quote]- Where these came from
> - ^m-01J9ZQ4A7X · Telegram, 3 Sep 2026: "leaving shopify before xmas"
> - ^m-01J9ZQ4C9P · phone call, 12 Sep 2026 · Jarvis's guess

## Related
- [[St. Remy]] · [[PC App]]

## My notes
Sid's own writing. Jarvis reads it and never changes it.
```

**Format rules**

- **One memory = one list item ending in a block ID.** IDs "can only consist of Latin letters, numbers, and dashes" and can sit "directly on a bullet point". Links look like `[[Website#^m-01J9ZQ4A7X]]` [V O11].
- **Flat frontmatter only.** Nested properties are not supported in the Properties UI. Links inside properties must be quoted [V O9].
- **The sources box is a foldable callout.** `[!quote]-` "collapses it" by default [V O14].
- **Frontmatter and block IDs are display metadata, never authority.** Forged IDs bind to nothing. This carries over the approved design's rule [R design §6].
- **Sensitive memories can render as a placeholder** ("private, ask Jarvis") if Sid prefers. Health, money and other people are the obvious cases, since the repo is not end-to-end encrypted [E].
- **Plan B difference:** B would need the sources and state inline in the note, for example in hidden comments, because the vault would be the only store. That is exactly what makes them editable [E].

**Ledger fields per memory item** [E], adapting R research §4.2:

| Field | Values or notes |
|---|---|
| `item_id` | The block ID |
| `topic_id` | The topic the item is filed under |
| `version` | Plus `text` and `text_hash` per version |
| `state` | fact, guess, retracted, superseded, expired |
| `basis` | stated, observed, inferred, owner_edited |
| `origin` | authenticated_first_person, deterministic_observation, model, third_party, owner_vault_edit |
| `sensitivity_class` | Sensitivity class of the item |
| `sources[]` | Event ID, verified excerpt, channel, time |
| `valid_to` | Expiry date, if any |
| `rendered_commit_sha` | Commit the item was last rendered in |
| `last_owner_action` | The most recent owner change |

### 5.4 How Jarvis writes new memories

1. The **hourly distillation Workflow**, or `/remember` immediately, writes ledger rows first. Origin and state are decided in code, never by the model; a model inference stays a guess [R research §4.4 step 6].
2. **Filing.** The model proposes a topic path from `Home.md` and the area list (index-first, as in the LLM Wiki pattern [V G1]). Code validates it and caps new areas per run.
3. **Outbox.** A render-queue row is added for each affected note.
4. **Vault Workflow, under a single-flight lease:**
   - (a) Ingest commits between the last processed SHA and `main` (§5.5).
   - (b) For each note, fetch the head version. Replace only Jarvis's sections (summary, Facts, Guesses, sources box, Related). Keep everything else byte for byte.
   - (c) Create one tree and one commit authored as `jarvis-bot`.
   - (d) Update `refs/heads/main` without force [V H2].
   - (e) On 422, go back to (a), up to three times, then report the failure (never silently) [R `docs/ARCHITECTURE.md` rule 1].
5. **Record the commit SHA** against each rendered item version, and append to `Jarvis Daily/…`.
6. **Batching** keeps within GitHub's content-creation limits: at most one commit per run, plus `/remember` debounced to about one minute [F H7; E].

### 5.5 How Sid's edits flow back into the ledger and index

1. GitSync on the phone, or Obsidian Git on a PC, pushes. The GitHub push webhook reaches the Worker, which checks `X-Hub-Signature-256` [V H3]. The event is queued, and the reconcile Workflow runs.
2. For each changed `.md` path (`added`, `modified`, `removed` [V H3]): fetch the blob, then **run the gateway redactor before anything else is stored, indexed, embedded, logged or prompted.** This closes the "no redactor" gap by construction [R `KNOWN_ISSUES.md`].
3. Memory lines, matched by block ID:

   | Sid does this | Ledger records |
   |---|---|
   | Changes the text | New version, `basis owner_edited`, state fact |
   | Deletes the line | Retracted (reason `owner_deleted_in_vault`) |
   | Moves it to Facts, or removes the ❓ | Confirmed |
   | Moves it into another note | Re-filed |
   | Adds a new bullet with no ID under Facts or Guesses | New owner-stated item; the ID is added at the next render |

4. **Notes and folders.** Created, renamed or moved notes and folders update `topics` (the `jarvis_id` survives renames) and append to topic history. Detecting renames from the API's file lists is a trial item [U].
5. **Sid's own prose** ("My notes", Inbox, notes without Jarvis sections) is indexed as `owner_note` sources and cited as "from your notes".
   - It is never auto-promoted into profile facts that drive proactive behaviour.
   - Note text never authorises a tier-3 action [R `docs/ARCHITECTURE.md` rules 2 and 4].
6. **Guards** [E]:

   | Situation | Guard |
   |---|---|
   | A commit deletes more than N memory lines or M% of notes | Quarantined, not applied; Jarvis asks on Telegram |
   | Secret-looking text | Stays in Sid's file but is kept out of the index and prompts, as the approved design requires [R design §2] |
   | A commit by an unknown author | Treated as third-party content |

7. **Index.** FTS5 updates immediately. Vectorize changes become queryable at a median under 30 seconds and p99 under 2 minutes [V C9].
8. **Plan B difference.** B rebuilds state from the vault. Deleting a line simply removes the memory, a mass delete removes memory until someone reverts, and "who changed this" relies on git authorship alone [E].
### 5.6 Forget, provenance and "why do you think that?"

- **Forget.** `/forget <words>` on Telegram, or deleting the line in Obsidian, moves the item to `retracted`.
  - Retrieval hides it immediately because every hit is re-checked against D1 state.
  - Vectorize removal follows within the lag in §5.5 [V C9].
  - The next render removes the line.
  - Jarvis says honestly that the original message still exists in the conversation record and in git history.
  - True erasure is a later tier-3 design [R research §4.5]. Plan C adds one thing to that design: erasing from git needs a history rewrite, which branch protection deliberately blocks [V H6], and phone clones keep old objects until they re-clone [E]. Plan C does not make erasure easier; plan B would not either.
- **Provenance.** Every item version keeps its sources: event IDs, an excerpt verified against the stored event, channel, time, and the commit SHA for owner edits.
- **"Why do you think that?"** `/why` is a deterministic ledger lookup with no model [R research §4.5]. In Obsidian, the folded "Where these came from" box shows the same receipts. `obsidian://open?vault=…&file=…` can link to the note [V O12]. Whether Telegram opens that link on iOS is unverified [U].
- **Guesses.** Guesses sit in their own section with ❓ and have `state guess` in the ledger. The retriever labels them unconfirmed in every prompt and never presents them as fact [R research "Read this first" item 4]. Only an owner action promotes one: moving the line, removing the ❓, or tapping in Telegram.

### 5.7 Topic tree operations

- **Storage.** D1 `topics` (id, parent, title, current path, state) plus append-only `topic_events` (created, renamed, moved, merged; actor; commit SHA) [E].
- **"What do you know about St. Remy?"** Walk the subtree in D1 with no file reads, then pull the top items per topic from the index [E]. This is Sid's requirement [R AGENT_LOG `d31153e`].
- **Jarvis reorganising.** Jarvis may create, rename, move or merge topics it created that Sid has not edited; history is kept. For topics Sid created or edited, it proposes on Telegram. Sid's latest move always wins [E].
- **Search does not depend on filing.** A misfiled or unfiled item is still found by full-history search [R AGENT_LOG `d31153e`].
- **Lint pass**, nightly (the LLM Wiki's "lint" operation [V G1]): broken links, orphan notes, near-duplicate items and contradictions between facts. Findings go into the morning digest, never into silent rewrites of Sid's text [E].

### 5.8 What breaks, and the mitigation

| Failure | What happens | Mitigation |
|---|---|---|
| Sync lag | A phone edit reaches Jarvis only after GitSync pushes. With the automation, that is when Obsidian closes [V P28, A1]. Jarvis's notes reach the phone on the next open. iOS apps don't sync in the background [V O17] | Recall never waits for the vault. The ledger and index are current for everything Jarvis learned. Say "your latest phone edit may not be synced yet" when a note's last owner push is older than the question [E] |
| Concurrent edits | Jarvis's commit rejected (422) [V H2], or a conflict on the phone at pull [V P27] | Jarvis only rewrites its own sections and re-renders from head after ingesting. It never edits "My notes". It skips rendering a note Sid pushed in the last 10 minutes [E]. Conflict frequency is unverified [U] |
| File-level atomicity | On the phone, a commit captures whatever Obsidian last saved [E] | Harmless intermediate versions. Server-side commits are atomic across files and move `main` only by fast-forward [V H2] |
| Write storms | Sid reorganises hundreds of notes; or distillation touches many notes | Webhook payloads hold up to 2,048 commits and 25 MB [V H3]. Process through a Queue in batches; re-embed only changed hashes; one Jarvis commit per run [E]; GitHub content-creating limits 80/min and 500/hour [F H7] |
| Prompt injection from editable notes | Text in a note ("ignore previous instructions…"), or pasted email text, reaches the model. OWASP calls this indirect prompt injection from "external sources, such as websites or files" [V S1] | Notes are always quoted data, never instructions [R `docs/ARCHITECTURE.md` rule 2]. Owner prose never auto-promotes to profile facts. Tier 3 still needs a tap whatever the notes say [R rule 4]. `_Jarvis/README.md` is display-only; the real rules live in code [E] |
| Missing redactor | Today the local adapter stores note text verbatim [R `KNOWN_ISSUES.md`] | Cloud path: redact at the gateway before storage, index, prompt or logs. Refuse or quarantine what cannot be redacted [R design §2]. The Windows adapter stays unused for cloud memory [E] |
| Secrets typed into notes | GitHub receives them anyway, because GitSync pushes the whole vault [E] | Tell Sid. Offer a `Private/` folder in `.gitignore` that stays on the device. Offer placeholder rendering for sensitive classes [E] |
| Mass deletion by a sync glitch | Many lines vanish in one commit | Quarantine guard (§5.5). Git revert. Nightly tarball backup to a locked R2 bucket [V H1; F bucket locks] |
| Plugin supply chain | Community plugins can "access files", "connect to internet", "install additional programs"; they are not sandboxed [V O13] | No community plugins on the phone (GitSync is a separate app). Only Obsidian Git on the PCs, or a Task Scheduler git job with no plugin [E] |
| Headless client (if route c) | Beta breakage, stale lock, auth token handling [V O19, O21] | Trial first. Supervisor with stall detection, as a community spec does [C G19]. The ledger keeps memory safe during outages [E] |

### 5.9 Voice latency: index versus reading files

The gate is p95 first audible response ≤ 4,000 ms over 20 authenticated turns, and ≤ 8 s to the first model token [R foundation design §5.3; `docs/runbooks/voice-smoke.md:319`].

| Step per voice turn | Index path (C and B) | Reading vault files per turn |
|---|---|---|
| Keyword search | D1 FTS5. Community measurement for simple D1 reads from Workers: average 8.4 ms, p95 14.2 ms [C C10]. FTS5 on Jarvis's data is unmeasured [U] | No search without an index. The model would first have to read `Home.md` and area notes |
| Meaning search | Vectorize median about 30 ms per Cloudflare's 2024 redesign [V C8]; p95 on Jarvis's index unmeasured [U] | n/a |
| Query embedding | Workers AI call, latency unmeasured [U]; estimate 50–200 ms [E] | n/a |
| Fetching content | Snippets already in D1 | GitHub API per file, latency unmeasured [U]; estimate 100–500 ms each [E]. 5–10 files ≈ 1–3 s or more, plus rate limits of 5,000/hour [F H7]. Via a container: cold start adds seconds [U] |
| **Total retrieval** | **About 0.1–0.4 s** [E], leaving most of the 4 s for the model and speech | **1–3 s or more** [E]; likely breaks the gate |

**Conclusion:** voice and Telegram never read the vault directly. They read the index, and the vault feeds the index asynchronously. Measure the index path in the R2 build before switching meaning search on for calls, as the earlier plan already required [R research §4.3].
---

## 6. Head-to-head against Sid's requirements

- **(A)** Earlier plan: D1 is the source of truth, and Obsidian is an optional generated window added later [R research §2, §5].
- **(B)** Vault-canonical hybrid: Jarvis writes knowledge into notes first, and the index and receipts are rebuilt from the vault plus raw events.
- **(C)** Recommended: the vault is memory's shape and Sid's authoritative editing surface; the D1 ledger is the record of status and receipts.

B and C use the same transport, as described in section 4.

| Requirement | (A) Earlier plan | (B) Vault canonical | (C) Recommended |
|---|---|---|---|
| 1. Keep every conversation | Yes: D1 `events` plus R2 archive [R] | Yes, same raw log | Yes, same raw log |
| 2. Remember what matters automatically | Yes: hourly Workflow writes D1 [R research §4.4] | Yes, but a memory is only durable once the git or sync write succeeds; it needs an outbox, which is D1 in practice [E] | Yes: ledger first, note second. A sync outage delays the note, not the memory [E] |
| 3. Recall anything, full history | Yes, once events are indexed (added requirement) [R research "Read this first"] | Yes: same index plus notes | Yes: same index plus notes, including Sid's own writing |
| 4. Flag guesses as uncertain | **Strong**: database states and triggers [R research §4.2] | **Weak to medium**: a ❓ marker in text that any edit or merge can flip; enforced only by reconciler rules [E] | **Strong**: database state, shown in notes; only an owner action promotes a guess [E] |
| 5. Organised like a brain (tree) | **Weak for Sid**: the tree lives in D1 and Telegram until an optional window exists | **Strong**: the folders are the tree | **Strong**: the folders are the tree in both directions; moves keep history in D1 |
| 6. Every PC off, reachable from the iPhone | Yes for Telegram and calls; no Obsidian on the phone at first | Yes, given a PC-off transport (git or container) | Yes. Recall never depends on the transport; notes catch up |
| 7. Voice p95 ≤ 4 s | Yes: index [R foundation §5.3] | Yes: index; lags vault edits by seconds to minutes [V C9; E] | Same as B |
| 8. Minimal upkeep | Fewest parts, but fixing memory means Telegram taps; no browsing | Phone sync app, occasional conflicts; index-rebuild bugs are Jarvis's problem | Same phone sync as B; edits apply with no taps; more code, but for builders, not Sid |
| 9. Cost-aware, quality first | About $1–6/month model, about $0 infrastructure [F] | Plus $0 (git) or $4–5/month (Obsidian Sync) [F] | Same as B |
| "Why do you think that?" | Strong receipts in D1 | Receipts written in notes are editable, so a D1 mirror is still needed for trust [E] | Strong: ledger receipts, also shown in each note's folded sources box |
| "Forget that" | Retract in D1; erase designed later [R research §4.5] | Delete the line; it stays in git history | Delete the line or `/forget`; guarded against mass deletes; stays in git and D1 history until a later erase [E] |
| Portability and lock-in | Medium: custom D1 schema plus exports | **Best**: Markdown plus git | High: the vault holds a complete readable copy; receipts come from a ledger export |
| A sync bug deletes many notes | Unaffected (window only) | Memory is lost until someone reverts | Quarantined by the guard; the ledger is untouched; git revert restores [E] |
| Fit with repository rules (database enforces invariants; untrusted text is data) [R `docs/ARCHITECTURE.md`] | Best | Weakest | Good |
| Build effort [E] | About 4–6 builder sessions [R research §7] | About 7–10 | About 7–10 |

**Reading the table**

- C matches B wherever Sid feels the difference: the tree, editing, portability, the phone.
- C matches A wherever the guarantees live: guesses, receipts, forget, safety against sync bugs.
- B beats C only on simplicity of the conceptual model and on portability of receipts.
- **When B would be the better choice:** Sid says he prefers maximum simplicity and portability over enforced guess, forget and receipt guarantees. C can later be slimmed towards B by demoting the ledger to a derived cache [E].
---

## 7. Recommendation and what it means for the R2 build

### 7.1 Decision: choose (C), with reasons

1. **It meets all nine requirements.** It is the only option strong on both requirement 4 (guesses flagged) and requirement 5 (an organised tree Sid can browse and edit) (§6).
2. **It builds what the evidence shows works**: a Markdown tree, a separate raw log, a derived index and git history (§3.3). It does this on a fleet with no server and only Cloudflare always on [R `CLAUDE.md`].
3. **Memory's durability and guarantees don't depend on the weakest link**, which is phone sync (§4).
4. **Voice stays inside the 4 s gate**, because retrieval never reads files (§5.9).
5. **Most of the earlier cloud plan carries over unchanged**: distillation Workflow, origin rules decided in code, retrieval packing, cost cap, backups [R research §4].
6. **Sid always has a complete, readable copy in plain Markdown with history.** In the Obsidian CEO's words: "the files you create are more important than the tools you use to create them" [V O22].

**Confidence**

- High that memory should take the vault's shape, with Sid's edits authoritative.
- Medium-high on keeping a D1 ledger underneath.
- **Medium on the default transport:** git on the iPhone at Sid's scale is unverified [U]. That is why milestone M0 is a one-week phone trial before any Jarvis vault code.

### 7.2 What stays from the earlier plan

- Raw log in D1 plus R2.
- Cloud distillation Workflow with origin decided in code.
- `/remember`, `/why`, `/forget` (retract).
- Monthly model cost cap and run log.
- Hybrid FTS5 plus Vectorize retrieval inside the existing context budget.
- D1 Time Travel, nightly exports and restore drills.
- No Linux home node.
- The same model cost range [R research §4; F].

### 7.3 Data model changes

This is a proposal only. The reviewer's hold says not to lock in tables or migrations until a decision is posted [R AGENT_LOG `757fe01`].

| Earlier proposal [R research §4.2] | Change | Why |
|---|---|---|
| `memory_facts`: immutable; ID = hash of text and sources | `memory_items` with a stable ULID ID (= the note block ID), plus immutable `memory_item_versions` | Sid edits wording, and a content-hash ID would change on every edit |
| `memory_fact_transitions` (proposed → active → …) | `memory_item_transitions`. States: fact, guess, retracted, superseded, expired. Actors: rules, owner_telegram, owner_vault. Plus the authorising event ID or commit SHA | Owner vault edits are authorising actions |
| `memory_fact_sources` | `memory_item_sources`, adding `source_kind = vault_note_version` | Notes become sources |
| `entities_json` tags ("graph-lite") | `topics`, append-only `topic_events`, `memory_item_placements`; people and relations as links | The topic tree becomes first-class [R AGENT_LOG `d31153e`] |
| (none) | `vault_notes`: opaque ID, `jarvis_id`, path, blob SHA, content hash, kind, owner class | Maps notes to items |
| (none) | `vault_commits` (SHA, author class, received, processed, outcome), `vault_render_outbox`, `vault_quarantine` | Two-way sync with receipts and guards |
| `memory_fact_fts`, `memory_episode_fts` | Add `vault_note_fts` (redacted note text) and `event_fts` over **all** conversation text, not just the 90 days kept live in D1 | "Recall anything", including Sid's notes [R research "Read this first"] |
| `memory_vectors` ledger | Add `item_kind = note_chunk` | Meaning search over notes |
| `memory_runs` | Add jobs `vault_render`, `vault_reconcile`, `lint` | "Silence and success must never look the same" [R `docs/ARCHITECTURE.md` rule 1] |

Keep the house conventions: append-only triggers, CHECK constraints, and run keys claimed before acting [R `docs/ARCHITECTURE.md` rules 3, 5]. Leave the existing 0014 projection tables untouched [R research §4.2]. Size check: full-history `event_fts` grows about 110 MB of text a year [R research §4.8, E] against D1's 10 GB per database [F].

### 7.4 Sync mechanism (default)

- **Repository.** One private GitHub repo holds the Jarvis vault. Branch protection on `main`, where force pushes are blocked by default [V H6].
  - Branch protection on a private repo owned by a personal account may need a paid GitHub plan [U].
  - Without it, Jarvis still never force-pushes, and the nightly backups keep history [E].
- **Jarvis's identity.** A GitHub App installed on that single repo with contents read/write and a push webhook. The Worker mints installation tokens that "expire after 1 hour", scoped to the repo and permissions [V H5]. The App key and webhook secret are Worker secrets.
- **Inbound.** Push webhook → Worker checks `X-Hub-Signature-256` [V H3] → Queue → reconcile Workflow (§5.5).
- **Outbound.** Render Workflow commits through the Git database API and moves `main` by fast-forward only (§5.4) [V H2].
- **iPhone.** Obsidian plus GitSync (free), signed in to GitHub. GitSync supports "HTTP/S, SSH, and OAuth" [V P29].
  - Two Shortcuts automations: "Obsidian Is Opened → Sync Now" and "Obsidian Is Closed → Sync Now", both set to run immediately [V P28, A1, A2].
- **PCs.** Obsidian desktop with the Obsidian Git plugin [V P26]. Or, without a plugin, Git for Windows run by Task Scheduler [E].
- **Backups.** Nightly repo tarball [V H1] to a locked R2 bucket [F], plus the natural copies on each PC.
- **Upgrade route (c).** A Cloudflare Container runs `ob sync` with state kept in Durable Object storage or FUSE-mounted R2 [V C4–C6]. Only after Sid agrees to a Linux container and a trial passes.

### 7.5 First milestones

Every production step needs owner approval, max-effort review, a Time Travel bookmark and a written rollback [R research §7; `docs/BUILDING.md`].

| # | Milestone | Exit check |
|---|---|---|
| M0 | **Phone trial, no Jarvis code (one week).** A private repo with about 30 sample notes in the §5.2 layout. GitSync and both automations on the iPhone; Obsidian Git on one PC. A builder edits notes through GitHub's web editor to imitate Jarvis | No lost edit; conflicts rare and understandable; Sid is happy. Otherwise trial route (c) |
| M1 | **Ledger core.** Earlier plan steps 1–6, adapted: versioned memory items, topics, `/remember` `/why` `/forget`, distillation behind a flag, cost cap | With every PC off, Telegram memory works |
| M2 | **One-way render.** GitHub App, render Workflow, Home, area, topic and daily notes, guesses, sources box, branch protection, nightly tarball backup | With PCs off, tell Jarvis something; it appears in the right note on the iPhone after opening Obsidian |
| M3 | **Two-way reconcile.** Webhook, redactor, block-ID diffing, owner edits, deletes and moves, quarantine guard, notes indexed | Edit and delete a memory line on the iPhone with PCs off; Jarvis's next answer follows; `/why` says Sid edited it |
| M4 | **Full recall and voice.** `event_fts` over full history, note vectors, hybrid packing, live latency measurement | Voice sample passes p95 ≤ 4 s with memory retrieval on [R foundation §5.3] |
| M5 | **Tree upkeep.** Automatic filing, Inbox filing, merges with history, nightly lint in the digest | "What do you know about St. Remy?" walks the tree correctly |
| M6 | **Optional:** route (c) Obsidian Sync trial | Unattended sync survives restarts for a week |

Effort for M1–M5 is about 7–10 builder sessions [E], against 4–6 for the earlier plan's steps 1–10 [R research §7].

### 7.6 Proposed R2 exit test (every PC off)

1. Tell Jarvis a new fact on Telegram. Within one cycle it is a line in the right topic note on the iPhone.
2. Ask about it on a phone call. The answer comes within the voice gate.
3. `/why` shows the receipt, and the note's sources box shows the same.
4. Change the wording on the iPhone. Jarvis uses the new wording next time, and `/why` says Sid edited it.
5. Delete the line. Jarvis no longer recalls it and says the original message still exists.
6. Write a note in `Inbox/` on the iPhone. Jarvis can find it at once and files it into the tree within a day.

This restores the roadmap's Obsidian exit items without the Linux node [R roadmap R2 Exit].

### 7.7 Costs (monthly, on top of Workers Paid)

| Item | Default (git) | With the Obsidian Sync upgrade |
|---|---|---|
| Distillation model (DeepSeek; calls spread across the week) | About $1.04 (Flash) to $3.80 (V4 Pro) [F] | Same |
| D1, Workflows, Queues, Workers AI embeddings | Within included amounts [F] | Same |
| Vectorize | About $0.01 in year one, about $0.60 by year five [F]; notes add a little [E] | Same |
| GitHub private repo and App | $0 [F H8]; branch protection on a private repo may need a paid plan [U] | $0 if kept as backup |
| GitSync | $0; Premium $24.99 one-time only for more repos [V P29] | Not needed |
| Obsidian app | $0 [V O1] | $0 |
| Obsidian Sync | n/a | $4 (annual) or $5 monthly Standard; Plus $8–10 for 12 months of history [F] |
| Container | n/a | About $1.74–4.60 if always on (`lite`) [F]; less if scheduled [E] |
| **Total** | **About $1–5** | **About $7–15** |

### 7.8 Decisions to put to Sid (short)

1. **Should memory be Obsidian notes you can edit directly, with Jarvis keeping receipts behind them?** Suggested: yes.
2. **Phone sync: the free GitSync app, or Obsidian's own sync ($4–5 a month)?** Obsidian's sync needs a small Linux helper that Jarvis runs inside Cloudflare, and it is still in beta. Suggested: try the free app for a week first.
3. **Is it OK for GitHub to hold a private copy of the notes?** And should health, money and other people's details show in notes, or stay "ask Jarvis"? Suggested: yes, and keep those three private.

### 7.9 Documents that would change after Sid decides (not changed here)

- **`DECISIONS.md`:** amend the 3 Sep "Memory and Obsidian" bullet (the Worker commits, not a home node; GitSync on the iPhone; edits authoritative) and record Sid's picks.
- **Roadmap:** §5.4, R2 items 1, 2, 4 and 5, the R2 exit test, and §8 costs.
- **`docs/superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md` §2:** it rejects "Git repository, or Git worktree roots", defers "mobile vault synchronization" and says "Jarvis never cloud-syncs the vault directory itself" [R]. That contradicts the 3 Sep decision and would be superseded for the cloud vault. The Windows stage-one adapter code stays in place, unused by the cloud path.
- **`KNOWN_ISSUES.md`:** note that the cloud path does not use the local vault adapter.
- **`docs/research/2026-09-14-jarvis-memory-research.md`:** the "No Obsidian for now" pick and §5.
- **`docs/AGENT_LOG.md`:** the reviewer decision lifting the storage hold [R `757fe01`].
---

## 8. Risks (question 4)

### 8.1 Maintenance and supply chain

Releases, pushes, licences and stars come from the GitHub API, queried 2026-09-14 [V P32], unless marked otherwise.

| Component | Role | Latest release | Last push | Licence | Stars | Signal |
|---|---|---|---|---|---|---|
| Obsidian app | Viewer and editor on the iPhone and PCs | n/a | n/a | Proprietary terms; free for all uses [V O1] | n/a | Plugins cannot be sandboxed [V O13] |
| GitSync (ViscousPot) | iPhone transport (default) | v1.8.65, 11 Sep 2026 | 11 Sep 2026 | GPL-3.0 | 2,322 | Small vendor; App Store 4.3★ from 25 ratings [V P29] |
| Obsidian Git | PC transport | 2.39.0, 12 Aug 2026 | 8 Sep 2026 | MIT | 11,971 | Active; mobile "very unstable" [V P26] |
| GitHub and GitHub App | Vault host | Service | n/a | n/a | n/a | Mature; a new third party holding plain text [E] |
| obsidian-headless | Upgrade route | 0.0.14, 30 Jul 2026 | 30 Jul 2026 | "UNLICENSED" [V O6] | 229 | Open beta; "Expect more breaking changes" [V O19] |
| Cloudflare Containers | Upgrade route | Service | n/a | n/a | n/a | Disk ephemeral; snapshots "coming soon" [V C4] |
| Cloudflare Artifacts | Possible future host | Closed beta | n/a | n/a | n/a | Pricing unpublished [V C7] |
| Remotely Save | Rejected | 0.5.25, 20 Oct 2024 | 10 Nov 2024 | NOASSERTION | 8,089 | "Is this plugin Dead?" is open [V P19]; maintainer busy (Sep 2025) [V P20] |
| Self-hosted LiveSync | Rejected | 1.0.28, 9 Sep 2026 | 9 Sep 2026 | MIT | 12,318 | Very active; needs a server or uses a journal format |
| Local REST API | Not used | 5.1.0, 1 Aug 2026 | 31 Aug 2026 | MIT | 2,919 | Desktop-bound |
| obsidian-mcp-tools | Not used | 0.2.33, 13 May 2026 | Archived | MIT | 833 | Archived [V P4] |
| Basic Memory | Not used (format ideas) | v0.23.2, 25 Aug 2026 | 14 Sep 2026 | AGPL-3.0 | 3,952 | Active |
| Smart Connections | Not used | 4.7.2, 6 Aug 2026 | 13 Sep 2026 | Source-available | 5,451 | 491 open issues |
| Copilot for Obsidian | Not used | 4.0.8, 12 Sep 2026 | 14 Sep 2026 | AGPL-3.0 | 7,710 | Active |
| Khoj | Not used | 2.0.0-beta.28, 26 Mar 2026 | 2 Aug 2026 | AGPL-3.0 | 37,321 | Cloud shut down 15 Apr 2026 [V P13] |

**Supply-chain notes**

- **Plugin exposure is small.** The default plan runs no community plugin on the iPhone and one (Obsidian Git) on the PCs. A plain scheduled git task can replace it [E].
- **Obsidian's scanning is not a sandbox.** Obsidian "automatically scans every plugin version" but "cannot reliably restrict plugins to specific permissions" [V O13].
- **Jarvis never executes anything from the vault** [R `docs/ARCHITECTURE.md` rule 2].

### 8.2 Licences

- **Obsidian:** "Obsidian is free for all purposes, including personal, commercial, and non-profit use". Commercial licences are optional; the terms were last updated 20 Feb 2025. Obsidian reserves rights to "code in the app", so the app is proprietary while the notes are plain Markdown [V O1].
- **obsidian-headless:** licence field "UNLICENSED", so it is not open source [V O6].
- **GitSync (GPL-3.0) and Obsidian Git (MIT):** used unmodified as separate apps, they create no obligations for Jarvis [E].
- **AGPL tools (Basic Memory, Copilot, Khoj):** not used. Copying their code into Jarvis would bring AGPL network terms [E].

### 8.3 Lock-in

| Piece | Lock-in | Exit |
|---|---|---|
| Vault (Markdown in git) | Very low | Any editor, any git host. "Apps are ephemeral, but your files have a chance to last" [V O22] |
| Obsidian syntax (block IDs, callouts, embedded queries) | Low | Degrades to readable text in other editors [E] |
| GitHub | Low | `git clone` to any host; Cloudflare Artifacts later [V C7] |
| GitSync | Low | Another git client, for example Working Copy (pushing needs Pro, $35.99) [F] |
| Obsidian Sync (if chosen) | Low to medium | Files stay on devices; the protocol and client are proprietary [V O6] |
| D1 ledger and index | Medium | Custom schema plus nightly exports; the vault already holds every active memory in readable form [E] |

### 8.4 Data-loss scenarios

| Scenario | Impact under C | Protection |
|---|---|---|
| A phone app or sync glitch deletes or blanks many notes | Would retract memories if applied | Quarantine guard; git history; tarball backups [E; V H1] |
| History rewritten or force-pushed | Lost history | Force pushes blocked by default on protected branches [V H6]. Availability for a private personal repo is unverified [U]. Nightly tarball backups and PC clones [E] |
| A conflict resolved wrongly on the phone | A wording change lost or duplicated | Every version is in git and the ledger; `/why` shows the change; lint flags duplicates [E] |
| GitHub account locked or repo deleted | Phone vault stops syncing | Ledger unaffected; re-render into a new repo; tarball backups; PC clones [E] |
| D1 damaged or a bad migration | Ledger and index damaged | Time Travel restores any minute in the last 30 days; nightly exports to locked R2 [F]; partial rebuild from vault plus events [E] |
| Vectorize lag or loss | Stale or missing meaning-search hits | D1 state check on every hit; rebuild from D1 [R research §2.5] |
| Route (c): a fresh container folder treated as authoritative | Remote deletions | Persist sync state; first run pull-only; Sync version history of 1 or 12 months [C O21; V O3; F] |
| Route (a), rejected: file-level overwrite with no R2 versioning | Silent loss of one side's edit | Not used [V P15, C2] |
| Secrets typed into a note | Exposure beyond Cloudflare | A private folder kept out of git with `.gitignore`; warn Sid; placeholder rendering for sensitive classes [E] |

### 8.5 Constraints from `CLAUDE.md`

- **Default path:** adds no Linux host and neither ports nor uses `jarvis node`. The Linux-node hold is untouched [R `CLAUDE.md`].
- **Route (c)** runs in a Linux container. Per `CLAUDE.md`, raise it with Sid before planning or building. It must never become a runbook he runs.
- **Attribution.** The 3 Sep "git-backed vault" line is recorded as Sid's decision [R `DECISIONS.md`], which is evidence, not proof. Sid has now confirmed that he wants Obsidian [R AGENT_LOG `757fe01`], but not git in particular. So the transport choice goes back to him (§7.8).

### 8.6 Corrections to the earlier research

1. **Vectorize lag is longer than the report said.** It said new vectors are queryable after "a few seconds" [R research §2.2]. Cloudflare's 30 Jun 2026 changelog puts the median under 30 seconds and p99 under 2 minutes, improved from 2 and 5 minutes [V C9]. Design impact:
   - None for `/forget`, which relies on the D1 state check.
   - "Tell it, then ask straight away" must be answered by the FTS5 keyword path.
2. **The roadmap's R2 exit test already included Obsidian on the phone** [R roadmap]. The earlier report made Obsidian optional and took it out of the exit test.
3. **Route A (headless client in a container) left out several things:** the `CLAUDE.md` Linux flag, the beta "breaking changes" warning, auth-token file handling, stale locks, and the risk of losing sync state between runs [V O19–O21; C G18, G19].
4. **Route B (git) is more automatic than described.** GitSync's documented open and close automations for Obsidian mean Sid does not need to tap sync by hand [V P28, A1, A2]. The fact-check had already corrected its cost to $0 [F].
5. **Not covered before, now verified:**
   - Remotely Save has had no commit since 10 Nov 2024 [V P32].
   - LiveSync's object-storage mode stores replication journals, not notes [V P25].
   - Khoj Cloud shut down on 15 Apr 2026 [V P13].
   - Cloudflare Artifacts exists but is in closed beta [V C7].
   - R2 has no object versioning [V C2].
6. **An internal contradiction was never resolved.** The approved Obsidian design spec forbids git-repository and cloud-synced vault roots and defers mobile sync [R design §2]. The 3 Sep decision chose a git-backed vault synced to every device [R `DECISIONS.md`]. Neither the earlier report nor the roadmap reconciled the two.

### 8.7 Unverified, or needs a trial

- **GitSync on iOS:** how it gains access to Obsidian's folder, how reliable the open and close automations are, and how often conflicts happen with Jarvis's commits.
- **Scale:** iPhone and Obsidian performance with thousands of notes and years of git history.
- **GitHub from Workers:** API latency, and detecting renames from push payloads.
- **Retrieval latency on real data:** FTS5 and Vectorize p95 on Jarvis's data, and Workers AI embedding latency during a call.
- **obsidian-headless unattended in a Cloudflare Container:** restoring the token, the end-to-end encryption key, persisting state, and actual conflict-strategy behaviour.
- **Basic Memory Cloud:** how it syncs to a phone vault.
- **Telegram on iOS:** whether it opens `obsidian://` links.
- **Cloudflare Artifacts:** pricing and general-availability date.
- **GitHub plan:** whether branch protection works on a private repo owned by a free personal account.
- **Absence claim:** I found no Jarvis-on-Obsidian project running on serverless compute without a filesystem. A wider search could find one.
---

## 9. Sources

All fetched or queried on 2026-09-14. Community sources [C] are labelled as such.

### Obsidian (official)

| # | Source |
|---|---|
| O1 | [Obsidian license](https://obsidian.md/license) |
| O2 | [Sync your notes across devices](https://obsidian.md/help/sync-notes) |
| O3 | [Headless Sync](https://obsidian.md/help/sync/headless) |
| O4 | [Obsidian Headless](https://obsidian.md/help/headless) |
| O5 | [obsidian-headless README](https://github.com/obsidianmd/obsidian-headless) |
| O6 | [obsidian-headless npm metadata (0.0.14, UNLICENSED)](https://registry.npmjs.org/obsidian-headless/latest) |
| O7 | [Troubleshoot Obsidian Sync (conflict resolution)](https://obsidian.md/help/sync/troubleshoot) |
| O8 | [Obsidian CLI](https://obsidian.md/help/cli) |
| O9 | [Properties](https://obsidian.md/help/properties) |
| O10 | [Bases](https://obsidian.md/help/bases) |
| O11 | [Internal links (block identifiers)](https://obsidian.md/help/links) |
| O12 | [Obsidian URI](https://obsidian.md/help/uri) |
| O13 | [Plugin security](https://obsidian.md/help/plugin-security) |
| O14 | [Callouts](https://obsidian.md/help/callouts) |
| O15 | [Search (embedded queries, operators)](https://obsidian.md/help/plugins/search) |
| O16 | [Obsidian Sync](https://obsidian.md/sync) and [Sync plans](https://obsidian.md/help/sync/plans); prices verified in the fact-check [F] |
| O17 | [Forum: "Sync not pushing full update" (sync does not work in the background)](https://forum.obsidian.md/t/sync-not-pushing-full-update/96274) |
| O18 | [Forum: "Make Obsidian Sync work in background (on Mobile)"](https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906) |
| O19 | [Forum: Headless Sync auth token; moderator "Expect more breaking changes"](https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740) |
| O20 | [Forum: `ob sync-setup` keychain failure, fixed in 0.0.3](https://forum.obsidian.md/t/ob-sync-setup-fails-on-headless-linux-keychain-unavailable/111679) |
| O21 | [obsidian-headless issue #4: stale `.sync.lock`](https://github.com/obsidianmd/obsidian-headless/issues/4) |
| O22 | [Steph Ango (Obsidian CEO), "File over app"](https://stephango.com/file-over-app) |
| O23 | [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) |

### Plugins, apps and tools

| # | Source |
|---|---|
| P1 | [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) |
| P2 | [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) |
| P3 | [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) |
| P4 | [jacksteamdev/obsidian-mcp-tools (archived)](https://github.com/jacksteamdev/obsidian-mcp-tools) |
| P5 | [istrejo/obsidian-mcp](https://github.com/istrejo/obsidian-mcp) |
| P6 | [ykoellmann/obsidian-mcp README](https://github.com/ykoellmann/obsidian-mcp/blob/main/README.md) |
| P7 | [eddmann/obsidian-mcp (git-backed, Lambda)](https://github.com/eddmann/obsidian-mcp) |
| P8 | [Basic Memory README](https://github.com/basicmachines-co/basic-memory) |
| P9 | [Basic Memory Cloud quickstart](https://docs.basicmemory.com/start-here/quickstart-cloud) |
| P10 | [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) |
| P11 | [Copilot for Obsidian](https://github.com/logancyang/obsidian-copilot) |
| P12 | [Khoj Obsidian client docs](https://docs.khoj.dev/clients/obsidian/) |
| P13 | [Khoj Cloud sunset notice](https://app.khoj.dev/) |
| P14 | [Khoj Obsidian plugin settings source](https://github.com/khoj-ai/khoj/blob/9cbf620e/src/interface/obsidian/src/settings.ts) |
| P15 | [Remotely Save README](https://github.com/remotely-save/remotely-save) |
| P16 | [Remotely Save: Cloudflare R2 setup](https://github.com/remotely-save/remotely-save/blob/master/docs/remote_services/s3_cloudflare_r2/README.md) |
| P17 | [Remotely Save sync algorithm v3 intro](https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/intro.md) |
| P18 | [Remotely Save `src/fsS3.ts`](https://github.com/remotely-save/remotely-save/blob/master/src/fsS3.ts) |
| P19 | [Remotely Save issue #1151 "Is this plugin Dead?"](https://github.com/remotely-save/remotely-save/issues/1151) |
| P20 | [Remotely Save issue #1092 (maintainer comment, Sep 2025)](https://github.com/remotely-save/remotely-save/issues/1092) |
| P21 | [Remotely Save discussion #1068 (user report)](https://github.com/remotely-save/remotely-save/discussions/1068) [C] |
| P22 | [Self-hosted LiveSync README](https://github.com/vrtmrz/obsidian-livesync) |
| P23 | [LiveSync settings docs](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md) |
| P24 | [LiveSync Object Storage setup](https://github.com/vrtmrz/obsidian-livesync/blob/HEAD/docs/setup_object_storage.md) |
| P25 | [LiveSync 0.25 release notes (Journal Replicator)](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/releases/0.25.md) |
| P26 | [Obsidian Git plugin](https://github.com/Vinzent03/obsidian-git) |
| P27 | [GitSync repository](https://github.com/ViscousPot/GitSync) |
| P28 | [GitSync wiki: App Sync on iOS via Shortcuts](https://gitsync.viscouspotenti.al/wiki/sync-options/background/app-based) |
| P29 | [GitSync on the App Store](https://apps.apple.com/us/app/gitsync/id6744980427) |
| P30 | [GitSync.md blog: Obsidian Git on iOS (a different app)](https://gitsyncmd.isolated.tech/blog/obsidian-git-ios-setup) [C] |
| P31 | [pyicloud (unofficial iCloud web API)](https://github.com/picklepete/pyicloud) |
| P32 | GitHub REST API, `https://api.github.com/repos/{owner}/{repo}` and `/releases`, queried 2026-09-14 for every repository in §3 and §8.1 |

### Agents, memory patterns and community projects

| # | Source |
|---|---|
| G1 | [Andrej Karpathy, "LLM Wiki" gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) |
| G2 | [OpenClaw memory docs (repo copy)](https://github.com/openclaw/openclaw/blob/e321f21d/docs/concepts/memory.md) and [docs site](https://docs.openclaw.ai/concepts/memory) |
| G3 | [OpenClaw memory-wiki plugin](https://docs.openclaw.ai/plugins/memory-wiki) |
| G4 | [BetterClaw: OpenClaw + Obsidian](https://www.betterclaw.io/blog/openclaw-obsidian) [C] |
| G5 | [Anthropic memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) |
| G6 | [jaredrhod/ai-memory-vault](https://github.com/jaredrhod/ai-memory-vault) and [write-up](https://jaredrhod.substack.com/p/your-ai-will-never-forget-anything) [C] |
| G7 | [Chase AI: Claude Code + Obsidian](https://chaseai.io/blog/claude-code-obsidian-persistent-memory) [C] |
| G8 | [rsprudencio/jarvis](https://github.com/rsprudencio/jarvis) [C] |
| G9 | [Nymaxxx/obsidian-telegram-agent](https://github.com/Nymaxxx/obsidian-telegram-agent) [C] |
| G10 | [EmanueleMeazzo/LazyLogger](https://github.com/EmanueleMeazzo/LazyLogger) [C] |
| G11 | [smixs/iva (iva-agent)](https://github.com/smixs/iva) [C] |
| G12 | [komrxn/Mnemo](https://github.com/komrxn/Mnemo) [C] |
| G13 | [Olduck1067/agent-second-brain](https://github.com/Olduck1067/agent-second-brain) [C] |
| G14 | [mishablank/Engram](https://github.com/mishablank/Engram) [C] |
| G15 | [evannagle/ludolph](https://github.com/evannagle/ludolph) [C] |
| G16 | [erikschlegel/jarvis-vault](https://github.com/erikschlegel/jarvis-vault) [C] |
| G17 | [pdoteter/obsidian-ai-agent](https://github.com/pdoteter/obsidian-ai-agent) [C] |
| G18 | [Belphemur/obsidian-headless-sync-docker](https://github.com/Belphemur/obsidian-headless-sync-docker) [C] |
| G19 | [fx/ob Obsidian Sync supervisor spec](https://github.com/fx/ob/blob/main/docs/specs/obsidian-sync/index.md) [C] |
| G20 | [Medium: "People are building a Real JARVIS in Obsidian with Claude Code"](https://medium.com/tech-and-ai-guild/people-are-building-a-real-jarvis-in-obsidian-with-claude-code-heres-how-5a4ce86e461c) [C] |
| G21 | [dnc1994/jarvis](https://github.com/dnc1994/jarvis) [C] |

### Cloudflare

| # | Source |
|---|---|
| C1 | [R2 Workers API reference (`onlyIf`, consistency)](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) |
| C2 | [R2 S3 API compatibility (no bucket versioning)](https://developers.cloudflare.com/r2/api/s3/api/) |
| C3 | [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/) |
| C4 | [Containers FAQ (ephemeral disk)](https://developers.cloudflare.com/containers/faq/) |
| C5 | [Containers: mount R2 with FUSE](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/) |
| C6 | [Container class (Durable Object storage, `sleepAfter`)](https://developers.cloudflare.com/containers/container-class/) |
| C7 | [Artifacts announcement](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) and [Artifacts docs (closed beta)](https://developers.cloudflare.com/artifacts/) |
| C8 | [Cloudflare blog: Vectorize median query latency 30 ms](https://blog.cloudflare.com/workers-ai-bigger-better-faster/) |
| C9 | [Vectorize changelog 2026-06-30: vector-change latency](https://developers.cloudflare.com/changelog/post/2026-06-30-improved-wal-throughput/) |
| C10 | [Pickuma D1 benchmark](https://pickuma.com/for-dev/cloudflare-d1-serverless-database-review/) [C] |

### GitHub

| # | Source |
|---|---|
| H1 | [REST: repository contents (SHA for updates, serial use, tarball)](https://docs.github.com/en/rest/repos/contents) |
| H2 | [REST: Git references (fast-forward, 422)](https://docs.github.com/en/rest/git/refs) |
| H3 | [Webhook events: push payload and signatures](https://docs.github.com/en/webhooks/webhook-events-and-payloads) |
| H4 | [Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits) |
| H5 | [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) |
| H6 | [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| H7 | [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) [F] |
| H8 | [GitHub pricing](https://github.com/pricing) [F] |

### Apple and security

| # | Source |
|---|---|
| A1 | [Shortcuts: setting triggers (App: Is Opened, Is Closed)](https://support.apple.com/guide/shortcuts/setting-triggers-apde31e9638b/ios) |
| A2 | [Shortcuts: run a personal automation without asking](https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/ios) |
| S1 | [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) |

### Carried from the fact-check [F]

Values marked [F] are D1, Vectorize, Workers AI, Workflows, R2 and Containers prices and limits; Obsidian Sync prices and plans; GitHub rate limits; GitSync and Working Copy pricing; and DeepSeek costs. Each is confirmed, with its URL, in `docs/research/2026-09-14-jarvis-memory-research-factcheck.md` on `origin/claude/r2-memory-research`.

### Repository files read [R]

- **From `origin/main` at `8150e36`:**
  - `CLAUDE.md`, `DECISIONS.md`, `KNOWN_ISSUES.md` (vault entries), `docs/ARCHITECTURE.md`
  - `docs/plan/2026-09-03-jarvis-roadmap.md` (§5.4, R2, §8)
  - `docs/superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md` (§2, §3, §5–§8)
  - `docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md` (voice gate, line 154)
  - `docs/runbooks/voice-smoke.md` (line 319)
  - `apps/local-agent/jarvis_local/vault/` (file list; `models.py`, `projection.py`, `reconciliation.py`, `setup.py`, `paths.py`, `migrations/0003_vault_local.sql`)
- **From `origin/claude/r2-memory-research`:**
  - `docs/research/2026-09-14-jarvis-memory-research.md`
  - `docs/research/2026-09-14-jarvis-memory-research-factcheck.md`
- **Commits:** `d31153e` (topic tree requirement) and `757fe01` (storage model on hold), both `docs/AGENT_LOG.md`.
