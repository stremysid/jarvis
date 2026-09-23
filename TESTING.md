# Testing

Command inventory checked on 2026-09-23 against
`a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`. Use PowerShell (`pwsh`) on Windows.
Commands below start at the repository root unless stated otherwise.

## Safety on the owner's PC

Do not run tests or tools that change real permissions, ownership, ACLs, services,
scheduled tasks, registry or logon settings. Permission operations must be fully
mocked. Do not use the owner's runtime stores, boot task or `C:\jarvis-test-scratch`
as fixtures. Never run `apps/local-agent/tests/integration` here. Excluding that
directory alone does not prove other tests safe: inspect the selected tests and
their fixtures before executing them. Hermes tests also include real file-mode
changes, so its full suite is not a safe local default under this restriction.

The required incident report, `C:\Users\Sid\Downloads\jarvis-profile-incident.md`,
was absent during this audit. No local-agent or Hermes runtime tests were run.
See [OWNER-ACTIONS](docs/OWNER-ACTIONS.md) for recovery of that report.

## Toolchain and dependency setup

[package.json](package.json) requires Node `>=24.19.0 <25` and pins
`pnpm@11.19.0`. The local audit observed Node 24.19.0 and pnpm 11.19.0.

```powershell
pnpm.cmd install --frozen-lockfile
```

For this audit, cached dependencies were installed with
`pnpm.cmd install --offline --frozen-lockfile --ignore-scripts` (zero downloads).
The Python packages use `uv`; resolve it with `Get-Command uv`. Do not copy the
obsolete `Ksid1` profile path. No claim about a broken system `python` is needed:
use the project's environment through `uv run`.

## What each command covers

| Command | Actual selection |
|---|---|
| `pnpm.cmd test` | Gateway, contracts and acceptance tests under the root Workers-pool [config](vitest.workspace.ts). Excludes watchdog, Hermes, Python packages and standalone Node script tests. |
| `pnpm.cmd test:cloud` | Gateway test directory, using the root workspace config. |
| `pnpm.cmd test:acceptance` | `tests/acceptance` in that same config. |
| `pnpm.cmd test:watchdog` | Watchdog's own [Vitest config](apps/watchdog/vitest.config.ts). |
| `pnpm.cmd test:runtime` | Hermes's full Node Vitest selection, including the two extended files. Subject to the PC restriction above. |
| `pnpm.cmd test:all` | Sequentially runs `test`, `test:runtime`, `test:watchdog`; stops on failure. Does not include Python or standalone Node script tests. Subject to the PC restriction above. |
| `pnpm.cmd typecheck` | Recurses over package scripts. Gateway covers `src/**/*.ts`, not its test tree; Hermes uses `node --check` on four source files. |
| `pnpm.cmd lint` | Recurses over package scripts. Four packages use `tsc --noEmit`; Hermes uses `node --check`. This is not a general-purpose lint gate. |
| `pnpm.cmd --filter @jarvis/cloud-gateway typecheck:tests` | Gateway source and tests via `tsconfig.test.json`. Not in CI. |
| `node scripts/check-state.mjs` | State-carrier format/link checks and FACTS row checks; not semantic verification of every documentation claim. Also available as `pnpm.cmd check:state`. |

Run a related selection while iterating:

```powershell
pnpm.cmd exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/digest --reporter=dot
```

Use the root config for Workers tests. `test:cloud` already supplies it; a bare
Vitest invocation in the package does not supply the same pool configuration.
The root config sets `testTimeout: 15_000`.

## Python packages

[local-agent/pyproject.toml](apps/local-agent/pyproject.toml) requires Python
`>=3.12,<3.15`, enables Ruff's `ANN` rules (including tests) and mypy strict mode.
For an inspected selection with fully mocked permission operations:

```powershell
Push-Location apps/local-agent
uv run pytest --ignore=tests/integration -q tests/<reviewed-file>.py
Pop-Location
```

Replace `<reviewed-file>` with an existing, safety-reviewed test; it is a
placeholder, not a runnable file. Static checks from `apps/local-agent` are
`uv run ruff check .` and `uv run mypy --platform win32 jarvis_local`.
Skip counts depend on platform and selection, so there is no fixed expected
local skip count. [Vault conftest](apps/local-agent/tests/vault/conftest.py)
contains profile-protection fixtures; they do not make every Python test safe.

[Brain bridge](apps/brain-bridge/pyproject.toml) is a separate Python package.
Neither it nor local-agent is included in `pnpm test:all`. The current CI runs
local-agent, but has no brain-bridge job.

## CI and separate script tests

[CI](.github/workflows/ci.yml) runs workspace lint/typecheck/tests, watchdog,
deployment-script tests on Windows, Hermes on Windows, local-agent on Windows
and Ubuntu, byte-exact checkout checks, and `state-carriers`. Its local-agent
job currently runs unrestricted `uv run pytest -q` on disposable runners;
**do not copy that command onto this PC**. Both mypy jobs target `win32`.

Regular Hermes CI excludes `source-lock.test.mjs` and
`workflow-containment-review5.test.mjs`. The manually dispatched
[Hermes extended tests](.github/workflows/hermes-runtime-manual.yml) runs each
in its own Windows job. This is a coverage split, not evidence that those tests
passed on this revision. Both workflows install the pinned uv-managed
interpreter used by the Windows launcher.

`node --test scripts/test/deploy.test.mjs` is CI's separate deployment-script
gate. Its synthetic CLI fixtures exercise dry-run/publish behavior and failures;
the test command does not deploy. Three other standalone Node suites exist:
`check-memory-backup-restore-target.test.mjs`,
`prepare-d1-scratch-baseline.test.mjs`, and `voice-release-gate.test.mjs`, all in
`scripts/test/`. CI does not run them. Inspect any suite before local execution.

## Voice gates

`pnpm.cmd test:voice-smoke` selects the two offline smoke contract/runtime
test files. `pnpm.cmd test:voice-access` runs the fake-only release chain.
`pnpm.cmd typecheck:voice-access` checks its acceptance TypeScript config.

`pnpm.cmd smoke:voice -- --scenario inbound` has no live authorization or
injected runtime and is designed to report `skipped`. This audit did not place
a call. `pnpm.cmd release:voice-gate` runs the fake chain and audits retained
evidence; missing/invalid evidence makes it fail. `clean:voice-smoke-evidence`
deletes retained evidence and is not a test prerequisite. None of these named
voice release commands appears in a CI workflow, although the smoke test files
are included by the root workspace glob.

Live smoke needs the attended procedure in the [voice runbook](docs/runbooks/voice-smoke.md)
and explicit owner authority. Offline passes do not establish live acceptance.

## Observations and fault probes

This audit observed `typecheck:tests` exit 1: **144 diagnostics in 32 files**.
The old September 3 suite counts were removed because they did not describe the
audited tree. Exact executed-gate counts are recorded in the signed
[audit entry](docs/AGENT_LOG.md#docs-verify-2026-09-23) rather than promised as a
permanent suite size.

No code or guards changed, so no mutation was added or claimed. For code changes,
plant the fault, confirm a named test fails, restore the code, and confirm that
test passes. A mutation that matches no text was not applied. Report failures,
skips and isolated reruns separately; a rerun does not erase the first result.
