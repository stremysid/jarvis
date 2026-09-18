# Working on Jarvis

Who builds, who reviews, and the escalation ladder are in
[docs/BUILDING.md](docs/BUILDING.md). Current state is in
[docs/HANDOFF.md](docs/HANDOFF.md), [NEXT_STEPS.md](NEXT_STEPS.md) and
[KNOWN_ISSUES.md](KNOWN_ISSUES.md). This file holds the facts that keep getting
lost between sessions.

## Sid's hardware — the only machines this ships to

| Device | OS |
|---|---|
| Home PC | **Windows 11** |
| Laptop | **Windows 11** |
| Phone | **iPhone 16** |
| Car | Tesla — separate integration, not a host |

**There is no Linux machine and Sid has never used Linux.** Do not plan, build,
review or write runbooks for a Linux host without raising it with him first. A
bash/`systemd`/`chmod` instruction is not something he can run.

This is also the whole of the fleet. There is no server, no NAS, no VPS and no
second OS unless he says he has bought one.

**The home PC is on almost all the time — every waking hour, off overnight while
he sleeps.** So "always-on" in practice means "on except overnight", not 24/7.
Anything that must survive that nightly window has to live in the cloud
gateway, which is genuinely always-on, or tolerate catching up in the morning.

## The Linux node conflict is resolved for R2 memory

`jarvis node` refuses to start on anything but Linux
(`apps/local-agent/jarvis_local/node.py:239-240`), and the roadmap assumes "one
small Linux server" (`docs/plan/2026-09-03-jarvis-roadmap.md:231`, `:428`),
attributed to Sid and never provisioned. **Sid says he never asked for it and
told the original planning chat he is on Windows.** The Linux node was a
planning-session choice, not his decision.

The underlying requirement is real and is his, but it is not Linux. Memory must
work from the phone with every PC off. On 2026-09-14 Sid asked for the best
cloud memory and delegated its design. The reviewer chose D1 as the
authoritative ledger and topic tree, with D1 FTS5 and Vectorize as rebuildable
indexes. Obsidian is only a possible later one-way export, never an R2 runtime
dependency.

Do not provision the node, port it to Windows, add more Linux assumptions, or
make R2/R3 depend on it. Keep the existing node code and runbook as historical
work. Migration `0016` remains R2's, but Sid applies it only after the schema PR
passes Claude max review; this documentation does not create or authorize it.

Note that the Windows implementations were never removed:
`transport/pipe_server.py` (`NamedPipeServer`) and `crypto/dpapi.py` are in the
tree, and CI runs a full `local-agent (windows-latest)` job.

## Decisions recorded as Sid's that were not his

This has now happened twice — the watchdog being ratified into R0 scope, and the
Linux home node. **When a plan attributes a decision to Sid, that attribution is
evidence, not proof.** If a decision commits him to hardware, a platform, a
subscription or an operational burden, confirm it with him before building on
it. Distinguish the requirement he stated from the implementation someone chose
for it, and carry the requirement forward rather than the implementation.

## Things that are not this repository

- **PC hardware, purchasing and Blender/Roblox workload talk is personal.** It
  never goes in the repo, in a commit message, or in a PR.
- **St. Remy code lives in its own dedicated chat.** Do not touch that codebase
  from a Jarvis session.
