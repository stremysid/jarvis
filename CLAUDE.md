# Working on Jarvis

The traps, the conventions and the fleet are in [AGENTS.md](AGENTS.md) — read it
first. Who builds and who reviews is [docs/BUILDING.md](docs/BUILDING.md). What is
true right now is [docs/STATE.md](docs/STATE.md); what is in flight is
[docs/QUEUE.md](docs/QUEUE.md); what only Sid can do is
[docs/OWNER-ACTIONS.md](docs/OWNER-ACTIONS.md).

Three facts are repeated here rather than only linked, because a session that misses
them does damage before it reads anything else:

**No Linux, ever.** The fleet is a Windows 11 home PC, a Windows 11 laptop and an
iPhone 16. A bash, `systemd` or `chmod` instruction is not something Sid can run.

**The home PC is off overnight**, so "always-on" means "on except overnight". What
must survive that window lives in the cloud.

**Code never judges; the model does.** Code does not decide meaning, which, how
many, how long, or whether to act. The model decides and asks Sid when it is
unsure. Code only enforces permissions (guest isolation, Sid's five confirmed
actions), id and ownership checks, system-protection limits, and receipts. A pull
request that adds a code-side judgment does not merge (#203). The rule and the
removal list are [docs/CODE-VS-JUDGMENT.md](docs/CODE-VS-JUDGMENT.md).

This file is deliberately short. It exists because Claude Code loads it; the facts
it used to carry now live in `AGENTS.md`, which is the single copy, and duplicating
them here is how two documents start disagreeing.
