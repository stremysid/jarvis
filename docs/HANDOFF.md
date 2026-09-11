# Handoff

Current as of **2026-09-06**. If this date is old, verify against the code
before trusting anything below — this file has been badly stale before.

## State

The cloud-side features of
[the expansion plan](plan/2026-08-jarvis-expansion-plan.md) are built and
tested **except** live calling, which is the v1.0 release gate. The local
agent has no process bootstrap, facts never reach the phone, and the later
build-order items (errands, Tesla, PWA, voice notes, Brightspace) are not
started. [The roadmap](plan/2026-09-03-jarvis-roadmap.md) has the full
table and the milestone order.

R0 is in progress on `claude/r0-green-and-deployed` in the shared `C:/javis`
checkout, with draft PR #4 targeting `main`. Item 1's local
CI corrections are committed in `d9d59f9`; remote CI is unverified. Items 3
and 4 are implemented locally: exact four-name required-secret lists in
both gateway environments, retired PIN generators, synthetic test bindings,
and named deployment scripts with a [runbook](runbooks/deploy.md).

Both scripts passed native argument checks and real Wrangler dry-runs,
including explicit empty production environment selection. A mutation to
legacy PowerShell argument passing failed both tests because it dropped the
empty value. Lint and source typecheck pass. The four-name configuration
passed 234 focused gateway tests, followed by all 1,935 workspace tests
across 105 files. No missing-required-secret warnings remained in that run.

No Worker deployment or migration was performed by this R0 session. No
Telegram exit check, cron heartbeat, morning digest, or remote CI check has
been completed. R0 is not complete and v1.0 is not released.

| Suite | Count |
|---|---|
| `apps/cloud-gateway` | 1833 |
| `apps/local-agent` | 515 (1 skipped), item 1 local run |
| `apps/watchdog` | 113 |
| contracts + acceptance | 102 |

The item 1 predecessor ran ruff and Windows-target mypy successfully. This
builder ran lint and source typecheck for items 3/4; the reviewer separately
reports pytest and mypy clean. Neither Python check was rerun by this
builder for the test move. `typecheck:tests` on the gateway has a documented
117-error backlog in older test files — see KNOWN_ISSUES.

## Next gate and owner decisions

**Item 2 is complete by owner confirmation:** Wrangler login, the three
pepper rotations and DeepSeek key rotation on production
`jarvis-cloud-gateway`, plus revocation of the old DeepSeek key. Values were
never shared. Do not request them or repeat the rotation request.

`PIN_VERIFIER_JSON` is removed from configuration now. That only removes a
pre-deploy existence check; it does not affect the stored secret or the live
Worker. Keep the stored secret until after the item 5 gateway deploy, then
delete it as a separate confirmed operation. The legacy verifier module
stays until R1.

The owner reports PR #4 approved for items 1, 3 and 4, with one
recommendation: keep the fast 8.3 regression in regular PR CI. It now lives
in `test/temp-path.test.mjs` and uses the same extracted fixture builder as
the excluded containment file. Raw alias rejection and canonical acceptance
are still measured against the unchanged runtime module.

The escalation that stopped the builder on 2026-09-06 is triaged and fixed.
Claude Opus 5 high (BUILDING.md rung 2) found one root cause behind 23 of the
26 remote failures: only one test file had been canonicalized against the
runner's 8.3 temp alias, leaving 75 raw `mkdtemp` sites across nine more
Hermes files and `scripts/test/deploy.test.mjs`. The remaining three were the
Windows launcher failing to resolve `Astral/CPython3.11.16`, which is a
uv-managed PEP 514 tag that `actions/setup-python` does not register. The
`EBUSY` was a cleanup race against a PowerShell handle opened with no
`FILE_SHARE_DELETE`; it never surfaced in CI because the alias check rejected
those paths before the lock was opened. See KNOWN_ISSUES.md for the detail.

The fix is test and CI only. No runtime code, no security control and no
share flag changed. The regular selection still collects 108 tests and
`source-lock` 77, so nothing was dropped. Windows execution is verified by
CI, not locally: this triage ran on Linux, where the suites cannot execute.

Do not treat prior local workspace results or owner approval as green CI.

The owner will perform item 5's deployment. After the blocker is resolved,
continue items 6 and 7 locally, then verify deployed behavior. No main push or
merge was requested. Calling remains R1; the roadmap records that the
Twilio number and credentials already exist.

## What is built but not wired

- **Google Classroom ingestion.** The client and the ingestion path exist;
  the hourly job does not call them, because no deployment holds the OAuth
  credentials. `deadline_sources` therefore has nothing writing to it, so the
  deadline half of the digest is empty rather than stale.
- **`project()` in the vault** has no authority gate in front of it. Nothing
  but tests calls it. Do not wire a caller without one.
- **The local agent has no process bootstrap.** `RunLoop`, `ServiceState` and
  `NamedPipeServer.serve_forever` are tested and nothing starts them; there
  is no `jarvis service` command and no Windows service host.

## The one thing to read before building on the vault

Vault observations are stored **verbatim, with no redaction**. That is safe
today only because nothing uploads them. Building the cloud sync path before
the redactor would ship the owner's notes to the gateway unredacted, so the
redactor is a prerequisite for that work rather than a follow-up to it.

## Deliberate divergences from the plans

Two, both in [DECISIONS.md](../DECISIONS.md) with reasoning:

- Migration numbering: the Obsidian plan reserves 0008–0011 for vault state;
  those numbers were taken first. Vault D1 migrations take 0014 onward.
- The Obsidian adapter ships in two stages. Stage one (pure Python) is done.
  Stage two is the Rust/PyO3 bridge, and until it lands the adapter meets a
  weaker guarantee than the plan states.

## Session history

Detailed continuity ledgers live outside the repository, under each
assistant's continuity directory (`~/.codex/continuity/tasks/` for Codex),
per the owner's standing preference. They are
not required to understand the code — this file, ARCHITECTURE.md,
KNOWN_ISSUES.md and NEXT_STEPS.md are meant to be sufficient on their own. If
they are not, that is a bug in them.
