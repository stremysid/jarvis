# Requirements

The authoritative scope is [Sid's roadmap](docs/plan/2026-09-19-jarvis-roadmap.md),
dated 2026-09-19. Its seven phases have human-checkable **done when** criteria.
These are requirements, not a list of completed or deployed features. This page
was checked against `a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d` on 2026-09-23.

Standing requirements:

- **Jarvis is the brain; code is the body.** Code supplies tools, provenance,
  storage and receipts. [CODE-VS-JUDGMENT](docs/CODE-VS-JUDGMENT.md) records
  implementation departures; the principle is not a claim they were removed.
- **Ask first** for actions that spend money, affect another person or cannot
  be undone. The roadmap's intended autonomy model and the current capability
  table are distinct; see [STATE](docs/STATE.md).
- **Keep credentials out of source, fixtures and logs.** Cloudflare bindings
  are not the only credential surface: the Windows agent has device-key and
  DPAPI code. A secret name in configuration is not evidence it has been set.
- **St. Remy's codebase is outside this repository's scope.**
- **The owner's host fleet is Windows, not Linux.** Linux-targeting legacy
  code and Ubuntu CI jobs still exist; that does not authorize a Linux host.

Use [STATE](docs/STATE.md) for dated implementation/deployment evidence,
[QUEUE](docs/QUEUE.md) for remaining work and [KNOWN_ISSUES](KNOWN_ISSUES.md) for
specific limits. The [gap table](docs/plan/2026-09-19-roadmap-gap.md) is a dated
assessment at `0611803`, not a fresh assessment of this revision (for example,
its zero-voice-tools claim predates `bde0a9b`). The roadmap wins over conflicting
design documents as scope, while code and recorded observations establish what
has actually been built or deployed.
