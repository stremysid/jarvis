# Known issues

## R0 CI corrections pass locally; remote CI remains unverified

Three jobs fail, none for a product defect. Each is a test encoding an
assumption about the machine it runs on:

- `local-agent (ubuntu-latest)`: mypy reports Windows-only symbols
  (`ctypes.get_last_error`, the pipe server's Win32 calls) as missing.
  TESTING.md already notes a Linux run would need `--platform win32`.
- `local-agent (windows-latest)`: `test_the_pipe_is_not_readable_by_everyone`
  asserts the raw SID of the current user appears in the pipe's DACL. The
  GitHub runner is the built-in Administrator, whose entry reads back as the
  `LA` alias, so the assertion fails on a DACL that is in fact correct.
- `hermes-runtime suite (windows)`: `workflow-containment-review5.test.mjs`
  rejects the runner's temp directory because the path contains an 8.3 short
  name (`RUNNER~1`).

Commit `d9d59f9` corrects these three assumptions locally. It uses a Windows
mypy target, normalized DACL trustees with an independent reference pipe,
and native canonical temp parents. A real 8.3 alias is rejected while its
canonical path is accepted; `Assert-LiteralRuntimeRoot` is unchanged.
Remote CI on the fix has not been verified, so item 1 is not closed yet.

## The local agent does not typecheck or fully test on Linux

On Linux, `mypy` reports 25 errors across `crypto/dpapi.py`,
`transport/pipe_server.py` and `vault/setup.py`, and three vault tests fail
(`test_cli.py::test_the_guard_against_touching_the_real_profile_is_actually_watching_something`,
`test_setup.py::test_a_path_inside_the_seed_vault_is_refused_too`,
`test_setup.py::test_the_preferred_root_is_the_profile_known_folder`). All
depend on Windows known folders or Win32 APIs. `d9d59f9` now targets Windows
for mypy, skips the live Windows-profile guard on Linux, and constructs
portable paths in the other two vault tests. The Windows full suite passes
locally; the changed Linux job still needs remote CI evidence.

## `README.md` says vector search; the vector is not semantic

The embedder in `memory/embeddings.py` is a hashed lexical feature vector
and says so in its docstring. The vector index it feeds is never consulted
by retrieval, which is full-text only. Replacing the embedder with a pinned
real model is milestone M2.

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
roughly 50 minutes under parallel load. They now run in the manual
**Hermes extended tests** workflow, each in its own Windows job, and are
excluded from regular CI. The runtime cause is not yet investigated, and
the full extended suites have not been run for the R0 correction.

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

## The named pipe's DACL is proven against anonymous, reasoned about for a second user

`transport/pipe_server.py` builds an explicit security descriptor, because
the default is genuinely unsafe: a pipe created with a null descriptor reads
back granting FILE_GENERIC_READ to Everyone and Anonymous.

Two separate things are measured. That the descriptor is **applied** -- read
back off the live handle, with a default-descriptor pipe created alongside as
a control, since asserting `WD` is absent proves nothing until the same
instrument has been shown finding it present. And that it is **enforced** --
an anonymous-impersonation knock opens the default pipe and is refused by the
restricted one. A DACL that is present but never consulted passes the first
and fails the second.

**What is not established: that a second logged-in Windows user is refused.**
That principal cannot be created without changing the machine. It is denied
by the same DACL through the same access check that demonstrably refuses
anonymous, but that step is reasoned rather than measured.

## `service.py` has no process bootstrap

`RunLoop`, `ServiceState`, `control_handlers` and
`NamedPipeServer.serve_forever` exist and are tested, and nothing starts them.
There is no `jarvis service` command and no Windows service host. That is
Task 10 of the release plan, and wiring `EventReplicator`,
`DistillationCoordinator` and the device keys together needs the deployment
decisions that task carries.

## Vault observations are NOT upload-ready: no redactor runs

This is the most important gap in the vault adapter. `RedactionV1` is always
`status="none"` with no markers, and note text is stored verbatim. The design
requires the foundation classifier and redactor to run over every observation
and to REFUSE a note whose secrets it cannot remove.

It is safe today only because there is no sync client: nothing uploads a
vault observation anywhere. **Building the upload path before the redactor
would ship the owner's notes to the gateway unredacted.** The redactor is a
prerequisite for O2/O3/O4, not a follow-up to them.

`display_label` has the same status: it is guaranteed not to be path-shaped,
which is not the same as being redacted.

## Vault write-once is create-new-only, not fenced

`O_EXCL` is a real kernel guarantee that no existing file was overwritten.
It is not the plan's guarantee. Specifically:

- It does not guarantee the file landed in the directory that was validated.
  A junction swapped in between the containment check and `os.open` redirects
  it. There are no retained handles, so **every location check is
  time-of-check-to-time-of-use**: the Git, cloud-sync, reparse and drive-type
  checks describe the filesystem at the instant `inspect()` returned.
- There is no no-delete-sharing fence, so another process can delete or
  rename a published file between creation and receipt.
- Torn-read detection is stat-bracketing (size, mtime_ns, file index, before
  and after) rather than a share-mode fence plus USN validation. A writer that
  completes wholly between the two stats with all three unchanged is
  undetectable.
- Projection recovery matches by content hash, because no object identity is
  available. A pre-existing byte-identical file would be adopted as the
  operation's output.

All of these close when the Rust/PyO3 bridge lands. Until then the adapter
meets a weaker guarantee than the plan states, and it must not be described
as meeting the plan's.

## Vault: no USN journal, so every sync is a full walk

No watcher, no generations, no lower/upper watermarks, no durable change
hints, no replay. A rename is always tombstone-plus-new-document -- the plan's
fallback, never its file-identity path. Root identity is `st_dev:st_ino` from
`os.stat` rather than a 128-bit NTFS file id from a held handle, so
`jarvis vault doctor` can NOTICE a moved or replaced root. Noticing is not
preventing.

## Vault: `project()` has no authority gate

The write path exists and nothing but tests calls it. There is no
`VerifiedExportDecision`, no active-fact recheck and no capture decision in
front of it. Wire a caller to it and facts reach the vault unauthorized.

## Vault: NTFS enforcement is Windows-only, cloud-sync detection is heuristic

Off Windows the filesystem probe reports nothing and the policy accepts the
root. Cloud-sync detection uses directory names, marker files and environment
variables -- there is no Cloud Files placeholder or reparse-tag check, so a
renamed sync folder or an unlisted client is not detected.

## Vault: a file Jarvis published is re-observed as user-authored

Origin is always `user_authored`. The models and schema enforce that a
`jarvis_projection` observation must cite a receipt, so nothing states a
falsehood -- but the reconciler does not consult the receipt store, so
Jarvis's own notes come back through reconciliation attributed to the owner.
