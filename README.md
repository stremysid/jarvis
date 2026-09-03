# Jarvis

Sid's private personal assistant. Reachable from his phone, backed by a
permanent memory, and able to act on his behalf within limits he set.

**Start here if you are new to this repository.** Read this file, then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then
[KNOWN_ISSUES.md](KNOWN_ISSUES.md). The last one is long and is the most
honest document here -- it records what is weaker than it looks.

## Shape

Three pieces, the same shape as Sid's other systems:

| Piece | Where | What it is |
|---|---|---|
| `apps/cloud-gateway` | Cloudflare Worker + D1 + R2 | Always on. Telegram, memory, scheduled jobs, voice. |
| `apps/local-agent` | Windows, Python | Needs the machine awake. Archive, vault, PC-side work. |
| `apps/watchdog` | A **second** Cloudflare Worker | Watches the gateway. Shares no code with it, on purpose. |
| `apps/hermes-runtime` | Windows | A separate local model runtime. Its own track. |

The watchdog is separate because the failure that kills Jarvis must not also
kill the thing whose job is to report it. It imports nothing from the
gateway -- not a type, not a helper. That duplication is deliberate.

## What it does today

- **Telegram.** Text in, answers out, with memory. Slash commands:
  `/status`, `/queue`, `/digest`, `/exam on|off`, `/shadow on|off`, `/vault`.
- **Two-tier memory.** An append-only raw archive that keeps everything, and
  a distilled fact store that Jarvis actually reasons from. Content-hash
  dedup, full-text and vector search, both local.
- **Fact promotion rules.** Only Sid's own words and Jarvis's own
  observations become facts. A third party's email never does.
- **Tiered autonomy.** Tier 1 observes, tier 2 acts reversibly, tier 3 never
  runs without Sid confirming -- money, other people, deletion, production.
  Shadow mode is a separate axis: it holds tier 2 back while the system
  proves itself.
- **Decision queue.** Everything waiting on Sid arrives as one ranked list
  with tappable buttons, always including "other, I'll type it".
- **Project manager.** Polls each tracked repo's NEXT_STEPS / KNOWN_ISSUES /
  DECISIONS / CHANGELOG and escalates a stalled project with an approaching
  deadline.
- **Deadlines.** A store fed by Google Classroom and (eventually) a
  Brightspace scrape, with reminders scaled to how much work a thing is, and
  exam-mode quiet hours.
- **Daily digest and Sunday retro.** Assembled deterministically, with no
  model in the path.
- **Obsidian vault.** Jarvis reads, searches and adds notes to a vault it
  owns, and never overwrites a file Sid wrote.
- **Watchdog.** Alerts if the gateway stops reporting in.

## What it does not do yet

**Live calling is the v1.0 release gate and it is not met.** The plan is
explicit: Jarvis is not released until Sid can phone it from the car. The
code is built and deliberately fail-closed; it needs Twilio credentials and a
number, which is a purchase.

[NEXT_STEPS.md](NEXT_STEPS.md) has the rest, split into what a person has to
do, what is built but unwired, and what is genuinely unbuilt.

## Where the design lives

- [docs/plan/2026-08-jarvis-expansion-plan.md](docs/plan/2026-08-jarvis-expansion-plan.md)
  — the source of truth for scope. Everything in the list above traces to a
  numbered section of it.
- [docs/plan/2026-09-03-jarvis-roadmap.md](docs/plan/2026-09-03-jarvis-roadmap.md)
  — the roadmap: every feature wanted, its real state, the decisions that
  remain, and the milestones in dependency order.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — a map of the code, and the
  rules that recur across it.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — detailed
  task-by-task plans for the foundation, calling, voice access, Obsidian and
  Hermes tracks.

## The documents that are load-bearing

Every project here carries the same four, and Jarvis polls them on other
repos precisely because they are reliable. So they are kept accurate:

- [DECISIONS.md](DECISIONS.md) — choices made and why, including two where
  the code deliberately diverges from a plan.
- [KNOWN_ISSUES.md](KNOWN_ISSUES.md) — **read this before trusting
  anything.** It records where a guarantee is weaker than its name suggests.
- [NEXT_STEPS.md](NEXT_STEPS.md)
- [CHANGELOG.md](CHANGELOG.md)
- [docs/continuity/](docs/continuity/README.md) — session ledgers: what each
  working session decided, tried and rejected. Checkpoints, not scripture;
  verify them against the code.

## Running it

[TESTING.md](TESTING.md) has every suite and how to run it. The local agent's
commands are not the obvious ones -- read that section before trying.

[AGENTS.md](AGENTS.md) is for anyone, human or model, changing this code. It
lists the traps that have actually cost time here.
