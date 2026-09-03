# Requirements

## Scope

The source of truth for what Jarvis is meant to do is
[the expansion plan](docs/plan/2026-08-jarvis-expansion-plan.md). Every
capability in [README.md](README.md) traces to a numbered section of it, and
its "Decisions -- resolved" list is the set of choices that are settled.

[The builder prompt](docs/plan/2026-08-jarvis-builder-prompt.md) is the brief
that started the build. It fixes the working rules -- tiered autonomy before
any tier-2 action, shadow mode before autonomy, credentials never in source,
and the St. Remy codebase strictly off limits.

## Detailed specifications

Task-level plans and their approved designs:

| Track | Spec | Plan |
|---|---|---|
| Foundation | [foundation design](docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md) | [cloud](docs/superpowers/plans/2026-08-29-jarvis-foundation-cloud.md) |
| Telegram and memory | -- | [telegram/memory release](docs/superpowers/plans/2026-08-29-jarvis-telegram-memory-release.md) |
| Calling | -- | [calling](docs/superpowers/plans/2026-08-29-jarvis-calling.md) |
| Voice access | [owner/guest call access](docs/superpowers/specs/2026-08-30-jarvis-owner-guest-call-access-design.md) | [voice access](docs/superpowers/plans/2026-08-30-jarvis-owner-guest-voice-access.md) |
| Obsidian memory | [design](docs/superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md) | [implementation](docs/superpowers/plans/2026-08-30-jarvis-obsidian-memory-implementation.md) |
| Hermes runtime | [design](docs/superpowers/specs/2026-08-30-jarvis-hermes-runtime-design.md) | [H1](docs/superpowers/plans/2026-08-31-jarvis-hermes-h1-implementation.md) |

## Where the code deliberately differs from a plan

Two places, both recorded with reasoning in [DECISIONS.md](DECISIONS.md):
migration numbering, and the Obsidian adapter shipping in two stages. Where a
plan and the code disagree on those points, the code and DECISIONS.md are
current and the plan is not.

## The release gate

Version 1.0 ships when Sid can phone Jarvis from the car. Nothing else is the
gate; the plan is explicit about it.
