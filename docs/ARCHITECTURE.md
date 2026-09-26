# Architecture

A map of the code, and the handful of rules that recur across all of it.

If you are a fresh reader: skim the rules first. Most of what looks unusual
in this codebase is one of them being applied, and they explain more than a
per-file tour would.

---

## The rules that recur

### 1. Silence and success must never look the same

The failure this codebase spends the most effort on is a system that reports
nothing because nothing happened, being indistinguishable from one that
reports nothing because it is broken.

So: a failed poll is **recorded** as a failed observation rather than
dropped. A digest with no content says "nothing due, nothing changed" rather
than not sending. A source that could not be read is named **in** the digest,
and the truncation logic refuses to drop that section to make room. A
component that has never run reports "never run", not "ok".

When you add anything that reads an external system, ask what its output
looks like when it is broken, and make that different from its output when
all is quiet.

### 2. Untrusted text is data, never instructions

Jarvis reads repository files, scraped assignment titles, and the owner's own
notes. None of it may be treated as a directive.

Concretely: the digest is assembled **deterministically with no model in the
path**, because its inputs include text written by other people. Borrowed
text that reaches the owner's screen is quoted so it cannot impersonate a
heading Jarvis wrote, and stripped of Unicode's "other" category so a
right-to-left override cannot reverse what is read. Failure strings never
contain a response body.

### 3. The database enforces the invariant, not the code that writes to it

Append-only means a trigger, not a convention. Look at any migration in
`apps/cloud-gateway/src/persistence/migrations/` — the interesting part is
usually the `CHECK` constraints and the `RAISE(ABORT, ...)` triggers.

Examples worth reading: an answered decision cannot be re-opened and answered
differently; a deadline that moves keeps the revision proving it moved; a
resolved item must have a resolution timestamp and an unresolved one must
not.

### 4. Tier 3 is the backstop that holds after everything else fails

