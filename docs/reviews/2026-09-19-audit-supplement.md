# Supplement to the audit triage — the sweep set, which was never triaged

**What this is.** `docs/reviews/2026-09-18-full-audit-triage.md` covers
`JARVIS-AUDIT-COMPLETE.md` and `DEEP-AUDIT-2026-09-18.md`. Those two are one
document: I confirmed `DEEP-AUDIT` is its Part 1, `ledger.md` its Part 2, and
the eight `audit-*.md` files its Parts 3–10, so that triage is complete for
what it covered.

It covered **eight of twenty-four files** in `C:\Users\Sid\jarvis-sweep-reports\`.
The other set — written 18:45–19:36, earlier the same evening — is a **separate
sweep with a separate scope**, and nothing in this repository had ever read it:
`00-SYNTHESIS.md`, `FOR-REVIEW-CHAT.md`, `sweep-1` … `sweep-5`,
`JARVIS-SWEEP-2026-09-18.md`, `REDESIGN-PROPOSAL-v1.md`, `reachability.md`.

`FOR-REVIEW-CHAT.md` is addressed **to this reviewer by name** and had not been
opened. That is the finding behind the finding: the triage did not miss these
claims, it never saw the files holding them.

**Everything below was re-derived first-hand at `c07d82e`.** Two were settled by
*executing* the real module rather than reading it, and are marked
`[executed]`. Anything I could not verify is not listed as work.

---

## 1. S1 — the voice channel has no tools at all

**This is the largest finding in either document set, and it is not in the triage.**

```
git grep -inE "tool|functionCall|toolCall" -- apps/cloud-gateway/src/voice
  → zero matches
```

Against nine on the Telegram path (`OWNER_TELEGRAM_TOOL_DEFINITIONS`:
`memory_remember`, `memory_correct`, `memory_forget`, `memory_restore`,
`memory_confirm`, `memory_explain`, `school_update`, `university_update`,
`study_coach`). `call-session-do.ts:1466` sends each turn through
`this.#conversation.handleTurn(...)` — a plain `ConversationService`, no tool
definitions, no gate.

And the call gets the weaker memory:

| path | retriever | built at |
|---|---|---|
| Voice | `D1ContextRetriever` | `voice/production-runtime.ts:110` |
| Telegram | `TelegramMemoryRetriever` | `index.ts:223` |

So a call has no meaning search, no full-history recall and no `/why`.

**Why it matters more than its severity suggests.** Everything else in R1 is
configuration — bindings, an enrolment, a deploy. This is engineering that does
not exist. Sid's own statement of what Jarvis is (`docs/HANDOFF.md` §2) is
*"literally THIS CHAT, but if I said hey send an email…"*. R1's exit test does
not require a single tool, so **R1 can pass in full and still hand him a phone
call to a chatbot.** Both statements are true at once, which is exactly how this
stayed invisible.

*What would have to be true:* `CallSessionCore` composes the tool-calling agent
`OwnerTelegramAgentAdapter` already uses, with the tier-3 gate in front of it,
receipts working on the voice channel, and the 750 ms retrieval gate still held
with a tool round trip added.

*Falsifier:* any tool definition reaching the voice model stream.

---

## 2. S2 — the four-digit PIN is not redacted `[executed]`

I ran the real `sanitizeRedaction` from `packages/contracts/src/calls.ts` at
`c07d82e` under `node --experimental-transform-types`:

| input | result |
|---|---|
| `my pin is 4827` | **unchanged, markers `[]`** |
| `4827` | **unchanged, markers `[]`** |
| `my pin is one two three four` | **unchanged, markers `[]`** |
| `call 555-123-4567` | **unchanged, markers `[]`** |
| `my pin is 12345678` | `my pin is [REDACTED_AUTH_DIGITS]` |
| `code 123456` | `code [REDACTED_AUTH_DIGITS]` |
| `Authorization: Bearer\nsecret-token-value` | `[REDACTED_AUTHORIZATION]\nsecret-token-value` — **the raw token survives** |

The two digit rules bracket the real credential length from both sides:
`AUTHENTICATION_DIGITS` is exactly six (`calls.ts:7`), the contextual rule was
exactly eight (`:8`), and `CREDENTIAL_ASSIGNMENT` (`:11`) does not list `pin`.
Four digits matches nothing. The guest PIN's length is not incidental — a test
pins it as `/^[0-9]{4}$/u`.

**The test that looks like it covers this is a false friend, and it is the most
instructive item in the sweep.** `test/security/redaction.test.ts:62`,
*"redacts a four-digit voice PIN by field context without redacting a year"*,
passes — against `field: "guest.pin"`. The only field literals production ever
passes are `"conversation.turn.text"`, `"text"` and `"metadata"`. `fieldMarker()`
matches none of those, so on the real path only the regexes apply, and the
regexes do not match four digits. A green test with precisely the right name,
aimed at a field no caller uses, is worse than no test — it is the evidence a
reviewer cites to close the question. I nearly did.

