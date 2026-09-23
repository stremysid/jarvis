# Jarvis

Sid's private personal assistant, under development. The goal is one assistant
with durable memory, reachable by text and phone, with tools that act under the
owner's authority. That goal is not a claim that every conversation is remembered
or that every roadmap tool exists.

Documentation checked on 2026-09-23 against fetched `origin/main` at
`a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`.

## Start here

1. [The roadmap](docs/plan/2026-09-19-jarvis-roadmap.md) and
   [requirements](REQUIREMENTS.md) define intended behavior.
2. [STATE](docs/STATE.md) records implementation and deployment observations;
   read each observation's date and source revision.
3. [AGENTS](AGENTS.md) and [BUILDING](docs/BUILDING.md) govern repository work.
4. [QUEUE](docs/QUEUE.md) tracks work; [OWNER-ACTIONS](docs/OWNER-ACTIONS.md)
   tracks actions only Sid can take.

## What is in the tree

| Piece | Implementation at the audited revision |
|---|---|
| [Cloud gateway](apps/cloud-gateway/src/index.ts) | Cloudflare Worker with Telegram ingress, voice routes, school email ingestion and scheduled jobs; D1, R2, Vectorize and Workers AI bindings are declared in its [configuration](apps/cloud-gateway/wrangler.toml). Configuration does not establish successful ingestion or recall. |
| [Owner agent core](apps/cloud-gateway/src/agent/owner-agent-core.ts) | Shared tool loop for Telegram and voice. Telegram exposes nine memory tools plus school, university and study-coach pipelines; voice exposes the nine memory tools. The channels still have separate runtime composition and different context retrieval. |
| [Watchdog](apps/watchdog/src/index.ts) | Separate Worker that receives heartbeats and assesses liveness. It imports no gateway code. An external monitor is a separate deployment action. |
| [Local agent](apps/local-agent/jarvis_local/cli.py) | Python archive, memory, sync and vault code. `jarvis serve` binds the Windows control pipe; it requires the PC to be awake. This does not establish successful device sync. |
| [Hermes runtime](apps/hermes-runtime/package.json) | Local runtime tooling with its own test command and Windows CI job. Deployment is not established by the presence of this package. |
| [Brain bridge](apps/brain-bridge/pyproject.toml) | Python package with source and tests. No deployment for it is recorded in STATE. |

The recorded fleet is Windows PCs and an iPhone; see [FACTS](docs/FACTS.md).
The home PC is off overnight. The roadmap assigns work that must survive that
gap to the cloud; it does not require moving all work there.

## Deployment boundary

No production check was made for this documentation audit. **As of `352991e`**,
[STATE's recorded observation](docs/STATE.md#production), taken at 23:20 UTC on
2026-09-21, names Worker upload `78cb6e98-7814-4be7-82fb-a795a7e4d0a7` and active
version `64a184ce-4408-4962-b973-9ec3b6f48c9c` after secret-only version changes.
It records D1 through migration `0038`, a gateway heartbeat, six inbound owner
calls and no outbound calls. Later merged code is not thereby deployed.

## Working on it

[TESTING](TESTING.md) maps commands to coverage and states the PC safety
restrictions. [KNOWN_ISSUES](KNOWN_ISSUES.md) contains remaining limits with code
evidence. [ARCHITECTURE](docs/ARCHITECTURE.md) is the broader code map;
[DECISIONS](DECISIONS.md) holds dated decisions. For deployment, use the
[runbook](docs/runbooks/deploy.md) only with explicit owner authority.
