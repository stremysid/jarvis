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