**PR [#96](https://github.com/stremysid/jarvis/pull/96) fixes the digit half and
only that half.** Its diff replaces the eight-digit rule with
`CONTEXTUAL_AUTHENTICATION_DIGITS = …(\d{2,})…`, with a comment explaining why
it refuses to enumerate 4 beside 8. That is the right fix. It leaves:

- **spoken-word PINs** — `voice/pin-capture.ts` maps `one`/`four`/`eight`… to
  digits, so the application understands a PIN the redactor cannot see;
- **phone numbers** — no rule exists in either runtime;
- **the `Authorization:` / `Bearer` ordering**, above;
- **the owner passphrase**, which is a digit-free word list
  (`canonicalizeOwnerPassphrase`) and is not matchable by pattern at all. It is
  structurally protected *during* the step-up window only. Spoken outside it,
  nothing redacts it.

This is also the second half of the answer to the open question on Sid's list —
whether the deployed `DEFAULT_GUEST_PIN` is the committed test value `4827`. If
it is, the PIN is both in ~20 test files **and** unredacted in transcripts.

---

## 3. S3 — three tool results claim to withhold a text and then print it

`MemoryOwnerControlsService.explain` redacts properly and returns
*"Explained 1 hidden memory without revealing its text; nothing changed."*
(`memory-owner-controls.ts:1108`). The agent wrapper then re-reads the item raw
and appends the plaintext to the same result:

| tool | line | call |
|---|---|---|
| `forget` | `owner-telegram-agent.ts:1110` | `memoryReceipt(result.receipt, item.version.text)` |
| `restore` / lift | `:1151`, `:1202` | same |
| `explain` | `:1215` | `explanationReceipt(explanation, item.version.text)` |

each preceded by its own `readCurrentItem` (`:1105`, `:1146`, `:1159`, `:1210`).
So one tool result contains both the sentence and the thing the sentence says
was withheld. The service is proven by a named test; the defect is in the layer
above it — a test proving the wrong layer.

*Cheapest fix:* pass the string the service already sanitised rather than
re-reading the repository, so a future caller cannot bypass the redaction by
forgetting.

---

## 4. S4 — one production query reads forgotten text

`TelegramMemoryRetriever.selectControlTargets` queries `memory_item_fts`:

```sql
WHERE memory_item_fts MATCH ? AND state.principal_id = ?
  AND state.lifecycle_state IN (...)
```

No suppression anti-join — while the FTS arm of `readCandidates` carries two
`NOT EXISTS` clauses to copy. `memory_item_fts` is external-content FTS5 with an
insert trigger and **no delete trigger**, so forgotten text stays indexed
permanently. That is consistent with the project's "hiding, never erasure" rule,
but it means there is no index-level invariant to lean on: every future reader
of that table must carry the anti-join and nothing enforces it. An item found
this way is then echoed raw through S3.

---

## 5. S5 — a confirmation is not bound to the tool that raised it

`confirmationReference(capability, argumentsHash)` — `tool-confirmations.ts:73`.
The tool name is not in the fingerprint. The module reasons carefully that
*"confirming 'warm up the car' cannot authorize 'unlock the car'"*, which holds
only while each tool owns its capability. Five do not:
`memory_remember`, `memory_correct`, `memory_forget`, `memory_restore` and
`memory_confirm` all map to `memory.write` (`tool-capabilities.ts:45-53`). Two
different tools with identical arguments produce the same `origin_reference`, so
a tap approving one authorises the other.

Latent today — all five are tier 1 — and it arms the moment any is reclassified,
which that migration's own comment invites. *Cheapest fix:* fold the tool name
into the fingerprint. One pure function, two callers, no schema change.

Related and **disclosed in the code, so not a surprise**: a confirmation is never
marked consumed, so it is replayable for the full `CONFIRMATION_TTL_MS` of ten
minutes. Closing it needs a durable `consumed_at` column. It should at minimum be
**tested as the current behaviour**, because a comment does not fail when someone
deletes the TTL clause.

This sits beside T3 in the existing triage; neither of these two is T3.

---

## 6. S6 — the watchdog can deploy unable to alert anyone

`apps/watchdog/wrangler.toml` declares `[vars]` with exactly one name,
`WATCHDOG_REQUIRED_COMPONENTS`. It declares **no** `WATCHDOG_TELEGRAM_BOT_TOKEN`,
`WATCHDOG_TELEGRAM_CHAT_ID` or `WATCHDOG_HEARTBEAT_SECRET`, although `src/index.ts`
reads them and `docs/runbooks/deploy.md` tells the owner to set them. Missing the
token or chat id, `resolveAlertChannel` returns `UnconfiguredAlertChannel` and
every alert is recorded as undelivered — **and the deploy still succeeds.**

This is the component whose only job is to answer "broken, or just quiet?".

---

## 7. S7 — the suite cannot currently be used as a gate

Measured by the sweep across five runs; the two numbers I re-ran myself are
marked.

| | |
|---|---|
| `pnpm test` | 199 files, 5,342 tests, 0 skipped |
| three consecutive runs | **12, 8, 3** failures — exit 1 each time |
| distinct failing names across five measurements | **33**, exactly **one** ever repeated |
| captured failure mode | `Test timed out in 5000ms`, on tests averaging ~170 ms |
| `testTimeout` configured | **nowhere** — `[M]` `git grep testTimeout` returns nothing; only `apps/watchdog` has a vitest config at all |
| `typecheck:tests` | **144 errors in 32 files** — `[M]` I re-ran it: 144 |
| `AGENTS.md:61` and `TESTING.md:44` | say **117** |

Two consequences that change how I work:

1. **"Passes alone ⇒ load flake" is false at this revision.** Four of nine
   implicated files fail with nothing else running; 22 isolated runs of
   `owner-telegram-agent.test.ts` failed 7 times on 4 different tests. That rule
   is written into `reviewer-tools/GATE-TOOLS.md` and `docs/HANDOFF.md`, and it
   mis-classifies in **both** directions — a real defect accepted as a flake is
   the dangerous one. This corroborates the `gate.ps1` entries already in
   `AGENT_LOG.md` and supplies the mechanism they lacked.
2. **A green run cannot be banked and a red run cannot be acted on.** The
   suite's own doctrine is "green is not evidence"; here red is not evidence
   either. The 5,000 ms default with no configured timeout makes the failure
   distribution a property of machine load, which is why the name moves every
   run.

The `117` is a two-line documentation fix and the number is settled.

---

## 8. Already fixed — do not re-report

The sweep ran at `5a8acf3`, before three merges. These were live then and are
not now, and re-reporting them would be a false finding:

- **`/shadow off` telling the owner tier 3 asks first while `AutonomyService`
  had no call site** — fixed by #106; `index.ts:305` constructs it and
  `owner-telegram-agent.ts` gates on it.
- **Distillation re-ingesting suppressed turns** — fixed by #110.
- **"Forget does not apply to voice"** — fixed and pinned before the sweep;
  `context-retriever.ts` anti-joins on both arms, before `LIMIT`.
- **The `0035` migration collision** — resolved; #96 renumbered to `0036`.
- **`0035_autonomy_tool_capabilities.sql` saying "eight tools"** — it says
  **nine** on main. Corrected before merge.

---

## 9. Recorded, not queued

- `OWNER_CALLER_ID_POLICY` waives the owner passphrase for every capability
  except `access.manage` — `requireOwnerStepUpVerified` is called under that one
  equality only. It is dormant **because the binding is documented nowhere**:
  not in `wrangler.toml`, not in `deploy.md`, only in a research document that
  proposes adding it. Safety by missing documentation, not by a check.
- A missing `DEEPSEEK_API_KEY` or `TELEGRAM_BOT_TOKEN` makes `replyTo` return
  with no error and no reply, after the webhook has already answered 200 —
  "silence and success must never look the same", in the flesh.
- `readVoiceRuntimeConfiguration` requires eight bindings and names none of them
  when it throws, taking the whole voice channel dark rather than one route.
- The backup classification test checks membership in the **union** of its four
  lists, never which list. Mis-filing an authoritative table into the derived
  exclusion list passes every assertion and the table is silently absent from
  every future backup.
- The migration numbering guard lives in `scripts/`, which neither CI nor
  `pnpm test` covers. It gates nothing.
- `reviewer-tools/README.md` documents six scripts that are not in the
  repository.

---

## 10. Order of work

This supplement does not renumber the existing triage. T1–T6 keep their order;
these interleave by owner impact.

| # | Work | Why here |
|---|---|---|
| — | **T6** (red CI), then **T1+T2** (migration `0038`) | unchanged — nothing is provable while the gate is red |
| S2a | Land **#96** | it is the fix for the digit half of the PIN gap, and it is conflicting against main |
| S3 | Stop the three tool results printing the text they say they withheld | owner-facing, and the claim is false today |
| S2b | Digit-word rule, phone-number rule, `BARE_BEARER` before `AUTHORIZATION_HEADER`; re-aim the four-digit test at `conversation.turn.text` | the test is the reason this stayed closed |
| S4 | Suppression anti-join on `selectControlTargets` | copy the clause from `readCandidates` |
| S5 | Fold the tool name into `confirmationReference` | one pure function, before any tool is reclassified |
| S7 | Set a `testTimeout`; correct `117` → `144` | until this lands, no verdict of mine on a red suite means anything |
| S6 | Declare the watchdog's secrets in its `wrangler.toml` | so a mute watchdog fails its deploy instead of its purpose |
| S1 | **Compose the tool-calling agent into `CallSessionCore`** | the largest, and the one Sid should rule on rather than have chosen for him |

**S1 is a decision, not a task.** It is the difference between R1-as-written and
R1-as-he-described it, and it is the kind of thing this project has twice
recorded as his when it was not. It goes to him.

Nothing here restarts a builder. Every builder is stopped and stays stopped.
