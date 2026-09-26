# Queue

What is in flight, who owns the next action, and what it blocks. Regenerate this
file rather than appending to it. Owner-only actions live in [OWNER-ACTIONS.md](OWNER-ACTIONS.md).

Last regenerated: 2026-09-25, evening (EDT), from `gh pr list`/`gh pr view` on every open and
recently merged pull request and repository history. Heads below are that observation, not a
claim about a later head. Query `git log --oneline origin/main -1` before starting work.

**No deploy since 2026-09-24 ~9:41 PM EDT** (`a7cd3553`, #189, D1 `0045`). 26 PRs have merged to
`main` since, none of it deployed; see [STATE](STATE.md#merged-since-the-deploy-none-of-it-running)
for what each changes. The repository is now **public**; GitHub Actions runs free on standard
runners. **A code-side judgment now blocks merge** (#203, on main) — see [CODE-VS-JUDGMENT](CODE-VS-JUDGMENT.md).

## Open pull requests

**#206 (memory judgment) merged as `fee70510` at 9:03 PM EDT, and #209 (projects judgment) merged
shortly after at 9:09 PM EDT** — both after this file's regeneration started. Both are folded
into [STATE](STATE.md#merged-since-the-deploy-none-of-it-running) and the judgment-removal rows below.

| PR | State / observed head | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#207](https://github.com/stremysid/jarvis/pull/207) calls judgment | open | Review, then merge | reviewer | register rows 1, 3, 4, 5 | Deletes `parseOwnerAccessIntent` and `PERMISSION_CAPABILITIES`; adds an `owner_access` tool the model calls with `{operation, phone, capabilities, pin}`. Row 1 was already dead code after #196; retired in docs only |
| [#212](https://github.com/stremysid/jarvis/pull/212) study coach judgment | open | Review, then merge | reviewer | register batch: study coach | Deletes `parsePracticeRequest`, `parseStudyPreferenceIntent` and `parseOwnerStudyObservation` in `study-coach-model.ts`; the model declares `operation: practice\|preference\|observe` with its own arguments. No migration |
| [#213](https://github.com/stremysid/jarvis/pull/213) university judgment | open | Review, then merge | reviewer | register batch: university (B116–B129) | Deletes the status-word grammars in `university-tracker-model.ts`; the model declares the status enum plus Sid's whole message as `statusEvidence`, and code keeps only the receipt/provenance, id/ownership and date-format checks. No migration |
| [#210](https://github.com/stremysid/jarvis/pull/210) CI offload | open | Review, then merge | reviewer | PC load during builder runs | Adds `workflow_dispatch` jobs (`mutation.yml`, `focused-tests.yml`) so mutation sweeps and focused suites run on Actions rather than Sid's PC; the repo being public makes standard-runner minutes free |
| [#192](https://github.com/stremysid/jarvis/pull/192) filler-words docs | open, docs only | Confirm it does not duplicate the existing [KNOWN_ISSUES row](../KNOWN_ISSUES.md#call-transcripts-are-not-verbatim-deepgram-strips-um-and-uh-2026-09-24), then merge or close | reviewer | none | The same finding (Deepgram strips filler words; ConversationRelay has no passthrough) is already recorded on main; this PR may be superseded |
| [#187](https://github.com/stremysid/jarvis/pull/187) principles rewrite | open, marked "do not merge" pending Sid's deploy in its own body | Recheck against #203 (already merged, "a code-side judgment now blocks merge") and #205 (already merged, moved the judgment rule into `CLAUDE.md`/`AGENTS.md`) before acting; likely partly superseded | reviewer | none | Predates tonight's docs merges; needs a fresh look rather than a blind merge |
| [#185](https://github.com/stremysid/jarvis/pull/185) CI flake bounds | open | Recheck against #208 and #211 (both merged tonight, both Hermes per-test timeout fixes) for overlap, then review the remaining local-agent retry-wait fix | reviewer | CI reliability | May be substantially superseded by #208/#211 |
| [#122](https://github.com/stremysid/jarvis/pull/122) memory redesign spec | reviewer-parked | #174 (its trigger) has now merged; refresh, review and merge | reviewer | none | Docs only |

## Migrations on `main`, not yet applied to production

`0044`, `0047`, `0048`, `0049`, `0050`, `0051`, `0052`, `0053`, `0054` (D1 is at `0045`).
The [2026-09-25 scratch rehearsal](reviews/2026-09-25-scratch-d1-rehearsal.md) (#202) covered
`0044` and `0047`–`0052`, with and without `0051`; **`0053` and `0054` (#201, merged after the
rehearsal) have never been rehearsed.** Before any deploy, rehearse those two the same way.

## Work with no pull request yet

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| Remove the legacy deadline placeholder columns (`due_at`, `effort`, `lead_minutes`) | **open, not started** | `0053_deadlines_store_facts.sql` (merged, #201) added the real nullable `due_date` column and writes placeholders into the old NOT NULL columns, which nothing reads. Dropping them needs a `deadlines` rebuild and the `0027` triggers redone around it | builder | an honest deadline schema |
| Row 10: missed-work inference stays in a model-less cron | **open, deliberately not removed by #204** | Needs a model-write tool plus a migration (`0027` admits only `classification = 'derived'`); deleting the inference alone would drop the digest's missed-work alerts | builder | Phase 3 |
| Rows 14–15 registered by #204's review: `OWNER_ACKNOWLEDGEMENT`, `isBrightspaceRefreshRequest` | **queued, not started** | Delete the acknowledgement regex (a bare "sure" can discard a real tracker update) and give the model a bounded D2L-refresh tool instead of the refresh-request regex | builder | Phase 3 |
| School collector staleness constant (`SchoolCollectorRepository.status`, digest freshness) | **open, not started** | Move the twelve-hour staleness default to an owner or Jarvis-selected setting; `school_d2l_status` already takes `staleAfterMs` as an argument | builder | none |
| Voice: rows 1, 3, 4, 5 | **built in [#207](https://github.com/stremysid/jarvis/pull/207), awaiting review** | See the open-PR table above | reviewer | Sid's rule of 2026-09-25 |
| Memory: rows 6–9, 13 | **merged as [#206](https://github.com/stremysid/jarvis/pull/206); not deployed** | Rows 7, 8 and 13 are fully removed; rows 6 and 9 are narrowed with a named blocker each. **Row 6 blocker:** which inbox items the refile job retries, how many (10) and in what order stay in code — handing them to the model needs a wake-up surface this codebase does not have, and the batch size is the Worker/D1 bound. **Row 9 blocker:** a `0016` trigger still requires `confirmed` when a first-person version's every source is archive-only, so that case is refused by name rather than decided by the model; relaxing it needs a migration, which #206 does not add | — | Sid's rule of 2026-09-25; Phase 2 |
| Projects: eleven staleness judgments | **merged as [#209](https://github.com/stremysid/jarvis/pull/209); not deployed** | `stalled-detector.ts` renamed to `project-facts.ts`; `assessStaleness`/`detectStalledProjects` and their verdict fields are deleted, replaced by `projectFacts()` returning raw facts for the model to judge | — | Sid's rule of 2026-09-25 |
| Study coach: practice/preference/observation parsing | **built in [#212](https://github.com/stremysid/jarvis/pull/212), awaiting review** | See the open-PR table above | reviewer | Sid's rule of 2026-09-25 |
| University: status-word grammars (B116–B129) | **built in [#213](https://github.com/stremysid/jarvis/pull/213), awaiting review** | See the open-PR table above | reviewer | Sid's rule of 2026-09-25 |
| W3/W4 judgment audit batches (school/university/jobs/archive/backup/model/providers/index; local-agent, contracts, scripts, watchdog, hermes) | **never ran** | Continue the [#186](https://github.com/stremysid/jarvis/issues/186) sweep into the areas it never reached; see [CODE-VS-JUDGMENT](CODE-VS-JUDGMENT.md#read-this-before-treating-the-list-as-the-population) | reviewer | a complete removal list |
| #174 round-3 L2: Telegram keyboard payload fields reject staged ids | **open, fail-closed** | In a separate PR, trace staged decision/keyboard fields through redaction validation and delivery. [Known issue](../KNOWN_ISSUES.md#telegram-keyboard-payload-fields-pr-174-round-3-l2) | builder | some confirmation deliveries |
| #171 L2′/L3′/L5/L6 voice streaming follow-ups | **open, low** | Unchanged this round; see [KNOWN_ISSUES](../KNOWN_ISSUES.md#owner-voice-streaming-acceptance-pr-171-2026-09-24) | builder | voice tutoring parity |
| D2L extension host-only failure emission | **not started** | The compatibility hold was deleted by #191 (merged); emitting host-only failures (`course: null`) is separate | extension builder | automatic two-board evidence |
| Confirmations outside Sid's five (forget ≥2 items, guest access phrase grammar, `/call --confirm`, tier-2-while-shadow-on) | **open** | See [KNOWN_ISSUES](../KNOWN_ISSUES.md#confirmations-outside-sids-five-that-migration-0051-does-not-remove-2026-09-25); none of it is changed by `0051` alone | builder | Phase 4 |
| history_search limits: newest messages unindexed, archived call replies below the cursor not backfilled, one call reply cannot be forgotten by id | **open** | See [KNOWN_ISSUES](../KNOWN_ISSUES.md#history_search-limits-2026-09-25) | builder | Phase 2 |
| The operation-coverage test still hand-lists seven memory operations | **half fixed** | In a follow-up, cover the declared union in `test/memory/control-targets.test.ts`. `SUPPORTED_OPERATIONS` in `memory-control-targets.ts` already uses an exhaustive typed map | builder | Phase 2 |
| Suppression predicates remain duplicated outside the retriever | **open** | In Phase 2, review two projection uses in `memory-repository.ts` and migration `0016`'s view; retriever and control finder already share `suppression-clauses.ts` | builder | Phase 2 |
| The model cannot state its own certainty | **decided, not started** | In Phase 2, remove forced `uncertain: true` in `extraction-policy.ts`. Certainty is already absent from `FORBIDDEN_PROPOSAL_KEYS`; keep origin and lifecycle code-assigned | builder | Phase 2 |
| Gateway test typecheck red and outside CI | **awaiting-triage** | 143 as measured 2026-09-24; no new count this round | builder | none |
| Telegram provider clears its abort timer before the body read | **fixed** | Merged as [#181](https://github.com/stremysid/jarvis/pull/181), `68675ba`, and deployed in `a7cd3553`. Removed from this list | — | — |
| Telegram rate limiter and provider circuit breaker are per-isolate | **not started** | Both are module-level instances in `index.ts`; provide shared accounting | builder | none |
| `handleReadiness` has no call sites | **awaiting-triage** | Route or remove the unused export in `http/health.ts` | builder | none |
| Watchdog alerting secrets are undeclared | **not started** | `apps/watchdog/wrangler.toml` still declares no required secrets | builder | Phase 7 |
| Vault sync stops at the first 64 examined notes | **not started** | Persist progress through `vault/reconciliation.py` | builder | Phase 7 |
| T1/T2: `channel_identities` insert and `capability_tiers` update/delete guards | **not started** | Recheck the next free migration number against main and every open PR before adding one | builder | Phase 2 |
| Hermes `artifact-security-review3` timing flake | **open, cause unestablished** | When it next fails in CI, isolate the absolute-cancellation-deadline assertion before attributing it | builder | none |
| Local-agent quarantine lock-contention test is load-sensitive | **open, cause unestablished** | In a focused follow-up, examine the 0.5-second join in `tests/test_quarantine_control.py` | builder | none |
| Failed Telegram reply retry and backup-notice delivery | **open** | Trace the absent scheduled `retry_wait` drain and `MemoryBackupService.alert`'s claim-before-send with empty catch; code evidence, not a fresh production failure | builder | reliable delivery |
| Voice PIN exposure after DO eviction | **unproven older audit premise** | Before building, establish whether eviction loses the relevant in-memory interaction at this boundary | reviewer | none |

## How this file stays true

- A pull request appears when opened and leaves when merged or closed.
- The reviewer updates its verdict when posting one, including the reviewed head.
- Owner-only work belongs in [OWNER-ACTIONS.md](OWNER-ACTIONS.md); cross-references do not duplicate requests.
- Every next action names a trigger; observations are dated, never presented as a moving head.
- `scripts/check-state.mjs` checks carrier format in the advisory `state carriers are honest` CI job.
