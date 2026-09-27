# State

What is true right now. **Short on purpose, and regenerated rather than appended.**

One rule governs every line below: **nothing here states a revision as current.** A fact that
depends on a revision carries the command that prints it, or a date and the session that
observed it. If this file disagrees with a longer document, this file is right and the longer
document is stale — say so in the pull request that fixes it.

Last regenerated: 2026-09-27, from the code in a worktree at the tip of the default branch —
run `git log --oneline origin/main -1` for the revision now. Production claims carry a date and
a source; **this session queried nothing in production, and this repository holds no production
observation later than 2026-09-25.**

## What is deployed, and what is only in the code

**The last recorded deploy is from the night of 2026-09-24.** Sid reported his `wrangler`
output; the records are in [OWNER-ACTIONS](OWNER-ACTIONS.md#deploy-results-2026-09-24-evening)
and in [Production](#production) below.

**Reviewed code has merged since that deploy and is not in it**, and no carrier carries a
deploy record after 2026-09-24. Checked per merge with
`git merge-base --is-ancestor <merge> <deployed revision>`: the channel-parity merge, the
five-action confirmation merge, owner reminders, history search, the web tools, the owner email
inbox, "stop hiding Sid's own data from Sid", the deadline judgment removal, the call PIN and
the memory-wording batch are **on the default branch and not in the last recorded deploy.**

Two consequences are load-bearing and are why this section is first:

- **The deployed revision still has the guest-call privacy leak.** The channel-parity merge is
  the fix and it is not in that deploy, so either no deploy has happened since 2026-09-24 — the
  leak is live — or one has and nobody recorded it. **Do not assert production is fixed without
  a recorded deploy revision.** On the revision deployed, `OwnerAgentCore.streamCaptured` reads
  Sid's pinned core profile, owner prompt and owner catalogue before the tool-authority check
  sees the principal, so a guest call carries owner material to the model. See
  [KNOWN_ISSUES](../KNOWN_ISSUES.md#guest-call-privacy-leak--fixed-in-code-live-in-the-last-recorded-deploy).
- **Several merged features cannot work until their migrations are applied, and D1 is recorded
  at `0045`.** `0047`–`0056` are on the default branch and not in any recorded application.
  These are additive and fail closed, but the failure is silent-by-design rather than loud: the
  web tools need `0049`'s `read.web` row before the tier gate will let them fetch; the history
  indexer needs `0048`'s recreated trigger or nightly consolidation refuses by name. See
  [Pending rollout](#pending-rollout).

## Where the project actually stands

Verdicts are about the **code as of 2026-09-27**, not about what is running. Which is which is
the section above.

| Phase | Verdict | The one thing missing |
|---|---|---|
| 1 The nervous system | **one brain in code; separate state** | Every owner tool reaches both channels from one catalogue and both adapters drive the same loop, caps, tier gate and receipt guard. `OWNER_TOOL_DEFINITIONS` in `agent/owner-tools.ts` holds **35** entries, measured 2026-09-27 by importing it; count it again rather than carrying this number forward. Telegram is still a stateless Worker and voice a `CallSession` Durable Object, so there is no shared conversation state, no SMS path and no Queues |
| 2 Memory | **one store, one reader, one writer on both channels** | Both channels retrieve canonical `memory_items`, projected facts and bounded D1/R2 history through the same reader; a call acts on the same store Telegram writes. The model now states its own basis, filing confidence, excerpt and target rather than code inferring them. **Open:** the receipt path can still reintroduce suppressed text (see [Live defects](#live-defects)), and the `memory_fact_projection_*` tables that a call used to read have no writer in any channel |
| 3 School | **evidence and planning on both channels; the last mile is the collector** | Telegram assignment pastes, the private calendar feed, owner-reported deadlines, guided assignment, the receiver and the two-board fixes are all on the default branch. `school_work_evidence` and `study_coach` are model tools. **Missing:** the D2L extension's compatibility hold is deleted but host-only failure emission is not built, so a whole-read report cannot yet say which host failed. Owner acceptance of every school route is in [OWNER-ACTIONS](OWNER-ACTIONS.md) |
| 4 Control | **five actions, bound and single-use — in code** | Tier 3 is exactly Sid's five: spend money, send an email, place a call, submit school work, contact a third party (`0051`, `capability_tiers`). Confirmations bind to tool name, capability and argument hash, a changed second outcome is denied, and a tap is single-use with a ten-minute expiry. **Missing:** the migrations are recorded as unapplied, so the deployed tier list is whatever `0038`/`0039` left and `KNOWN_ISSUES` still lists the four asks `0051` removes |
| 5 Calling | **owner-reported working; release gate never run** | Calls dispatch the full owner catalogue, a tier-3 action on a call asks for the spoken or keyed PIN, and streaming speaks sentence-by-sentence behind the receipt check. **Missing:** `test:voice-access`, `test:voice-smoke` and `release:voice-gate` still appear in **no workflow**, and no outbound call has ever been placed |
| 6 Daily rhythm | **cron plus model-chosen reminders** | Four crons fire: `*/5` drain, hourly poll, and a twice-daily pair for the 07:30 local digest and the 19:30 local night run. The model schedules its own Telegram messages with `reminder_schedule` / `reminder_list` / `reminder_cancel`, choosing both the instant and the words, and the `*/5` drain delivers them. **Missing:** the digest hour is still code-chosen, and there is no wake with no pre-written message — "wake me at T and I decide then" — which is a new capability rather than a repair |
| 7 Plumbing | **most complete** | Nightly backup, archive, the heartbeat and the watchdog all run; the archive is fed by the hourly `poll` job, which constructs the archival service itself. **Missing:** no external uptime monitor, `jarvis vault sync` still stops at the first 64 examined notes with no persisted position, and the watchdog declares none of its alerting secrets so a misconfigured one deploys fine and cannot alert |

Measured against [the roadmap](plan/2026-09-19-jarvis-roadmap.md).

## The one thing that changes what Jarvis is

**Both doors now reach one brain, and the state behind them is still two.** Sid's rule of
2026-09-23 is *"THE ONLY difference between call and telegram is the method of communication,
THAT'S IT"*, and the code has moved most of the way: one catalogue, one loop, one prompt core,
one claim policy, one canonical recall, the same Telegram tap for a tier-3 confirmation.

| | Telegram | Phone call |
|---|---|---|
| Agent loop | `OwnerAgentCore` + `OwnerTelegramAgentAdapter` | `OwnerAgentCore` + `OwnerVoiceAgentAdapter` |
| Tools | 35, from one catalogue | the same 35 |
| Memory it acts on and recalls | `memory_items`, projected facts and bounded literal history | the same store and the same reader |
| A tier-3 action | an inline-keyboard tap, single-use, ten minutes | the spoken or keyed PIN at that moment; a tap already given for the same action still counts |
| Conversation state | none held; the Worker is stateless | a `CallSession` Durable Object |

What is not collapsed is the transport: two composition sites, two places that hold (or do not
hold) the conversation. That is Phase 1's missing piece, and it is builder work.

## Production

**Read directly on 2026-09-27 through read-only `wrangler d1 execute --remote` against the
`jarvis` database.** Same credentials the deploy uses; no write was issued, and every value
marked *(queried)* below is from that session rather than from somebody's report.

| Item | Record |
|---|---|
| **Deployed version** | `d69bd158-3d1b-4a67-a359-f561ebbd0908`, created **2026-09-25T01:41:33Z**, at 100% — the newest deployment the account shows *(queried)*. First independent check of the recorded release |
| **Memory items** | **8, all `proposed`, 0 `active`**; newest created `2026-09-26T02:00:13Z` *(queried)*. Supersedes the 2026-09-21 observation of 5 |
| **Why none is `active`** | `memory_item_transitions` holds **8 rows, every one `reason = "model inference awaits owner confirmation"`**, and none reading `"exact authenticated first-person evidence"` *(queried)*. The automatic promotion gate has never once passed |
| **Extraction is running** | `memory_cost_ledger` holds 48 entries, oldest `2026-09-17T01:00:17Z`, newest `2026-09-26T23:31:26Z` *(queried)* — so the API key is set and the model is being paid for |
| **Distillation is not stuck** | cursor 303, highest event sequence 331, `sealed_through` 0 *(queried)*. Nothing sits between them: newest event at or below 303 is `2026-09-26T01:13:31Z` and the oldest above it is `2026-09-27T01:21:39Z`. The 28 newer events are one conversation the next hourly run will take |
| **Retrieval by meaning is empty** | `memory_retrievable_item_versions` holds **0** rows while `memory_item_fts` holds 8 *(queried)*. Keyword recall can still reach a `proposed` item; anything reading the active-only view cannot |
| Migrations | `0040`, `0043`, `0045` applied 2026-09-25 01:40:48–49 UTC, per the owner's report; **not re-queried** |
| Watchdog | version `3018f5fd-7f5f-4192-9c23-496718aedbef`; rollback `c940f9b7-99cf-4194-8f41-489038a34139` — owner's report, **not re-queried** |

**Not true of production, and previously claimed here:** no merge after 2026-09-24 is in that
revision (checked per merge with `git merge-base --is-ancestor`), and no migration above `0045`
is in any recorded run.

**Older observations from 2026-09-21, still not refreshed:** `memory_fact_projection_facts` held
0 rows; `d2l_email_messages` was empty; 6 inbound owner calls, all 2026-09-17, no outbound ever.

## Pending rollout

Read this with the migrations directory in front of you, not from memory. On the default branch
and absent from every recorded application: `0047`–`0056`; `0036`, `0037`, `0041` and `0042` are
absent from the tree entirely. Applying anything is Sid's action; the order and the pre-checks
are in [OWNER-ACTIONS](OWNER-ACTIONS.md#waiting-on-sid).

## The gates, and whether they can be trusted

| Gate | State |
|---|---|
| CI | Green on the default branch for the tip merge (#219) on 2026-09-27; **a cancelled run is not a failure** — one concurrency group per branch means a newer push cancels an older run. Query the head you are about to clear |
| Workspace suite | No full suite was run for this regeneration, and no permanent count belongs in a carrier: run `pnpm test` and read its own total. The three historically flaky cases named here before are now bounded by merged test changes (#154, #185) |
| `pnpm typecheck` | **Clean**, measured 2026-09-27 in a worktree at the default-branch tip |
| `pnpm --filter @jarvis/cloud-gateway typecheck:tests` | **149 errors in 32 files**, measured 2026-09-27 on the same tree; still red and gated nowhere. It has grown from the 143 last recorded, which is what a red gate nobody runs looks like |
| `pnpm lint` | Exit 0, but several packages define it as `tsc --noEmit`; no linter is reachable |
| Voice release chain | `test:voice-access`, `test:voice-smoke`, `release:voice-gate` exist and appear in **no workflow** |
| `pnpm run check:state` | Passes with one `::warning` — one `FACTS.md` row marked unconfirmed needs re-verification. The job is advisory; the default branch does not require it |

A runner timeout is not an operation deadline: raising `testTimeout` does not stop a 450 ms
retrieval deadline from firing under load. Re-run a failing file **alone** before blaming it,
and merge on the reviewed head's CI evidence.

## Live defects

1. **The guest-call privacy leak is live in the last recorded deploy** and fixed only in code.
2. **The memory receipt path can reintroduce suppressed text.** `explain` in
   `owner-agent-core.ts` re-reads the item with `readCurrentItem` and appends its wording to a
   receipt whose service-side text was suppressed on purpose (`redactUnretrievableItem`); **no
   agent-level test covers the suppressed case** — the only test that does sits at the service
   boundary, which is where the defect is not.
3. **Redaction gaps remain by design toward Sid and by omission elsewhere:** a bare or spoken
   PIN, a phone number and the owner passphrase have no rule. Sid's decision of 2026-09-24 is
   that nothing is hidden from him, so the redactors serve readers who are not Sid. Bare
   four-digit numbers deliberately survive.
4. **A four-digit PIN after a credential word is redacted on every channel** (#149), live in the
   last recorded deploy.

## Where things live

| Question | File |
|---|---|
| What is in flight, and who acts next? | [QUEUE.md](QUEUE.md) |
| What can only Sid do? | [OWNER-ACTIONS.md](OWNER-ACTIONS.md) |
| What durable facts are recorded? | [FACTS.md](FACTS.md) |
| What is broken or unproven? | [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) |
| What stopped working, and why? | [AGENT_LOG.md](AGENT_LOG.md) — search it, do not read it |
| Which judgment is still in code? | [CODE-VS-JUDGMENT.md](CODE-VS-JUDGMENT.md) |
