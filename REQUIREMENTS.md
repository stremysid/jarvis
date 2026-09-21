# Requirements

What Jarvis must do is [the roadmap](docs/plan/2026-09-19-jarvis-roadmap.md),
written by Sid on 2026-09-19. It is the only source of scope. Each of its seven
phases ends in a **done when** a person can check, and that sentence is the
requirement.

Where a design document under `docs/superpowers/` or anywhere else disagrees
with the roadmap, the roadmap wins and the other document is stale.

Standing rules that apply to every phase:

- **Jarvis is the brain; the code is the body.** Code gives it tools, senses,
  memory and receipts. Code does not decide what Sid meant.
- **Ask first** before anything that spends money, affects another person, or
  cannot be undone. Everyday actions do not ask.
- **Credentials never in source.** Secrets are set in Cloudflare and are
  write-only.
- **St. Remy's codebase is off limits** from a Jarvis session.
- **Windows only.** No Linux, anywhere in the fleet.

How far the code is from each phase is in
[the gap table](docs/plan/2026-09-19-roadmap-gap.md) and
[docs/STATE.md](docs/STATE.md).
