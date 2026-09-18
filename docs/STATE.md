# State

What is true right now. **Short on purpose, and regenerated rather than appended.**

One rule governs every line below: **nothing here states a revision as current.** A
fact that depends on a revision carries the command that prints it, or a date and
the session that observed it. The handoff, the roadmap and this file have each, at
different times, asserted a sha that had already moved; the fix is to stop writing
them down.

If this file disagrees with a longer document, this file is right and the longer
document is stale — say so in the pull request that fixes it.

Last regenerated: 2026-09-18, by a builder session, against the revision printed by
`git log --oneline origin/main -1`. Regenerate it; do not append to it.

## Where the project actually stands

| Milestone | Verdict | The one thing missing |
|---|---|---|
| R0 Green and deployed | **UNMET** (declared passed 2026-09-11) | CI is red and cannot go green before 2026-10-01, and the watchdog has never recorded a gateway heartbeat. The heartbeat clause was removed from the exit test rather than met |
| R1 Phone Jarvis from the car — **v1.0** | **UNMET** | No real call has ever been placed; the release gate is built to fail until one is. The code path is wired and switched off by missing secrets |
| R2 Cloud memory with every PC off | **UNMET** | Distillation, recall and meaning search all run; production has published **0 active facts** (36 runs, 5 items, all `proposed`) |
| R3 Hands: device control | **UNMET** | Not started. No command route to any machine exists |
| R5 School and university | **UNMET, exit test unsatisfiable as written** | Names a Classroom deadline and a Brightspace deadline. Neither can be obtained on this board — see `docs/runbooks/` and PR #105 |
| R5A Proactive study coach | **UNMET** | Answers when asked and rides the morning digest; it never initiates |
| R7 Assistant manager | **UNMET** | Not started |

Measured against each milestone's own exit test in
`docs/plan/2026-09-03-jarvis-roadmap.md` §7. Source: the 2026-09-18 sweep, which
found every claimed capability by symbol and then checked for a production caller.

## The one thing that changes what Jarvis is

**The voice channel has no tool dispatch.** `apps/cloud-gateway/src/voice` contains
no tool, function-call or tool-call reference at all, while the Telegram path has
nine tools. A deployed R1 today is a phone call that can talk and cannot act.

R1's exit test does not require a tool, which is why both statements are true:
v1.0-as-written is configuration-blocked, and v1.0-as-the-owner-means-it needs the
tool-calling agent composed into `CallSessionCore`.

## Production

`[R]` **Relayed, never observed here.** No session has `wrangler` credentials, so
these are the last figures a session with access reported, and they are the least
trustworthy lines in this file:

- Worker version `555c1414`, deployed 2026-09-18.
- D1 at migration `0034`. Two older documents say `0032` and `0015`; both are wrong.
  **One read-only query of `d1_migrations` settles it permanently.**

## The gates, and whether they can be trusted

| Gate | State |
|---|---|
| CI | **Dead since 2026-09-12** (billing), resets 2026-10-01. Every push since is red in 5–11 s |
| `pnpm test` | 199 files, 5,342 tests, **0 skipped — and unattributable**: three runs gave 12, 8 and 3 failures with no name repeated. No `testTimeout` is configured |
| `pnpm typecheck` | Clean |
| `pnpm --filter @jarvis/cloud-gateway typecheck:tests` | **144 errors in 32 files**, gated nowhere |
| `pnpm lint` | Exit 0, but four packages define it as `tsc --noEmit`; no linter is reachable |
| Voice release chain | `test:voice-access`, `test:voice-smoke`, `release:voice-gate` exist and appear in **no workflow** |

**Consequence, stated plainly: a green local run may not be banked, and a red one
cannot be attributed.** Until that changes, nothing may be merged on the strength of
a local run alone.

## Live defects

Three, all verified on 2026-09-18 and all still present at the time of writing:

1. `/shadow off` tells the owner *"tier 3 still asks first"*, and `AutonomyService`
   has zero callers. The test asserts the sentence, not the control. PR #106 wires it.
2. Forgetting has a back door: automatic distillation has no suppression predicate,
   so a forgotten turn can be distilled into a fresh, retrievable memory. Hourly.
3. A four-digit PIN and the owner passphrase match no redaction rule, and the test
   that appears to cover it asserts against a field no production call site uses.

Full list, including the four smaller authority gaps, in `KNOWN_ISSUES.md` and the
2026-09-18 sweep report.

## Where things live

| Question | File |
|---|---|
| What is in flight, and who acts next? | [QUEUE.md](QUEUE.md) |
| What can only Sid do? | [OWNER-ACTIONS.md](OWNER-ACTIONS.md) |
| Why is it built this way? | [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](../DECISIONS.md) |
| What is broken or unproven? | [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) |
| What stopped working and why? | [AGENT_LOG.md](AGENT_LOG.md) — **search it, do not read it** |
| What is meant to exist? | [the roadmap](plan/2026-09-03-jarvis-roadmap.md) — a plan, not a status |
| Who builds and reviews what? | [BUILDING.md](BUILDING.md) |
