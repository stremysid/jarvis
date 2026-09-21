# Jarvis

Sid's private personal assistant: one AI that remembers everything he tells it,
reachable by text and by phone, with tools to act for him — and asking first
before anything that spends money, affects someone else, or cannot be undone.

**Start here if you are new to this repository:**

1. [The roadmap](docs/plan/2026-09-19-jarvis-roadmap.md) — Sid's own plan, and
   authoritative. Where anything else disagrees with it, the other document is
   stale.
2. [docs/STATE.md](docs/STATE.md) — what is actually true right now, observed
   in production.
3. [AGENTS.md](AGENTS.md) — the traps that have actually cost time here.
4. [docs/QUEUE.md](docs/QUEUE.md) — what is in flight.

## Shape

| Piece | Where | What it is |
|---|---|---|
| `apps/cloud-gateway` | Cloudflare Worker + D1 + R2 + Vectorize | Always on. Telegram, phone calls, memory, scheduled jobs |
| `apps/watchdog` | A **second** Cloudflare Worker | Watches the gateway. Shares no code with it, on purpose |
| `apps/local-agent` | Windows, Python | Needs the PC awake. Archive, vault, PC-side work |
| `apps/hermes-runtime` | Windows | A separate local model runtime |
| `apps/brain-bridge` | — | Stalled mid-build; runs nowhere |

The watchdog is separate because the failure that kills Jarvis must not also
kill the thing whose job is to report it. It imports nothing from the gateway.

The fleet is a Windows 11 home PC, a Windows 11 laptop and an iPhone. The home
PC is off overnight, so anything that must keep working lives in the cloud.

## The documents

- [docs/STATE.md](docs/STATE.md) — what is true now. Regenerated, not appended.
- [docs/QUEUE.md](docs/QUEUE.md) — what is in flight and who owns it.
- [docs/OWNER-ACTIONS.md](docs/OWNER-ACTIONS.md) — what only Sid can do.
- [docs/FACTS.md](docs/FACTS.md) — settled facts, each with its evidence.
- [docs/BUILDING.md](docs/BUILDING.md) — who builds, who reviews, and when a
  stuck session must stop.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — a map of the code.
- [DECISIONS.md](DECISIONS.md) — dated decisions and their reasons.

## Running it

[TESTING.md](TESTING.md) has every suite and how to run it. The local agent's
commands are not the obvious ones — read that section before trying.
[docs/runbooks/deploy.md](docs/runbooks/deploy.md) is how production is
deployed; only Sid applies migrations.
