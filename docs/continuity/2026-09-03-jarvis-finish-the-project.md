# Session ledger — finish the Jarvis project

- **Date:** 2026-09-02 / 2026-09-03
- **Session:** 87cc033a-9c35-4c8f-9b28-7d3bf81e377d
- **Workspace:** `C:\javis`, branch `main`
- **Predecessor:** same session, pre-compaction
- **Successor:** none yet

> Kept in the repository at Sid's explicit instruction, overriding the
> standing preference that ledgers live outside it. The repository is
> private. This file records no credential values — only which secrets exist
> and which need rotating, per the same standing rule.

## Objective

"Finish the entire jarvis project" — build every capability in
[the expansion plan](../plan/2026-08-jarvis-expansion-plan.md), not just the
parts already started.

## Requirements and constraints Sid set

- **Never read his Google Doc of API keys.** Secrets go straight into
  `wrangler secret put`, never through a chat.
- Credentials already pasted into a transcript are compromised and must be
  rotated: three peppers, the DeepSeek key, the PIN verifier.
- Standing authorization to act without asking; still tell him before
  irreversible live-business actions.
- Multiple agents authorized.
- Repeated instruction not to stop and report but to keep building.

## Decisions and rationale

Both are also in [DECISIONS.md](../../DECISIONS.md), which is the durable
record; this is the context for why they came up.

- **Migration numbering diverges from the Obsidian plan.** That plan reserves
  0008–0011 for vault state. Those numbers were taken first by autonomy,
  decisions, projects, deadlines, liveness and scheduled-runs. Renumbering
  migrations that had already applied to the test database, to free numbers
  nothing occupies, is the worse trade. Vault D1 migrations take 0014 onward.
- **The Obsidian adapter ships in two stages.** The plan's design is one
  capability wrapped in Windows-specific hardening several times its size.
  Stage one is the capability in pure Python; stage two is the Rust/PyO3
  bridge. Until stage two lands the adapter meets a weaker guarantee than the
  plan states, and that difference is in KNOWN_ISSUES.md rather than implied
  away.
- **The watchdog imports nothing from the gateway and gets its own CI job.**
  Registering it in the root vitest workspace would recouple their
  deployments, which is the exact thing it exists to prevent.
- **The digest is composed deterministically, with no model in the path**,
  because its inputs include repository files and scraped assignment titles.

## Workspace and Git state

- 21 commits this session, all on `main`.
- `main` pushed; local and `origin/main` identical.
- 18 local-only branches, all fully merged into main — nothing unique.
- 4 remote branches (`codex/task-7/8/9-*`, Aug 30) carry commits not in main
  but are **superseded**: main has every file they add, and where versions
  differ main's is newer.

## Completed work

**Cloud gateway** — tiered autonomy and shadow mode; the decision queue with
Telegram inline keyboards; the GitHub project poller and stalled detector;
the deadline store with effort classifier, Classroom client and exam quiet
windows; the deterministic digest composer; a cron router that survives
daylight saving; at-least-once run claiming; the watchdog heartbeat; the
scheduled handler; the slash-command surface; `callback_query` support; and
the full `index.ts` wiring.

**Watchdog** — a standalone second Worker, 113 tests, its own CI job.

**Local agent** — the cycle runner, the scheduler policy, the run loop, a
DACL-restricted named-pipe control channel, and the Obsidian vault adapter
(13 modules, 218 tests).

**Documentation** — README, AGENTS, TESTING, REQUIREMENTS, CHANGELOG and
HANDOFF rewritten; `docs/ARCHITECTURE.md` added; the expansion plan brought
into the repository.

## Failed or rejected approaches

- **Python heredocs corrupted TypeScript escape sequences three times** —
  `\u0000` and `\n` arrived as literal control characters in source. Use the
  file-writing tool for anything containing escapes.
- **Semicolons inside SQL comments** split statements in the test migration
  splitter, surfacing as D1 `incomplete input`. Migrations avoid them.
- **`interface Env extends import(...)` did not merge into `Cloudflare.Env`.**
  A type alias did. That one change took the test typecheck from 1544 errors
  to 117.

## Verification evidence

| Suite | Result |
|---|---|
| cloud-gateway | 1833 passing, 96 files |
| local-agent | 512 passing, 1 skipped; ruff + mypy strict clean |
| watchdog | 113 passing |
| contracts + acceptance | 102 passing |

Mutation-verified by hand rather than trusted: the cron router's timezone
handling (a frozen offset fails 4 tests) and the autonomy tier-3 gate (fails
2). Agents reported their own batteries — autonomy 18/18, deadlines 5/5,
local agent 14/14.

Two tests were found to be weaker than their names claimed and were
strengthened: "the digest goes out exactly once a day" passed against a
frozen-offset router, because that also fires once a day, an hour early.

## Blockers and risks

- **BLOCKER: nothing is deployed.** No cached wrangler auth and no
  `CLOUDFLARE_API_TOKEN` in a non-interactive environment. Production runs a
  Worker from before 2026-09-01.
- **Vault observations are stored with no redaction.** Safe only because
  nothing uploads them. The redactor is a prerequisite for the cloud sync
  path, not a follow-up to it.
- **Classroom `dueDate`/`dueTime` UTC-versus-local is unresolved.** The API
  reference and the plan disagree; the two readings differ by 4–5 hours in
  every reminder. One real assignment settles it.
- 117 pre-existing type errors in gateway tests, newly visible.
- Nothing watches the watchdog; it needs an external uptime monitor.

## Exact next actions

1. Sid rotates the compromised secrets.
2. Sid applies migrations 0008–0013 and deploys the gateway, then the
   watchdog with its own Telegram bot.
3. Sid sets `OWNER_PRINCIPAL_ID`, `DIGEST_TIMEZONE`, `TELEGRAM_BOT_USERNAME`.
4. Verify `/status` and `/queue` answer in Telegram; verify a cron fires.
5. Then: Classroom OAuth, the decision expiry sweep, deadline status setters.

## Resume prompt

> Continue finishing Jarvis at `C:\javis`. Read `README.md`,
> `docs/ARCHITECTURE.md`, `NEXT_STEPS.md` and `KNOWN_ISSUES.md` first — they
> are current as of 2026-09-03. Everything in the expansion plan is built
> except live calling, which needs Twilio credentials Sid must buy, and the
> Obsidian native bridge. Nothing is deployed: the previous session could not
> authenticate wrangler. Do not read Sid's key document; secrets go straight
> into `wrangler secret put`.
