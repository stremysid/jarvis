# Reviewer triage of the 2026-09-18 full audit

**What this is.** Sid commissioned a full deep-dive audit of the repository from
a second vendor and told me to read it whole, not skim its headlines. I did:
`JARVIS-AUDIT-COMPLETE.md` (5,924 lines, ten parts) and
`DEEP-AUDIT-2026-09-18.md` (245 lines), both at
`C:\Users\Sid\jarvis-sweep-reports\`. Those files live on his Desktop and not in
this repository, so every finding that survives review is recorded **here**,
where the next session will find it. That is the rule added to `AGENTS.md` on
2026-09-18 after the Classroom re-ask: a fact that lives only outside the repo
is a fact the next session will contradict.

**The standing rule applies to auditors too.** I do not accept a report's claim
about its own evidence any more than I accept a builder's claim about its own
tests. Everything ranked below I re-derived first-hand in this worktree at
`53d327f`; where I did not, it is marked `[unverified]` and is not queued as
work.

---

## 1. Confirmed first-hand, and queued

### T1 — a D1 write credential is owner authority, by one INSERT

`channel_identities` has **no `BEFORE INSERT` trigger**. Verified:

```
git grep -n "ON channel_identities" apps/cloud-gateway/src/persistence/migrations
  0001_foundation.sql:51   CREATE INDEX  (not a trigger)
  0004_call_sessions.sql:349  BEFORE UPDATE OF provider_subject
  0005_conversation.sql:427   BEFORE UPDATE OF principal_id, channel
