# Changelog

## Unreleased

### 2026-09-05 -- R0 local CI and deployment preparation

- Corrected Windows DACL and canonical-temp test assumptions and the Linux
  mypy target in `d9d59f9`. Moved the two extended Hermes files into a manual
  workflow. Runtime path validation is unchanged.
- Declared exactly the four non-optional `env.ts` string bindings in the
  gateway's production and test required-secret lists. Documented optional
  capability settings separately and supplied public synthetic test values.
- Removed the retired `PIN_VERIFIER_JSON` declaration and its two generator
  scripts. The stored secret is retained until after the item 5 gateway
  deploy; the legacy verifier implementation remains for R1.
- Added `scripts/deploy.ps1`, `scripts/deploy-watchdog.ps1`, and the deploy
  runbook. Scripts default to dry-run and explicitly select the top-level
  production environment with an empty native argument. Publishing requires
  confirmation. Added credential-free shell tests to Windows CI.
- Owner confirmed Wrangler login, rotation of the three peppers and
  DeepSeek key on production, and revocation of the old DeepSeek key.

Validation: 234 focused gateway tests, then all 1,935 workspace tests across
105 files; 2 deployment script tests;
both script tests rejected a mutation that dropped the empty argument;
both real Wrangler dry-runs exited 0 with no environment warning or stderr;
lint and source typecheck passed. Item 1's earlier local evidence: 113
watchdog tests, 107 regular Hermes tests, and 515 local
agent tests with 1 skipped. The full extended Hermes suites remain unrun.

No R0 deployment or migration is claimed. Claude Opus 5 high review, remote
CI, Telegram commands, cron heartbeat, and the morning digest remain
unverified. Items 5-7 are still open.

### 2026-09-02 / 2026-09-03 -- the expansion plan, built

Every capability in `docs/plan/2026-08-jarvis-expansion-plan.md` now exists
in code and tests, except live calling, which is the v1.0 release gate and
needs credentials that must be purchased.

Added, each with its own schema and tests:

- **Tiered autonomy and shadow mode.** The tier belongs to the capability,
  not the caller. An unregistered capability is denied rather than defaulted.
  Shadow mode is a separate axis, so leaving it is not the same act as
  granting tier 2.
- **The decision queue.** One ranked list of everything waiting on the owner,
  delivered as Telegram inline keyboards. The free-text and explain escapes
  are appended by the service, so a question structurally cannot force a pick.
- **The project manager.** Polls each tracked repository's four status
  documents and escalates a stalled project carrying an approaching deadline.
  A failed poll is recorded, not dropped.
- **The deadline store.** Effort-scaled reminders, exam-mode quiet windows,
  and a Google Classroom client. A deadline that stops appearing is never
  cancelled -- a half-succeeded scrape is indistinguishable from a deletion.
- **The daily digest and Sunday retro**, composed deterministically with no
  model in the path, because the inputs include text other people wrote.
- **The watchdog**, as a second Worker that imports nothing from the gateway.
- **The Obsidian vault adapter** (stage one, pure Python): reads, indexes,
  searches, and adds notes without ever replacing a file the owner wrote.
- **The local agent's run loop**, its backoff policy, and a control channel
  over a named pipe with an explicit DACL.
- **Cron scheduling** that survives daylight saving, at-least-once run
  claiming, slash commands, and `callback_query` support.

Fixed:

- The gateway's tests had never been typechecked; no tsconfig covered them.
  `tsconfig.test.json` now does, and reports a bounded pre-existing backlog.
- The Telegram classifier refused every button tap as unsupported content,
  which made the decision queue's keyboards unreachable.

Counts: gateway 1833, local agent 512 (1 skipped), watchdog 113, contracts
and acceptance 102.

**Nothing in this entry is deployed.** Production still runs the Worker from
before 2026-09-01.

### Earlier

- Consolidated all outstanding development branches onto `main`. The trunk now
  carries the Hermes H1 runtime, brain bridge, cloud gateway, and voice/calls
  work that previously lived only on unmerged branches.
- Full suite on the consolidated trunk: 72 test files, 1379 tests passing;
  `typecheck` and `lint` clean across all four workspace projects.

## 0.1.0

- Initialized the Jarvis cloud workspace and Worker test runtime.
