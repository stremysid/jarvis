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

| Phase | Verdict | The one thing missing |
|---|---|---|
| 1 The brain | **partial** | Infrastructure is there. The shape is not: a stateless Worker for Telegram and a separate `CallSession` DO for voice, so a capability added to one door does not reach the other. No SMS path, no Queues |
| 2 Memory | **code-complete, unproven** | Schema, promotion fix, core profile, nine tools, expiry and pins all merged and **live as of 2026-09-20**. Production still reads 5 `proposed`, 0 `active` because the fix applies only to facts extracted after the deploy. **The open question is whether real conversation now produces an active fact** |
| 3 School | **works, minus two impossible sources** | Deadlines arrive by D2L notification email. Classroom needs a Cloud Console this board cannot reach; Brightspace exposes no iCal feed. Neither is a gap to close |
| 4 Control | **built as the inverse of what the roadmap asks** | Tiers are a D1 table looked up per capability, not prompt guidance Jarvis judges. Confirmations bind `capability:argumentsHash`, not the tool name, and are never consumed |
| 5 Calling | **plumbing proven, brain missing** | A real call has been placed and worked. The call has **zero tools** and the weaker retriever, so it can talk and cannot act. The release gate has never been run |
| 6 Daily rhythm | **cron only** | Four cron triggers fire. Jarvis cannot schedule its own wake-ups — no DO holds conversation state to hang an alarm on — and does not choose the digest time |
| 7 Plumbing | **most complete** | Nightly backup, archive and the watchdog all run. **The heartbeat records as of 2026-09-20.** No external watchdog; vault sync stops at 64 notes |

Measured against the phases in
[`plan/2026-09-19-jarvis-roadmap.md`](plan/2026-09-19-jarvis-roadmap.md).

## The one thing that changes what Jarvis is

**The voice channel has no tool dispatch.** `apps/cloud-gateway/src/voice` contains
no tool, function-call or tool-call reference at all, while the Telegram path has
nine tools. A deployed R1 today is a phone call that can talk and cannot act.

R1's exit test does not require a tool, which is why both statements are true:
v1.0-as-written is configuration-blocked, and v1.0-as-the-owner-means-it needs the
tool-calling agent composed into `CallSessionCore`.

## Production

**Observed directly on 2026-09-20**, not relayed — a session with `wrangler`
applied the migration and deployed:

- Worker `74f2a003-cd87-4eee-a359-222b07c1db0b`, deployed 2026-09-20.
- Watchdog `c940f9b7-99cf-4194-8f41-489038a34139`, same evening.
- **D1 at migration `0038`.** Verified by querying `d1_migrations`, and the three
  objects it creates exist.
- **The gateway heartbeat records.** `component_liveness` holds `cloud-gateway`
  at `2026-09-20T23:10:06.810Z`. Every cron before this deploy logged
  `status 404`; it had never once been recorded. The fix needed a redeploy to
  prove and the redeploy proved it.
- Memory: **5 `proposed`, 0 `active`**. The promotion fix is live but applies only
  to facts extracted after the deploy — it does not reach back for the five.

Re-query rather than trusting these; they were true at 23:10 UTC on 2026-09-20.

## The gates, and whether they can be trusted

| Gate | State |
|---|---|
| CI | **Dead since 2026-09-12** (billing), resets 2026-10-01. Every push since is red in 5–11 s |
| `pnpm test` | **5,395 tests**, 0 skipped. **`testTimeout` is 15s** as of #116 — sized against a measured p99 of 5,247 ms and a worst unprotected test of 7,217 ms, so a timeout is now a signal rather than the machine's load. One file still roams: `owner-telegram-agent.test.ts` has gone green then red on trees differing only in a log entry |
| `pnpm typecheck` | Clean |
| `pnpm --filter @jarvis/cloud-gateway typecheck:tests` | **144 errors in 32 files**, gated nowhere |
| `pnpm lint` | Exit 0, but four packages define it as `tsc --noEmit`; no linter is reachable |
| Voice release chain | `test:voice-access`, `test:voice-smoke`, `release:voice-gate` exist and appear in **no workflow** |

**Consequence, stated plainly: a green local run may not be banked, and a red one
cannot be attributed.** Until that changes, nothing may be merged on the strength of
a local run alone.

## Live defects

Verified 2026-09-18, re-checked against `main` on 2026-09-20:

1. ~~`/shadow off` claims a control with no caller~~ — **closed** by #106.
2. ~~Forgetting has a back door through distillation~~ — **closed** by #110.
3. **A four-digit PIN is not redacted**, nor a spoken-word PIN, a phone number, or
   a token on the line after `Authorization:`. Confirmed by executing
   `sanitizeRedaction`. The test that appears to cover it asserts against
   `guest.pin`, a field no production call site passes. PR #96 fixes the digit
   half only.
4. `explain` / `forget` / `restore` print the memory text in the same tool result
   that says it was withheld.
5. `selectControlTargets` reads `memory_item_fts` with no suppression anti-join,
   and that index has no delete trigger.

Items 4 and 5 are in [QUEUE.md](QUEUE.md). `KNOWN_ISSUES.md` is **not** a reliable
companion here: it is 1,145 lines and still describes shipped work as open.

## Where things live

| Question | File |
|---|---|
| What is in flight, and who acts next? | [QUEUE.md](QUEUE.md) |
| What can only Sid do? | [OWNER-ACTIONS.md](OWNER-ACTIONS.md) |
| Why is it built this way? | [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](../DECISIONS.md) |
| What is broken or unproven? | [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) |
| What stopped working and why? | [AGENT_LOG.md](AGENT_LOG.md) — **search it, do not read it** |
| What is meant to exist? | [the roadmap](plan/2026-09-19-jarvis-roadmap.md) — **Sid's own, and authoritative.** The 2026-09-03 milestone roadmap is superseded |
| Who builds and reviews what? | [BUILDING.md](BUILDING.md) |