```

Both triggers guard *updates*. Nothing guards the insert, `enrolled_by_device_id`
is nullable, and the `CHECK` asks only that an active row has a `verified_at`.
So a row naming the owner's `principal_id` against an attacker's Telegram user
id is a legal insert, `findActiveVerifiedTelegramIdentity` returns it, and
`index.ts` takes the owner lane on `principalId === env.OWNER_PRINCIPAL_ID`.

The design's own claim is that identity is proved by device keys and peppers, so
the database is a record and not an authority. For the voice lane and the
device-signed routes that holds — inserting a *public* key does not let anyone
sign, and the passphrase/PIN peppers are Worker secrets, not D1 rows. For the
**Telegram** lane it does not hold.

I did not execute the end-to-end run, and I did not read every application-level
writer (`sync/device-enrollment.ts`, `sync/identity-challenge.ts`) to see what
*it* would refuse — the point is that the database would not stop a direct
`INSERT`, which is exactly what a credential holder performs.

### T2 — the autonomy tier registry is silently rewritable

`0008_autonomy.sql` gives `autonomy_evaluations` both a reject-update and a
reject-delete trigger. `autonomy_mode` gets reject-delete only. `capability_tiers`
gets **neither**. So `UPDATE capability_tiers SET tier = 1 WHERE capability =
'spend.money'` succeeds, fires nothing, and writes no row anywhere; later
`autonomy_evaluations` rows simply carry the new tier with no record that it
ever changed. `UPDATE autonomy_mode SET mode='live', entered_at=<anything>` is
the same — and `entered_at` is the column `/status` reports to Sid as "live
since".

The migration's own comment is what makes this a defect rather than a gap: it
says tiers live in the database so that *"a capability cannot quietly acquire a
lower tier through a refactor, and every change to one is an event."* Half of
that is true. A refactor cannot. One statement can.

**T1 and T2 are one migration.** Three tables, four triggers, mirroring the two
that `autonomy_evaluations` already has. Next free number is `0038` — `0035`,
`0036` and `0037` are all claimed by branches in flight, which is the collision
this week already produced twice.

### T3 — the confirmed tier-3 path permits without reading the second evaluation

Live on `origin/main` now, at `autonomy/tool-gate.ts:209`:

```ts
const confirmed = await this.#service.evaluate({ capability, principalId, summary, decisionId });
return Object.freeze({
  verdict: "permit",        // literal — confirmed.outcome is never read
  evaluation: confirmed,
  receipt: gateReceipt(confirmed, request.toolName, classified, decisionId),
  ...
});
```

`gateReceipt` *does* switch on `confirmed.outcome`, so the object can carry
permission to run alongside a receipt that reads "Nothing happened: … its
capability is not registered." Reaching it needs the `capability_tiers` row to
change between the two reads — which is precisely what T2 makes a one-statement
operation. The module's own header says it *"fails closed on every path that is
not an explicit permission"*; this path does not.

The naive fix is wrong. `verdictFor(confirmed)` would map tier 3's
`requires_confirmation` to `"confirm"` and break the confirmed path entirely,
because `decideOutcome` takes no input but tier and mode — a standing decision
cannot change what it returns. The fix is to **deny** when the second evaluation
is not the outcome the first one was, rather than to re-derive the verdict from
it. I found this independently before the audit did; the audit confirms it and
adds that no test covers it (the nine gate tests stop at the happy path, which
cannot fail here).

### T4 — the Telegram timeout does not cover the body read

`providers/telegram-provider.ts:101-127`, read directly:

```ts
// A hung request would hold a Worker invocation open until the platform
// kills it, so the timeout is enforced here rather than relied upon.
const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
try   { response = await this.#fetch(...); }
catch { throw ProviderFailure.transient("timeout"); }
finally { clearTimeout(timer); }          // <- timer dies here

parsed = (await response.json()) as TelegramApiResponse;   // <- no timer armed
```

The comment asserts the opposite of the behaviour. A provider that returns
headers and then stalls the body holds the invocation open for the full platform
limit, including under `ctx.waitUntil` after the webhook has already answered
200. Same shape again at `:145-167`. `twilio-provider.ts` keeps its timer armed
across its body read, so the codebase's own pattern shows the gap — and gives a
reader no reason to suspect the difference.

This one is on **Sid's actual reply path**. Telegram is the channel he uses.

### T5 — `jarvis vault sync` can never see more than 64 notes

`vault/reconciliation.py`: `MAX_SLICE_DOCUMENTS = 64` (`:60`), and `run()`
breaks with `status="incomplete"` once `documents_examined >= 64` (`:206`).
I read the loop: `documents_examined` increments for **every** file the walk
yields, including files whose content is unchanged, and the walk is
deterministically sorted (`sorted(subdirectories)`, `sorted(filenames)`) with no
persisted position. So run *N+1* re-examines the same first 64 files and stops
in the same place. `cli_commands.py` maps `incomplete` to `EXIT_REFUSED`, so the
command reports failure forever, and files 65+ are never observed, never
tombstoned, never searchable. Because `result.complete` stays false, the
tombstone pass never runs either.

The only test that names the cap asserts the *stop*
(`test_a_slice_stops_at_sixty_four_documents`). Nothing asserts continuation, so
the suite stays green through the whole defect. That is the mutation-testing
failure mode `AGENTS.md` describes, in the flesh.

### T6 — the red CI job: the passphrase contract has no agreeing implementation

I had already diagnosed this failure to a single test and a single digest pair.
The audit supplies the cause commit and I verified both halves here:

| side | file | construction |
|---|---|---|
| Worker | `security/chained-pbkdf2.ts` | `PASSES = 6`, each `iterations: 100_000` |
| Python | `jarvis_local/owner_passphrase_policy.py:70` | one call, `ITERATIONS = 600_000` |

Six chained 100,000-iteration passes are **not** one 600,000-iteration pass — the
second pass derives from a 32-byte digest, not from the password. Commit
`d839cad` ("fix(security): respect production PBKDF2 cap") moved the Worker to
the chain and regenerated the shared fixture
`packages/contracts/fixtures/owner-passphrase-known-answer-v1.json`; the Python
side was never changed. `d43fzp6T…` is what Python still computes, `t4KRRUm+…`
is what the fixture now expects.

**No runtime impact** — `derive_owner_passphrase_digest` is imported by exactly
one file, its own test. But the fixture's entire purpose is to prove the two
runtimes agree, and they do not.

Two defensible repairs: teach Python the chain, or delete the digest half and
keep the canonicalisation half (which passes and still pins the canonicaliser
both runtimes share). **Do not regenerate `digestBase64` back to `d43fzp6…`** —
that makes the gate green by blessing the divergence the fixture exists to
detect.

---

## 2. Confirmed, not queued yet — recorded so they are not rediscovered

- **The safe-log allow-list has zero production importers.** `observability/safe-log.ts`
  is imported only by its own test and a type-level acceptance test; all 22
  production log sites are raw `console.*`, four of them passing a raw
  `error.message`. The strings are overwhelmingly fixed codes today, so this is a
  silence finding, not a blast-radius one — but the control that would catch the
  first error class to interpolate content is not on the path. Notably
  `owner-phone-enrollment-routes.ts` is the one file whose log hygiene *is*
  pinned by name, which is the shape of it: the pattern is applied where someone
  remembered, not enforced anywhere.
- **`/health` shares one per-isolate 30/minute bucket keyed by the constant
  `"liveness"`.** One request every two seconds from anyone keeps the only
  monitoring surface answering 429, and a monitor keying on "not 200" cannot
  tell that from the gateway being down. Its 503 branch is also unreachable in
  production (`index.ts` passes the literal `availability: "available"`).
- **`handleReadiness` and `OperatorAuthorizer` have no route.** `operator-auth.ts`
  verifies a signed intent for the literal path `/health/readiness`, which the
  router does not serve — the request falls through to 501. `sync/device-enrollment.ts`
  is likewise unrouted.
- **The H1/Hermes local-model bridge is test-only.** `model/hermes-token-adapter.ts`
  and `model/pre-admission-model-adapter.ts` have no importer under `src/`, so
  `ARCHITECTURE.md`'s account of the model adapters describes three where
  production uses one. `PreAdmissionModelAdapter` additionally fails **open** on
  a throwing readiness probe (any rejection silently routes the turn to the
  cloud model) — degradation, not authority, but unpinned and unlogged.
- **The circuit breaker guards `telegram.sendMessage` only.** The three model
  operations are declared and never acquired, so a model outage is never
  short-circuited and every turn pays the full timeout.
- **On the Python side, five modules have no production importer at all**:
  `memory/backup.py` (and `BackupService` cannot be wired as-is — no production
  `ServiceLock` implementation exists), `memory/compatibility_gate.py`,
  `memory/vector_index.py`, `vault/indexing.py`, `vault/projection.py`. Plus
  `memory/retrieval.py::LocalMemoryRetriever`, which is never constructed — so
  distilled local memory is written, promoted and uploaded, and cannot be read
  back on the machine holding it.
- **`crypto/dpapi.py` reports errno 0 on every failure** — the DLLs are loaded as
  `ctypes.windll.crypt32` without `use_last_error=True`, and `get_last_error()`
  is then read at `:60` and `:69`. This is the module that wraps the device's
  private key on Sid's own platform; a failure surfaces as
  `OSError(0, "CryptProtectData failed")`. `transport/pipe_server.py:_win32()`
  gets this right, so the pattern exists in the tree.
- **`config.py` accepts a POSIX path on Windows.** Any string starting with `/`
  counts as absolute on either platform, so `JARVIS_DEVICE_KEY_PATH=/x` makes
  `jarvis doctor` report ready and fails later, less legibly.

---

## 3. What the audit says that I have **not** verified

Recorded as the auditor's claim, not as this repository's position:

- Every `[R]`-tagged row in the audit's provider/model table, which came from its
  own delegated sub-pass. The audit itself spot-checked four of those and found
  one wrong (`capacity-readers.ts`'s constructor guard is pinned, not unpinned),
  which is the right reason to treat the rest as relayed.
- The claim that six chained passes preserve the intended security property. The
  audit explicitly declines to assess it and so do I; it is a cryptographic
  question, not a code-reading one.
- Anything about the deployed Worker. The audit ran no network call and neither
  does this triage. Production D1 is at `0034`, `autonomy_mode` is `shadow`, and
  the deploy is still the open item.

## 4. What the audit did not cover

Its own §7 lists this, and the omissions matter for how much comfort to take:
no test suite was run in Parts 8-9, no mutation was executed anywhere, `wrangler`
was never invoked, and the memory and voice subsystems were audited in separate
parts with their own scopes. A `PINNED` verdict in the audit means *a test's name
asserts the behaviour*, read from the source — not that anyone watched it go
green. That is a weaker claim than it looks, and it is the auditor's own
statement of it.

---

## 5. Order of work

| # | Work | Why this order |
|---|---|---|
| 1 | **T6** — Python passphrase chain | The gate is red; nothing else can be proven green until it is not |
| 2 | **T1 + T2** — migration `0038`, four triggers | Highest value in the audit, one file, and T2 is what arms T3 |
| 3 | **T3** — deny on a changed second evaluation | The backstop Sid is told protects him |
| 4 | **T4** — timer across the body read | His actual reply path |
| 5 | **T5** — vault continuation | Confirmed defect, Windows-live, no current user impact |

Nothing here is launched while Sid is inside his peak-cost window; he stopped the
builders on 2026-09-18 and that stands until he says otherwise.
