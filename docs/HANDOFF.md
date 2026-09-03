# Handoff

Current as of **2026-09-03**. If this date is old, verify against the code
before trusting anything below — this file has been badly stale before.

## State

Everything in
[the expansion plan](plan/2026-08-jarvis-expansion-plan.md) is built and
tested **except** live calling, which is the v1.0 release gate.

Nothing built after 2026-09-01 is deployed. Production still runs an older
Worker.

| Suite | Count |
|---|---|
| `apps/cloud-gateway` | 1833 |
| `apps/local-agent` | 512 (1 skipped) |
| `apps/watchdog` | 113 |
| contracts + acceptance | 102 |

`ruff`, `mypy --strict` and `tsc` are clean. `typecheck:tests` on the gateway
reports 117 pre-existing errors in older test files — see KNOWN_ISSUES.

## What is blocked on a person

1. **Rotate the compromised credentials.** Three peppers, the DeepSeek key
   and the PIN verifier were pasted into a chat transcript. Pipe replacements
   straight into `wrangler secret put`.
2. **Deploy.** Apply migrations 0008–0013 and deploy the gateway, then deploy
   the watchdog with its **own** Telegram bot and chat.
3. **Set `OWNER_PRINCIPAL_ID`.** Scheduled work has no request to derive an
   identity from, so without it the digest has nobody to send to and the job
   fails rather than guessing.
4. **Buy the Twilio number and credentials** for live calling.

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

Detailed continuity ledgers live outside the repository, at
`~/.claude/continuity/tasks/`, per the owner's standing preference. They are
not required to understand the code — this file, ARCHITECTURE.md,
KNOWN_ISSUES.md and NEXT_STEPS.md are meant to be sufficient on their own. If
they are not, that is a bug in them.
