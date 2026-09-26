# Jarvis rebuild (agent-1) — PROGRESS

**Phases: 2.5 of 7 built and tested this session** (Phase 1 complete, Phase 2 complete,
Phase 4 confirmation/shadow/receipts core complete). Phases 3, 5, 6, 7 not started.

**Exact next step:** Phase 3 (Connected apps — the plug): add the `connected_apps` D1 table
+ registry, a `connect_app` tool (routes through the same confirmation gate), an MCP/HTTPS
"list tools / call tool" client that merges an app's tools into the dispatcher catalogue, and
an authenticated app-event endpoint that stores an event and wakes Jarvis. Prove it with a
small in-repo fake app + a test where one message connects it, a tool works, and an event
wakes the brain.

---

## How to run the tests

```powershell
cd rebuild
npm install
npm test
```

30 tests pass (`vitest`). `npm run typecheck` (`tsc --noEmit`) is clean.

---

## What is built (file → one line)

- `src/clock.ts` — injected Clock (SystemClock + FixedClock); no direct Date.now (trap #4).
- `src/env.ts` — Worker bindings; documents which missing config FAILS CLOSED.
- `src/types.ts` — domain types (Fact, Provenance, Receipt, PendingAction, …).
- `src/ids.ts` — id generation + canonical-JSON SHA-256 arg hashing (binds confirmations).
- `src/model/types.ts` — Model interface; MissingModelKeyError (no keyword fallback exists).
- `src/model/deepseek.ts` — real DeepSeek adapter; fetch bound to globalThis (trap #1); throws if no key.
- `src/model/fake-model.ts` — scripted model for tests (plays a queue; never reads words).
- `src/memory/facts-repo.ts` — facts ledger; corrections version (never overwrite); forget = hide.
- `src/memory/embeddings.ts` — EmbeddingProvider (Workers AI real + deterministic fake) + VectorIndex.
- `src/memory/provenance.ts` — verifies a 'stated' fact's quote appears in Sid's message.
- `src/memory/memory-tools.ts` — memory_save/correct/forget/restore/confirm/pin/unpin/explain/search + history_search.
- `src/conversation/conversation-repo.ts` — one store for text+voice; size-cap triggers a model-written summary.
- `src/receipts/receipts-repo.ts` — the tool logger / Receipts (Proof); every call recorded.
- `src/confirmations/pending-actions.ts` — pending_actions; TTL; same-turn self-confirm refused.
- `src/confirmations/gate.ts` — ToolDispatcher: enforces the five confirmations + shadow; logs every call.
- `src/confirmations/action-tools.ts` — the five confirmed actions; all return `not_connected` (honest).
- `src/settings/settings-repo.ts` — settings incl. shadow flag (explicit, not a silent default).
- `src/jarvis/system-prompt.ts` — persona (pushes back, no flattery) + time/tz/channel/shadow/core profile.
- `src/jarvis/tool-types.ts` — Tool, ToolContext, ToolResult, OwnerChannel.
- `src/jarvis/core-tools.ts` — send_text, receipts_query, settings_update, confirm_action, cancel_action.
- `src/jarvis/agent-core.ts` — the ONE brain: model loop, many tool calls/turn, bounded by rounds+errors.
- `src/jarvis/build.ts` — wires the whole brain (used by DO, tests).
- `src/channels/telegram-channel.ts` — real Telegram send; surfaces delivery failures.
- `src/channels/fake-owner-channel.ts` — test channel; can be told to fail.
- `src/router/telegram-webhook.ts` — signature + owner checks (fail closed) + provenance.
- `src/index.ts` — Worker router + JarvisDurableObject (production wiring).
- `migrations/0001_init.sql` — D1 schema mirroring the repos.
- `wrangler.toml` — Cloudflare config (D1/R2/Vectorize/AI/Queues/DO/cron).

## Tests (all fail if the behaviour breaks)

- `test/phase1-nervous-system.test.ts` (7): reply + stored conversation; history reaches the model;
  time/tz injected; every tool call logged; empty reply surfaced+logged; model error surfaced+logged;
  failed send surfaced honestly.
- `test/phase2-memory.test.ts` (8): provenance quote pass/fail; temporary needs expires_at (no default);
  meaning search drops hidden/expired; temporary expiry; corrections version+link; pinned facts injected;
  one store serves text+voice.
- `test/webhook.test.ts` (8): fail closed (no secret / no owner); wrong secret 401; non-owner not processed;
  owner accepted; forwarded/private/group provenance; inline-tap callback classified.
- `test/phase4-confirmations.test.ts` (7): confirmable held as pending (not executed); no same-turn
  self-confirm; executes only after a later confirm and is honestly `not_connected`; args-hash binding;
  shadow logs would-have; TTL expiry; receipts_query proof.

## Mutation checks done this session (trap: don't trust green until you mutate)

Each guard below was broken on purpose; the named test went red; then reverted. See the
"Mutation sweep" section at the bottom of this file for the exact edits and results.

- Provenance substring check → phase2 "refuses a stated fact whose quote is NOT in..." went red.
- Webhook fail-closed (no secret) → webhook "fails closed when the webhook secret..." went red.
- Same-turn self-confirm guard → phase4 "refuses to self-confirm within the same turn" went red.
- Confirmation gate (ran the action on first call) → phase4 "holds a confirmable action as pending" went red.
- Temporary-expiry in FactsRepo.isActive → phase2 "temporary facts drop out of recall" went red.

## Decisions not in the brief (mine, flagged for Sid)

1. **Branch name.** The task asked for `rebuild/agent-1`, but this Arena session is hard-fixed to
   the branch `arena/01a0ded1-jarvis` (the platform tracks the session by it; work on any other
   branch is lost). I kept the ISOLATION intent exactly — every change is under `rebuild/`, nothing
   outside is touched — but on this session branch, and the draft PR is opened from it. If you want
   the literal `rebuild/agent-1` branch, say so and a maintainer can `git branch rebuild/agent-1`
   off this one; the diff is identical.
2. **Confirmation "yes" path.** A typed YES is interpreted by the MODEL, which then calls
   `confirm_action(pending_id)`; code only checks the pending action exists, is Sid's, is unexpired,
   and was not created in the same turn. A Telegram inline TAP is a structured callback the code can
   act on directly (strongest path). Code never reads the word "yes".
3. **Confirmation summary.** Each confirmable tool accepts an optional `confirmation_summary` the
   model writes; if omitted, the gate builds a factual `tool(args)` description (a receipt, not a
   judgment).

## What is faked, and why

- **DeepSeek model** — no API key in the sandbox. Tests use a *scripted* FakeModel that plays a queue
  of responses; it never reads Sid's words with keywords. The real `DeepSeekModel` is written and
  type-checked but not run here. No keyword fallback exists: with no key, construction throws.
- **Embeddings / Vectorize** — Workers AI + Vectorize don't run in the sandbox. A deterministic
  bag-of-words embedding + in-memory cosine index stand in. It proves the recall PATH (index → search
  → drop hidden/expired), not real semantic quality. `WorkersAiEmbeddingProvider` is the production swap-in.
- **D1 / R2 / Queues / Durable Object storage** — not run in the sandbox. Logic is tested against
  in-memory repositories that mirror `migrations/0001_init.sql`. **Known limit:** the DO keeps state
  for its lifetime but is not yet persisted across evictions; a D1/DO-storage adapter is the next
  plumbing step (Phase 7 territory, noted here so it isn't mistaken for done).
- **Telegram / Twilio** — no real credentials. `TelegramChannel` is real code but unrun; the
  `FakeOwnerChannel` is used in tests and can simulate a failed send.

## Honesty audit (against the brief's mandatory rules)

- No fake success: the five actions return `not_connected`; nothing logs "Executed"/dispatched:true.
- Fail closed: webhook refuses with no secret; owner refuses with no OWNER_CHAT_ID; model throws with no key.
- Code never reads Sid's words to decide: no `if text == "YES"`; confirmations are code-validated only.
- No silent drops: empty reply, model error, and failed send are each logged + surfaced.
- No keyword fallback pretending to be the model: MissingModelKeyError, said plainly.
- Tool-count: the full catalogue is sent to the model; there is no cap below the real tool count.

## Not yet built (be honest with Sid)

- Phase 3 connected-apps plug (next step, above).
- Phase 5 voice (Twilio ConversationRelay, PIN, guests).
- Phase 6 wake-ups/cron/digest (the `schedule_wakeup` tool hook exists in ToolContext but no scheduler).
- Phase 7 backups/archive/heartbeat/watchdog/vault sync.
- D1/DO/Vectorize/R2 production persistence adapters (in-memory today).

---

## Signature

Built by:
- Model name and version (as you know yourself): UNKNOWN (Arena.ai Agent Mode; underlying model not disclosed to me for signing)
- Company that made you: Arena.ai (Agent Mode platform); underlying model vendor: UNKNOWN
- Reasoning / effort level (if known): UNKNOWN
- Knowledge cutoff: UNKNOWN
- Session date and time (UTC): 2026-09-26
- Phases completed this session: Phase 1, Phase 2, and the confirmation/shadow/receipts core of Phase 4

---

## Mutation sweep (this session)

| Guard mutated | Edit | Test that went red | Reverted |
|---|---|---|---|
| provenance quote check | `verifyQuote` made to always pass | phase2 provenance-refusal | yes |
| webhook secret fail-closed | returned ok when secret unset | webhook fail-closed | yes |
| same-turn self-confirm | dropped the `creatingEventId === currentEventId` check | phase4 self-confirm | yes |
| confirmation gate | ran the tool directly in `dispatch` for confirmable | phase4 "held as pending" | yes |
| temporary expiry | `isActive` ignored `expiresAt` | phase2 temporary expiry | yes |
