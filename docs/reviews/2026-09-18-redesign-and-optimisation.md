# Redesign and optimisation report

**Date:** 2026-09-18 · **Measured at:** `main` = `5a8acf3` (pre-transfer)
**Basis:** the five-workstream sweep (`sweep-1`…`sweep-5`), plus first-hand
verification of every item marked `[M]` below.
**Status:** proposal. Nothing here is applied unless a later section says so.

**How to read this.** Every item gives the evidence, the change, where it goes, how
to verify it, and what it costs. `[M]` means the author verified it first-hand;
`[R]` means it is relayed from a document or another session and should be
re-checked before acting. Effort is a builder-session estimate, not a promise.

**Already delivered:** `docs/STATE.md`, `docs/QUEUE.md`, `docs/OWNER-ACTIONS.md` and
two checker scripts (PR #107); `docs/REVIEW-PROTOCOL.md` (PR #108).

---

## 1. The ranked list

| # | Item | Impact | Effort | Risk if not done |
|---|---|---|---|---|
| ~~A1~~ | ~~`/shadow off` claims a safety control that has no caller~~ **CLOSED by #106** | — | done | — |
| ~~A2~~ | ~~Distillation re-ingests forgotten turns, hourly~~ **CLOSED by #110** | — | done | — |
| A3 | 4-digit PIN and passphrase match no redaction rule | **High** | 2 h | A spoken secret is stored verbatim |
| D1 | Voice has no tool dispatch | **High** | 1–2 sessions | v1.0 is a chatbot; the owner's actual goal |
| E1 | Suite failures are unattributable (5 s timeouts) | **Highest remaining** | 30 min | No gate can be trusted. **CI is alive again as of 2026-09-19**, so this now gates real merges rather than a dead pipeline |
| E6 | Python tests failing in CI, cause unknown | High | ? | Unknown breakage on the local agent |
| B1–B4 | Four authority holes in the tier-3 confirmation path | Medium | 3 h | Becomes high the day email lands |
| A4–A7 | Four smaller authority/observability gaps | Medium | 3 h | Silent leaks and unguarded paths |
| C1 | 10 modules (2,114 lines) only their tests import | Medium | 2 h | Presence read as delivery |
| D2 | Voice uses the weaker retriever | Medium | 2 h | The car gets worse memory than the phone |
| E2–E4 | `lint` is not a linter; 144 ungated type errors; voice chain unwired | Medium | 3 h | Gates that do not gate |
| F1–F3 | Six concurrent suite runs saturate the disk | Medium | 30 min | Owner's machine unusable while agents work |
| C2–C4, G3 | Orphans, unrouted readiness, log rotation | Low | 2 h | Accumulating confusion |

Order of work is in §8. Sections 2–7 give the implementation.

---

## 2. Live defects — fix first

### A1. A live command reassures the owner about a control that does not exist

> **CLOSED by [#106](https://github.com/stremysid/jarvis/pull/106), merged 2026-09-18.** `AutonomyService` is constructed at `index.ts:305` and `OwnerTelegramAgentAdapter` gates tool calls on it. The evidence below was true at `5a8acf3` and is kept for the record; do not re-report it.
**Evidence `[M]`** `apps/cloud-gateway/src/channels/telegram/command-handler.ts:179`
answers `/shadow off` with *"Shadow mode off. Tier-2 actions run; tier 3 still asks
first."* `AutonomyService.evaluate` has **zero callers** in `src`. The test at
`test/channels/command-handler.test.ts:311` asserts the **sentence**
(`expect(said).toContain("tier 3 still asks first")`), so deleting every call site
leaves it green.

**Fix.** Two parts, and the first must not wait for the second.
1. **Today, 10 minutes:** change the string to what is true — tier 3 is *not* yet
   enforced; say so — and change the test to assert that sentence instead. Ship in
   its own PR; it is a text change and a test that would now fail if someone
   restored the old claim.
2. **Then:** PR #106 wires the gate and makes the original sentence true. Once it
   lands, restore the sentence *and* add a test that fails when the gate is removed
   — the honest version of the test that exists today.

**Verify.** Delete `gateTool(...)` from `executeCall`; the suite must go red. Today it
stays green.

### A2. Forgetting has a back door, and it runs hourly

> **CLOSED by [#110](https://github.com/stremysid/jarvis/pull/110), merged 2026-09-18.** The hourly distillation path now honours the suppression ledger. The evidence below was true at `5a8acf3`; do not re-report it.
**Evidence `[M]`** `apps/cloud-gateway/src/memory/automatic-distillation.ts` contains
**no suppression reference at all**. Eligibility is
`envelope.subjectId === principalId && payload.historyEligible` (`:422`), with no
anti-join against `memory_active_event_suppressions`. Forgotten text is shipped to
the model as prompt material and a fresh memory can be minted from it — with a new
creation event, so nothing suppresses the result.

**Fix.** Copy the predicate two other retrieval paths already carry. In
`telegram-memory-retriever.ts#readCandidates` the pattern is a
`NOT EXISTS (SELECT 1 FROM memory_active_event_suppressions …)` over the event id.
Apply it to the distillation reader so a suppressed turn is never *eligible*, and
additionally refuse at commit time — a suppression check inside `commitInput`'s write
path, so a future reader that forgets the join still cannot mint a memory from
suppressed text.

**Verify.** Two tests, both of which must fail without the fix:
1. establish a memory, `/forget` it, run one distillation cycle, assert no new memory
   cites the suppressed turn;
2. assert the distillation *prompt* never contained the forgotten text — the leak is
   upstream of storage.

**Risk.** This is the highest-severity item in the report. It silently defeats the
one promise the memory design is built on, on a timer.

### A3. A four-digit PIN and the owner's passphrase match no redaction rule
**Evidence `[M]`** `packages/contracts/src/calls.ts`: `AUTHENTICATION_DIGITS` is
exactly six (`:7`), the contextual rule exactly eight, and `CREDENTIAL_ASSIGNMENT`
(`:11`) lists `api key|password|client secret|access token|token|secret` — **`pin` is
not among them**. The test named *"redacts a four-digit voice PIN by field
context…"* passes against field `guest.pin`, which **no production call site uses**;
they pass `conversation.turn.text`. Also absent in both runtimes: any phone-number
rule. And `"Authorization: Bearer\nsecret-token-value"` survives because
`AUTHORIZATION_HEADER` runs before `BARE_BEARER` and stops at the newline.

**Fix, in this order.**
1. Add `pin`, `passphrase`, `passcode` and `code` to `CREDENTIAL_ASSIGNMENT`, with
   digit-count-independence, so a *contextual* four-digit value is redacted.
2. Widen `AUTHENTICATION_DIGITS` to `\d{4,}` **only where context permits** — a bare
   four-digit number is a year, a quantity, a time; the contextual rule is the right
   instrument, not the bare one.
3. Add a phone-number rule (`+1`, `(xxx)`, `xxx-xxx-xxxx`) in both runtimes.
4. Make `AUTHORIZATION_HEADER` and `BARE_BEARER` operate on a normalised line, or run
   `BARE_BEARER` first, so a newline cannot break the pair.
5. **Re-aim the existing test at `conversation.turn.text`.** A test asserting the
   right behaviour on a field nothing uses is worse than no test, because a reviewer
   cites it to close the question.

**Verify.** A differential table of at least 40 cases — including `my pin is 4821`,
`the code is 4821`, a bare `4821`, `+1 555 0100`, both bearer forms with and without
a newline — run against **both** the TypeScript and Python implementations, asserting
**zero** differences. The existing 44-case differential proves the harness works; it
simply does not cover these classes.

### A4. `explain` / `forget` / `lift` state that they withhold text, and include it
**Evidence `[M]`** those tool results read the memory item raw and append
`item.version.text`, so the result says *"without revealing its text"* **and contains
it**. The service is correct; the wrapper is the defect.

**Fix.** Build those results from a redacted projection — the item's state, ids and
counts, never `version.text`. One helper, three call sites.

**Verify.** A test per tool asserting the returned payload does not contain the
remembered string, driven through the real agent adapter.

### A5. One production query reads forgotten text
**Evidence `[M]`** `selectControlTargets` has no suppression anti-join, and
`memory_item_fts` has no delete trigger.

**Fix.** Copy the anti-join from `readCandidates`, 40 lines away. For FTS, either add
the trigger or make the search path join the suppression ledger — the latter is
cheaper and matches the other paths.

**Verify.** A forgotten item must not appear as a control target, with a test named
for that behaviour.

### A6. Owner step-up is scoped to one capability
**Evidence `[M]`** `requireOwnerStepUpVerified` is called only for `access.manage`, so
a waived caller-id binding covers everything else. It fails closed today only because
`OWNER_CALLER_ID_POLICY` appears in no runbook and no `wrangler.toml` — safety by
documented accident.

**Fix.** Call it for **every** owner-authorised action, and treat
`OWNER_CALLER_ID_POLICY` as a deliberate, documented owner decision with its
consequences written in the runbook — or remove the waiver path entirely. Do not
leave the only thing enforcing it undocumented.

**Verify.** A test that removes the call for one capability and fails.

### A7. The watchdog can deploy unable to alert anyone
**Evidence `[M]`** `apps/watchdog/wrangler.toml` declares **no secrets**, while the
watchdog exists to report the gateway's failure.

**Fix.** Declare the secrets it reads in `[secrets] required`, so a deploy without
them fails loudly. `apps/cloud-gateway/wrangler.toml` already models this.

**Verify.** A dry-run deploy with the secret unset must fail.

---

## 3. Authority hardening — before the first tier-3 hand

These do not bite today: all nine dispatchable tools are tier-1, and the reserved
tier-3 hands are absent from `OWNER_TELEGRAM_TOOL_DEFINITIONS`. They become live the
day email lands. Full detail in `sweep-3-authority-risk.md`.

| # | Defect | Fix | Verify |
|---|---|---|---|
| B1 | The standing-confirmation path returns `permit` **without reading the second evaluation's outcome** (`tool-gate.ts`) | Check `confirmed.outcome` before permitting; or amend the module's claim that it "fails closed on every path that is not an explicit permission" | Remove the check; a test must fail |
| B2 | A confirmation binds `capability:argsHash`, not the tool name (`tool-confirmations.ts:73`) | Fold `toolName` into the fingerprint | Two tools sharing a capability with identical args must not share a reference |
| B3 | A confirmation is never consumed — replayable for `CONFIRMATION_TTL_MS` (`:43`) | Add a durable `consumed_at`; the file itself says this "needs a schema change and belongs in its own PR" | Same call twice inside the window: second must be refused |
| B4 | `capability_tiers` has **no UPDATE/DELETE guard trigger**, unlike `autonomy_mode` and `autonomy_evaluations` | Add the triggers in a new migration | Deleting a tier row must fail at the database, not silently widen access |

**Note.** B1's test today uses the *same tool with different arguments* — a false
friend that passes for the wrong reason. It must be rewritten alongside B2.

---

## 4. Connection debt

### C1. Ten modules that only their own tests import — 2,114 lines
**Evidence `[M]`** static import-closure from `src/index.ts`, then each candidate
re-checked with a repo-wide grep for any non-test reference:
`hermes-token-adapter.ts` (557), `memory/topic-tree.ts` (421),
`memory/extraction-evaluation.ts` (409), `sync/device-enrollment.ts` (219),
`autonomy/autonomy-service.ts` (188), `observability/safe-log.ts` (131),
`model/pre-admission-model-adapter.ts` (93), `persistence/cursor-repository.ts` (74),
`voice/call-session-terminator.ts` (16), `call-session-stub.ts` (6).

Not all are defects: `hermes-*` is retired by roadmap §6; `device-enrollment` is R3;
`autonomy-service` is wired by PR #106. The rest are orphans.

**Fix.** One decision per module, recorded in the header: **wire it**, **mark it
historical**, or **delete it**. Suggested: delete `call-session-stub.ts` (superseded
by real routes), `call-session-terminator.ts` and `extraction-evaluation.ts` (no
caller, no plan); mark `topic-tree.ts` historical with a pointer to
`readCandidates`' CTE, which actually implements subtree recall; wire `safe-log`
(see C2). `cursor-repository` and `pre-admission-model-adapter` need a
five-minute judgement from whoever wrote them.

**Verify.** Re-run `scripts/check-reachability.mjs` (add it — the script exists
outside the repo today) and require the list to shrink or be justified in a comment.

### C2. The structural logging guard is unused
**Evidence `[M]`** `observability/safe-log.ts` is an allow-list logger — only
`eventId`, `correlationId`, `component`, `operation`, `durationMs`, `outcome`,
`errorCategory` may be emitted. Nothing imports it. Production logs with raw
`console.log`, and three sites pass raw `error.message`
(`http/sync-routes.ts:187`, `:191`, `index.ts:689`).

**Fix.** Adopt it at the three sites first (they are the ones with unbounded input),
then convert the other `console.*` call sites as they are touched. Do not do a
big-bang conversion; each site converted is one class of leak made impossible.

**Verify.** A test per converted site asserting a sensitive-looking value cannot
appear in the emitted record.

### C3. Readiness is implemented and never routed
**Evidence `[M]`** `http/health.ts:140` defines `handleReadiness`; nothing calls it.
`index.ts` routes only `handleLiveness`.

**Fix.** Route it, or delete it. If routed, it needs an operator credential — decide
which, and document it. A health endpoint that answers without authentication is a
different decision from one that does not.

### C4. `topic-tree.ts` is orphaned while the capability works elsewhere
**Evidence `[M]`** only its own test imports it; `readCandidates` implements subtree
recall with a recursive `subtree` CTE over `memory_topics`. The *capability* is not
missing — reversible move/merge is.

**Fix.** Mark it historical, and open one queue row for the genuinely missing piece:
reversible topic move and merge, which nothing implements.

---

## 5. The v1.0 path

### D1. Voice has no tool dispatch — the single highest-value engineering item
**Evidence `[M]`** `git grep -inE "tool|functioncall|toolcall"` over
`apps/cloud-gateway/src/voice` returns **nothing**. Telegram has nine tools; voice has
zero. Call turns go through `DefaultConversationService` with a plain model adapter.

Everything around it is built: `index.ts:768` routes `/voice` to
`handleProductionVoiceRequest`, `call-session-do.ts` builds
`createProductionCallSessionCore`, and `readVoiceRuntimeConfiguration` validates
every binding and throws rather than falling back.

**Plan.**
1. Extract the tool-dispatch half of `OwnerTelegramAgentAdapter` into a
   channel-neutral agent that takes a channel-specific presenter. Telegram's agent
   keeps its receipts and keyboard handling; the call session gets the same tools.
2. Compose it in `CallSessionCore`'s turn handler, ahead of the model stream.
3. Put the tier gate in front of it (PR #106) — the gate is channel-neutral already.
4. Respect the 750 ms memory-retrieval budget: run tool selection **after** the
   first response, or in parallel with retrieval, and measure it. This is the one
   place where adding tools can break an existing gate.
5. Two named acceptance tests before it is called done: a spoken request that
   reaches a real tool and answers with a receipt, and a spoken tier-3 request that
   is **refused pending a tap**.

**Verify.** `git grep` for a tool definition reaching the voice model stream; and a
live smoke that speaks a request requiring a tool.

**Risk.** This changes the latency profile of the release gate. Measure before and
after; do not assume.

### D2. Voice gets the weaker retriever
**Evidence `[M]`** `voice/production-runtime.ts` builds `D1ContextRetriever`, so a
call has no meaning search, no literal/R2 full-history recall and no `/why`. Telegram
gets `TelegramMemoryRetriever`.

**Fix.** Compose `TelegramMemoryRetriever` (or its service half) into
`production-runtime.ts`. The 750 ms budget is the constraint; the meaning path is
already awaited and bounded on the Telegram side, so reuse the bound rather than
inventing one.

### D3. Production memory has published nothing
**Evidence `[R]`** `KNOWN_ISSUES.md` records 36 distillation runs, 251 events, 5
items, **5 `proposed`, 0 `active`**; meaning recall cannot see proposals
(`memory_retrievable_item_versions` is active-only).

**Fix.** Decide the promotion rule: either proposals are promotable on owner
confirmation, or recall is widened to proposals with their uncertainty visible —
which is what PR #98 began for the Telegram path. Until one is chosen, Jarvis
answers from a memory that has published nothing.

**Verify.** After the change, a production `/why` returns a dated active fact.

---

## 6. Verification and gates

### E1. Configure `testTimeout`, and quarantine flakes by name
**Evidence `[M]`** three suite runs gave **12 / 8 / 3** failures with **no name
repeating**; 33 distinct failing names across five measurements, one ever repeated.
Every captured failure is `Test timed out in 5000ms` on tests averaging ~170 ms. No
`testTimeout` is configured.

**Fix, in order.**
1. Raise the vitest `testTimeout` (10–15 s) so a loaded machine stops producing fake
   failures. This is the single highest-value 30 minutes in the report.
2. Re-measure. Whatever still fails is a real defect or a real race — those go to
   `KNOWN_ISSUES.md` with a named owner.
3. Only then re-run anything else that measures the suite.

**Verify.** Three consecutive full runs with identical failing names, or none.

### E2. `lint` is not a linter
**Evidence `[M]`** four packages define `lint` as `tsc --noEmit`; no ESLint, Biome or
Ruff is reachable, and Python's real linters live only in the dead CI job.

**Fix.** Pick one JS linter (Biome is the cheapest to adopt here) with a rule set
limited to correctness, not style; wire Python's ruff into a command that runs
locally and in CI. Introduce both as **warnings** for one week, then as errors.

### E3. 144 test-file type errors, gated nowhere
**Evidence `[M]`** `typecheck:tests` reports 144 errors in 32 files, twice; the docs
say ~117 and are stale.

**Fix.** Fix by directory, newest first — the errors concentrate in the test helpers
the newer suites use. Gate the *directories already clean* now, and widen; a
big-bang gate will be disabled the first time it blocks an unrelated PR.

### E4. The voice release chain is in no workflow
**Evidence `[M]`** `test:voice-access`, `typecheck:voice-access`, `test:voice-smoke`
and `release:voice-gate` appear in no workflow. CI could never have caught a voice
regression.

**Fix.** Add a `voice` job running the fake-only gate on every PR, and the live
smoke as a manual `workflow_dispatch`. The fake/live split is already in the
scripts; it is only unwired.

### E5. CI is alive again — and needs a budget guard
**Evidence `[M]`** after the repository moved into the org on the enterprise trial,
jobs executed steps for the first time in six days; three jobs passed. Before the
move every job failed in 4–5 s with **zero steps** — metered usage with no payment
method, not a test failure.

**Fix.** In org billing: attach **no** payment method (overage then stops rather than
bills), and set a budget with *"stop usage when budget limit is reached"*. Then run
the fix-first pass: E1, E2, E4, and the two red jobs in E6 — because a CI that is red
on every PR is worse than no CI.

### E6. The Python tests are failing in CI — cause unknown
**Evidence `[M]`** the first CI run in six days shows `local-agent (ubuntu-latest)`
and `local-agent (windows-latest)` both failing at `uv run pytest -q`.

**Fix.** Diagnose before touching anything: fetch the job log, run the same command
locally (sweep 5 could not — no `.venv` exists). This is genuinely new information
that nothing has been able to produce since 2026-09-12.

---

## 7. Machine load, and the remaining process work

### F1. Six concurrent suite runs saturate the disk
**Evidence `[M]`** sampled live: disk idle **0.0–0.2%**, queue depth **0.84 → 6.39 →
17.16** while throughput **111 → 47 → 6 MB/s**, on a **healthy** NVMe with **54%
free**. Cause: six vitest runs across six worktrees at once, each spawning a workerd
pool — 35 node and 20 workerd processes.

**Fix.** One verification lane: serialize suite runs, and move them to CI. Nothing
about this is a hardware problem, and the $260 SSD is not indicated.

### F2. Eighteen worktrees carry their own `node_modules`
**Evidence `[M]`** 18 of 29 worktrees, ~0.4 GB and tens of thousands of small files
each.

**Fix.** Prune worktrees with no recent commit; keep scratch checkouts in one place
with a naming convention and a deletion rule.

### F3. Windows Defender re-scans all of it
**Fix.** Exclude `node_modules` and `.git` from real-time scanning. Free, and it is
the cheapest available reduction in background I/O.

### G. Process — delivered and remaining
**Delivered:** `STATE.md`, `QUEUE.md`, `OWNER-ACTIONS.md` + `check-state.mjs` (PR
#107); five supersession banners, `NEXT_STEPS.md` folded, `CLAUDE.md` merged; and
`docs/REVIEW-PROTOCOL.md` (PR #108) as a proposal for the reviewer.

**Remaining:** rotate `AGENT_LOG.md` monthly (not started); wire the two checker
scripts into a job (they are written to be wired and say so); and the reviewer's four
decisions in PR #108.

---

## 8. Sequencing

**Phase 1 — today (hours).** A1 (strings), E1 (timeout), E6 (diagnose the Python
failure), E5 (budget guard). No design decisions needed; all reversible.

**Phase 2 — this week.** A2 (the back door) and A3 (redaction) with their tests;
A4–A7; D2; B1–B4 while #106 is in review; E2 and E4.

**Phase 3 — v1.0.** D1 (voice tools) → then the owner's four steps: bindings, phone
enrolment, migrate-then-deploy, live smoke with committed evidence.

**Phase 4 — cleanup.** C1–C4, D3, E3, F2–F3, G's remaining items.

**Dependencies worth stating:** D1 depends on B4's schema and the gate landing
(#106); the owner's deploy depends on A1–A3 being fixed, because deploying the
memory and school tools while A2 is open ships a promise the system does not keep.

---

## 9. What this report does not cover

- **Production is relayed, never observed** `[R]`: worker version, applied
  migrations, secrets and D1 row counts all come from documents. The disputed
  production migration level (0015 vs 0032 vs 0034) is settled by one read-only
  `d1_migrations` query.
- **Not assessed:** `apps/hermes-runtime` beyond its CI state, `apps/brain-bridge`
  (stalled mid-build), most of `apps/watchdog` beyond heartbeat and liveness, the
  vault and Obsidian subsystem, the Python local agent beyond its CI failure, and
  milestones R4/R6/R8/R9/R10.
- **No production query was run and nothing was deployed, merged or migrated.**
- **Effort estimates are the author's**, from reading, not from doing.
