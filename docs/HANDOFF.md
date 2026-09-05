# Handoff

Current as of **2026-09-05**. If this date is old, verify against the code
before trusting anything below — this file has been badly stale before.

## State

The cloud-side features of
[the expansion plan](plan/2026-08-jarvis-expansion-plan.md) are built and
tested **except** live calling, which is the v1.0 release gate. The local
agent has no process bootstrap, facts never reach the phone, and the later
build-order items (errands, Tesla, PWA, voice notes, Brightspace) are not
started. [The roadmap](plan/2026-09-03-jarvis-roadmap.md) has the full
table and the milestone order.

R0 is in progress on `main` in the shared `C:/javis` checkout. Item 1's local
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

`ruff`, `mypy --strict` and `tsc` are clean. `typecheck:tests` on the gateway
reports 117 pre-existing errors in older test files — see KNOWN_ISSUES.

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

The next gate is **Claude Opus 5 at high effort** reviewing the complete R0
diff from `db2b3a5`, including `d9d59f9`. No callable Claude reviewer was
available in the building session, and no cross-vendor approval is claimed.
After review, follow NEXT_STEPS and the runbook for production confirmation,
migrations, capability settings, deployment, health/monitor wiring, hourly
archival, and real exit evidence. Calling remains R1; the roadmap records
that the Twilio number and credentials already exist.

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
