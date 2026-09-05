# Testing

All commands run from the repository root unless stated otherwise.

```bash
pnpm install
```

## Everything at once

```bash
pnpm test:all
```

That is `pnpm test` (cloud gateway, contracts, acceptance) plus
`pnpm test:runtime` (Hermes) plus `pnpm test:watchdog`. It does **not**
include the local agent, which is Python — see below.

Expected as of 2026-09-03: gateway 1833, watchdog 113, contracts and
acceptance 102, local agent 512 with 1 skipped.

## The cloud gateway

```bash
pnpm test
```

One suite, one file, or one directory:

```bash
npx vitest --config vitest.workspace.ts run apps/cloud-gateway/test/digest --reporter=dot
```

Always pass the workspace config. Running vitest from inside
`apps/cloud-gateway` fails with `Cannot find package 'cloudflare:test'` —
the Workers pool is configured at the root.

Types:

```bash
pnpm typecheck
```

That covers `src/**` only. The tests have their own config, which reports 117
pre-existing errors and is therefore not yet a gate:

```bash
pnpm --filter @jarvis/cloud-gateway typecheck:tests
```

## The local agent — read this before running anything

**`python` on PATH is a broken stub.** Use `uv`, which is at an unusual path.
From `apps/local-agent`:

```bash
& "C:\Users\Ksid1\AppData\Local\hermes\bin\uv.exe" run pytest -q
```

```bash
& "C:\Users\Ksid1\AppData\Local\hermes\bin\uv.exe" run ruff check .
```

```bash
& "C:\Users\Ksid1\AppData\Local\hermes\bin\uv.exe" run mypy jarvis_local
```

All three must pass. Ruff runs with `ANN`, so **every function needs
annotations, test functions included** — a missing return type on a test is a
lint failure, not a warning. mypy runs strict.

Notes:

- One test skips on this machine (an NTFS ACL check). That is expected.
- Vault tests have an autouse guard that fails any test which would create a
  real vault under the user profile. It exists because an early run created
  three empty directories there.
- The named-pipe tests are Windows-only and skip elsewhere. A mypy run on
  Linux uses `--platform win32` because this application still targets Windows.
  The live Windows-profile guard check also skips on Linux; the portable
  vault tests still run there.

## The watchdog

```bash
pnpm test:watchdog
```

It has its own vitest config and its own CI job, deliberately — see
[AGENTS.md](AGENTS.md).

## Deployment scripts

With PowerShell 7.3+ (`pwsh`) installed:

```bash
node --test scripts/test/deploy.test.mjs
```

These tests run the scripts against a synthetic native CLI, checking the
empty production environment argument, dry-run default, confirmation bypass
only when explicitly requested, WhatIf behavior, and failure propagation.
They never deploy. [The deployment runbook](docs/runbooks/deploy.md) has the
local bundle checks and the separately confirmed production commands.

## Hermes runtime

```bash
pnpm test:runtime
```

The regular CI job excludes `source-lock.test.mjs` and
`workflow-containment-review5.test.mjs`, each of which can take fifty minutes.
Run those through the **Hermes extended tests** manual workflow, or run the
full command above locally. The manual workflow runs each file in its own
Windows job. The containment fixtures resolve the temporary parent through
Windows native realpath before constructing RuntimeRoot; the control still
rejects raw alias paths.

To run the regular CI selection locally:

```bash
pnpm --filter @jarvis/hermes-runtime exec vitest run test --exclude test/source-lock.test.mjs --exclude test/workflow-containment-review5.test.mjs
```

Must run on **Windows**. It pins byte-exact canonical files, and a
`.gitattributes` gap once silently rewrote them to CRLF on checkout, breaking
attestation on the only platform it targets. A Linux-only job stayed green
through that entire failure.

## Voice

The voice smoke contract is credential-free and offline by default:

```bash
pnpm test:voice-smoke
```

`pnpm smoke:voice -- --scenario inbound` must report `skipped` — this branch
contains no live driver. `pnpm release:voice-gate` only audits already
generated redacted evidence and exits nonzero if any is absent or invalid.
`pnpm clean:voice-smoke-evidence` removes those files.

**Never add live flags during ordinary testing.** Calls, provider
configuration, deployment and rollback need the operator workflow and
explicit authorization in
[docs/runbooks/voice-smoke.md](docs/runbooks/voice-smoke.md).

## Verifying a test actually bites

Green is not evidence. Plant the defect the test exists to catch and confirm
it fails — [AGENTS.md](AGENTS.md) lists three cases in this repository where
a passing test did not.