Sid's five actions -- spending money, sending an email, making a phone call,
submitting school work, and texting or calling someone on his behalf -- are
never automatic, in either autonomy mode, whatever the model's confidence
(Sid, 2026-09-24: "that's literaly it"). No other registered capability
asks; a few asks outside the tier registry remain and are listed in
[KNOWN_ISSUES](../KNOWN_ISSUES.md#confirmations-outside-sids-five-that-migration-0051-does-not-remove-2026-09-25).
This is the control that still works when a prompt injection has successfully
steered the model, which is why it is a property of the capability rather
than of the caller. Migration `0051` sets that list, and
`five-confirmed-actions.test.ts` pins it.

Tier 2 is not one of the five. It acts without asking once shadow mode is
off (`/shadow off`, Sid's own switch) and is reported instead of run while
it is on. Since `0051` it no longer means "reversible": deleting data and
touching production are tier 2 because Sid did not name them. Tier 1 always
runs. Every tier is audited.

### 5. Claim before you act, report after

Cron triggers are at-least-once. Every scheduled job claims a run key by
inserting it (`ON CONFLICT DO NOTHING`), because reading "has this run" and
then inserting lets two isolates both proceed. The watchdog heartbeat is sent
**after** the work, never before — a beat sent first claims the Worker is
alive for an invocation that then failed.

### 6. Say what you actually established

Comments and test names are bounded by what the code would fail on. Where a
guarantee is weaker than its name suggests, that is written down in
[KNOWN_ISSUES.md](../KNOWN_ISSUES.md) rather than implied away — the vault's
write-once and the named pipe's access control both have entries saying
exactly what is proven and what is only reasoned.

---

## `apps/cloud-gateway` — the always-on Worker

Entry point is `apps/cloud-gateway/src/index.ts`: a `fetch` handler (Telegram webhook, signed
sync routes, voice) and a `scheduled` handler (four cron expressions).

| Directory | What lives there |
|---|---|
| `channels/telegram/` | Ingress. Classification, rate limiting, command parsing, the rejection payload that structurally cannot leak media metadata. |
| `conversation/` | One turn: commit the user event, claim the turn, stream the model, stage and dispatch the reply. |
| `persistence/` | D1 access and [the migrations](../apps/cloud-gateway/src/persistence/migrations/). Start here to understand the data model. |
| `sync/` | Signed device requests, snapshot pagination, distillation. |
| `archive/` | R2 tiering for events aged out of D1. |
| `autonomy/` | Capability tiers and shadow mode. |
| `decisions/` | The decision queue and its Telegram keyboards. |
| `projects/` | GitHub poller and the project-facts reader the model judges from. |
| `deadlines/` | Deadline store, Classroom and Brightspace calendar clients, quiet windows, and a review pass that lets the model schedule its own reminders. |
| `digest/` | Deterministic composition of the daily digest and Sunday retro. |
| `jobs/` | Wires the above into the scheduled jobs. |
| `scheduler/` | Cron routing (including timezone), run claiming, heartbeat. |
| `voice/`, `calls/`, `providers/` | Twilio, ConversationRelay, the call session Durable Object. Fail-closed without credentials. |
| `policy/`, `security/` | Authentication, redaction, PIN verification. |
| `model/` | Model adapters and the token budget. |

### The data model in one paragraph

Everything is an **append-only event log** (`events`) with derived state.
`outbox` carries deliveries; `consumer_cursors` and `sync_snapshots` let the
local agent replicate without the cloud guessing what it has seen. Migration
`0001_foundation.sql` is long but is the single most useful file for
understanding the system.

---

## `apps/local-agent` — the Windows side

Python, `uv`, ruff + mypy strict. **The commands are not the obvious ones —
see [TESTING.md](../TESTING.md) before running anything.**

| Package | What lives there |
|---|---|
| `archive/` | The append-only local raw archive. Content-addressed. |
| `memory/` | Distilled facts, promotion rules, FTS5 and vector search, backup. |
| `sync/` | Signed cloud client, event replication, cursor store. |
| `crypto/` | Ed25519 device keys, DPAPI sealing, request signing. |
| `vault/` | The Obsidian adapter. 13 modules. |
| `transport/` | The named-pipe control channel. |
| `agent.py` | The cycle: replicate, then distil, then promote. |
| `scheduler.py` | When to wake next, and whether to keep going at all. |
| `service.py` | The run loop. |

### Two things about the local agent that surprise people

`agent.py` runs its three stages as **separate commitments** rather than one
transaction. A failure in distillation must not discard events that
replication already made durable.

`scheduler.py` treats an authentication failure as **not retryable**. The
key, the device registration or the clock is wrong; every retry produces the
identical rejection, and backing off turns a one-line problem into an agent
that looks alive for days while achieving nothing.

---

## `apps/watchdog` — the second Worker

Deliberately isolated. It imports **nothing** from the gateway; the liveness
table is the only shared surface and it only reads it. Two files are
transcribed copies that must be kept in step by hand
(`test/liveness-schema.ts` and the wire shape in `test/heartbeat.test.ts`) —
that is the cost of the no-import rule and both say so in their own comments.

It has its own `wrangler.toml`, its own vitest config, and its own CI job,
because registering it in the root workspace would recouple their
deployments.

---

## `apps/hermes-runtime` — a separate track

A hardened local model runtime. Pinning code and the TypeScript adapter and
selector are on `main`; the Python Brain Bridge has contracts but lacks the
planned HTTP boundary. See the [H1 task status](superpowers/plans/2026-08-31-jarvis-hermes-h1-implementation.md).
This is not evidence of a completed live pilot.

---

## Where to start reading, by goal

| You want to | Read |
|---|---|
| Understand the data model | `apps/cloud-gateway/src/persistence/migrations/0001_foundation.sql`, then 0008–0013 |
| Understand a full request | `apps/cloud-gateway/src/index.ts`, then `apps/cloud-gateway/src/conversation/conversation-service.ts` |
| Understand the security posture | `apps/cloud-gateway/src/channels/telegram/telegram-webhook.ts` (the ordering is the design), then `.../security/redaction.ts` |
| Understand what is memory | `apps/local-agent/jarvis_local/memory/promotion.py` |
| Know what to distrust | [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) |
| Know what to build next | [QUEUE.md](QUEUE.md) |
| Know why something is the way it is | [DECISIONS.md](../DECISIONS.md), then the module's own docstring |
