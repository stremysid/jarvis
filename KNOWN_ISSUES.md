# Known issues

## hermes-profile-lock.json records a stale sourceLockHash

`hermes-profile-lock.json` carries `sourceLockHash`
`3f3618bb177da35cab360f4e62c059d28f82cebe14fa98f4582a8c1374ded0d3`, but the
current `hermes-source-lock.json` canonically hashes to
`9dd8a06d7df921dec55652bb0e2c5ab0488702b288abdc2fb505e66271dbb392`. Commit
`c363631` re-pinned the source lock without regenerating the profile lock.

`schemas/hermes-profile-lock-v1.schema.json` still pins the old value so that
it agrees with the profile lock it validates. The attestation and receipt
schemas were repointed at the current source lock, because they are derived
from it at runtime.

Resolving this means regenerating `hermes-profile-lock.json` against the
current source lock, which cascades into every `profileLockHash` binding.
That is an integrity-chain change for the owner to approve, not a mechanical
edit; it is deliberately left open.

## The hermes-runtime suite is excluded from `pnpm test`

`vitest.workspace.ts` runs under the Cloudflare Workers pool, so it cannot
host `apps/hermes-runtime`'s Node-based tests. Run them with
`pnpm test:runtime`; `pnpm test:all` runs both. Until this was wired up,
245 tests -- covering source pinning, SBOMs, and attestation -- were run by
neither the default command nor any CI.

## The hermes-runtime suite is slow

`source-lock.test.mjs` and `workflow-containment-review5.test.mjs` each took
roughly 50 minutes under parallel load. This is why the suite is rarely run
by hand. Not yet investigated.

## Tasks 10-13 are unimplemented

No Windows service bootstrap, gateway join, live verification, or release
certification exists. The `Jarvis/` Obsidian vault at the repository root is
untracked by design; the memory design names it an unsupported source vault
that Jarvis must never write.

## Rate limiting and the circuit breaker are per-isolate

`telegramLimiter` and `providerCircuitBreaker` in `apps/cloud-gateway/src/index.ts`
live at module scope, which survives between requests in ONE isolate.
Cloudflare may run several isolates for one Worker, so the configured 30/min
is a per-isolate 30/min and the breaker sees only its own isolate's failures.
Both belong in a Durable Object -- the mechanism already used for call
sessions -- before either becomes load-bearing.

## The autonomy repository's read-back guards are untested

`isAutonomyTier` and `isAutonomyMode` in `autonomy-repository.ts` validate
values read back out of D1. They are defence in depth against a row that the
CHECK constraints make unwriteable, so a mutant planted in either would
survive the suite. Testing them needs the table rebuilt without its
constraints, which was judged too invasive for what it proves.

## The cloud-gateway tests were never typechecked, and 117 errors remain

`apps/cloud-gateway/tsconfig.json` includes only `src/**`, so `pnpm typecheck`
walked past every test in the app. Vitest transpiles without checking types,
so a test could carry a genuine type error and still run green. Two agents
working in different subsystems hit this independently on the same afternoon,
which is how it was found.

`tsconfig.test.json` now covers the test tree and `pnpm --filter
@jarvis/cloud-gateway typecheck:tests` runs it. It reports **117 errors**, all
in test directories written before it existed: `providers`, `sync`, `voice`,
`policy`, `model`, `security`, `archive`, `conversation`, `calls`, `http`, and
one each in `observability` and `channels`. They are mostly implicit `any` on
callback parameters, casts through insufficiently-overlapping types, and
`string` passed where a branded `Ulid` is required.

It is deliberately NOT wired into CI yet, because it would fail on the first
run for reasons that have nothing to do with the change being tested. The
newer subsystems -- autonomy, decisions, projects, deadlines, scheduler,
digest -- typecheck clean, so the backlog is bounded and does not grow with
new work. Clear it, then make the script a gate.

## Google Classroom due dates: UTC or the course's local day

`classroom-client.ts` converts Classroom's separate `dueDate` and `dueTime`
fields into one instant. The API reference says both are UTC; the project's
own expansion plan assumes local. The two readings differ by four or five
hours in every reminder Jarvis sends -- large enough to matter for a deadline
at 23:59, and systematic enough that nobody would notice it was consistently
wrong.

The documented contract is the default and the alternative is a setting
(`interpretDueFieldsAs`), with both readings under test.
`DEFAULT_CLASSROOM_TIME_ZONE` is a guess about the owner, not a fact about the
API. **Looking at one real assignment with a known due time settles this**,
and until someone does, the reminder times are unverified.

## Nothing moves a deadline out of `open`

`deadlines.status` supports `submitted`, `missed` and `cancelled`, and nothing
sets any of them. A deadline that has passed stays `open` forever. The
grade/missing-work watch described in the plan is what closes this, and it
needs the Classroom grades endpoint and the Brightspace grades scrape.

A deadline that stops appearing in a sweep is deliberately NOT cancelled: a
Brightspace scrape that half-succeeds because the page markup moved returns
fewer items and is indistinguishable from a teacher deleting one. One bad
scrape would cancel a term of real deadlines. It stays open and is reported as
disappeared instead.

## A component that never registers is never watched

`assessLiveness` iterates the rows in `component_liveness`. No row means no
verdict, which means no alert. So if the gateway's heartbeat reporter is
misconfigured from the day it deploys, it returns `not_configured` and only
logs, the table never gains a `cloud-gateway` row, and the watchdog reports
nothing at all about the component it was deployed to watch. Both sides are
quiet and the system looks healthy.

Closing this needs a configured list of components that MUST be present, which
is a decision about what is deployed rather than a bug in the checker. It is
the first thing to add to the watchdog.

## Nothing watches the watchdog

If the watchdog's own cron stops firing, no code is running to notice. Each
cycle writes its own row after the assessment and `GET /health` returns 503
once that row is older than 900s -- **but that only helps if an external
uptime monitor polls it, and no such monitor exists.** Until one does, the
watchdog is unwatched. A second timer inside the same Worker would share the
fate of the first.

The one self-check that does work: because the self-row is written after the
check, a cycle that does run finds its own stale row and alerts. That catches
intermittent cycle failure and can never catch total failure.

## The watchdog's alert path can be configured and still broken

`/health` reports `alert_channel_not_configured` only when settings are
missing. A revoked bot token or a blocked chat produces alerts that are
retried and never delivered while `/health` still reports the channel as
configured.

## One shared heartbeat secret for every component

Anything holding `WATCHDOG_HEARTBEAT_SECRET` can heartbeat as any component
name, including creating new ones and including `watchdog` itself. A
compromised local agent could mask a gateway outage. Per-component credentials
would fix it.

## Two transcribed copies must be kept in step by hand

The watchdog imports nothing from the gateway, deliberately. The cost is that
`apps/watchdog/test/liveness-schema.ts` duplicates `0012_liveness.sql`, and
the wire shape in `apps/watchdog/test/heartbeat.test.ts` duplicates
`heartbeat-reporter.ts`. Both say so in their own comments. Nothing fails
until production does.
