# Audit salvaged — 31 findings

**Run:** killed at peak hours on Sid's instruction, 01:18 local. Audited `ca88bf4`.
**Full detail:** `C:\w\audit\SALVAGED\` (`findings.json.txt` is all 31 with mechanism, evidence, fix, falsifier, per finding).

## What completed of ~7 planned batches

| Batch | Area | Status |
|---|---|---|
| W1 | memory + persistence (15 agents) | **complete** |
| W2 | voice + channels + conversation + autonomy + security + sync + http | **complete** |
| W3 | school/university/jobs/archive/backup/model/providers/index | planned, never ran |
| W4 | local-agent, contracts, scripts, watchdog, hermes | planned, never ran |

**Coverage is partial: roughly the gateway's memory, persistence, voice and channel layers.** Not a full sweep. Nothing over the Python local agent, the contracts package, scripts, or the watchdog.

## Counts

roadmap-violation 9 · mislead 7 · spend 2 · time 2 · (remainder informational)

## Highest severity — each needs independent verification

1. **`memory_pin` / `memory_unpin` do not work.** `findControlTargets` rejects the `pin`/`unpin`
   operations its only production caller passes. `telegram-memory-retriever.ts`
2. **`appendPin` contradicts its own comment.** The comment says a non-retrievable memory is
   *"refused rather than silently ignored"*; the guard only tests `lifecycle.state !== "active"`.
   An active-but-suppressed item pins successfully and never enters the core profile. Sid is told
   *"Pinned 1 memory; it goes in front of me in every conversation"* about something invisible.
   `memory-repository.ts:1264`
3. **Archive-circuit failure is indistinguishable from absence.** A batched read silently drops
   candidates when the archive circuit is open — a **latched** state nothing resets in production —
   while the single-item read of the same memory throws. Jarvis answers as if those facts were
   never learned. `memory-repository.ts:1552-1559`
4. **`remember` scans the entire memory store, unbounded.** No `LIMIT`, no index on
   `memory_items(principal_id, created_at)`, full text normalised in the Worker per row. Grows with
   the store forever; `memory_items` is insert-only so nothing bounds it. `memory-repository.ts:1218`
5. **The forgotten-memory guard can empty the whole context.** It compares a count of version rows
   against an item constant; when exceeded it drops everything, every turn.
   `telegram-memory-retriever.ts:1729`
6. **Voice: revoking a caller burns the number permanently** — it can never be allowed again.
   `owner-access-service.ts:623`
7. **Voice: every owner-access refusal is an unhandled error that ends the call.**
   `owner-access-service.ts:147`
8. **The owner's spoken passphrase reaches the model and the conversation store on its second
   repeat.**

## Roadmap violations (9) — code deciding what Jarvis should

Examples: `refileAutomaticInboxItems` decides *which* memories move, *how many*, and *in what
order*, and hard-codes the filing-confidence threshold **four times**; how long a fact lasts is
decided in code when the caller omits `lifetime`, and the model is invited to omit it; the
duplicate guard decides two statements are the same memory and merges wording silently.

## Also noted, independently confirmed by me earlier

`STATE.md` grades against `docs/plan/2026-09-03-jarvis-roadmap.md`, which is **deleted**;
`STATE.md` says CI is dead while `FACTS.md` says it returned; `scripts/check-state.mjs` is wired
into nothing while `AGENTS.md` says it enforces the register.

## Not done

- Batches 3–4, so no coverage of local-agent, contracts, scripts or the watchdog.
- **Nothing was verified by mutation.** These are findings, not convictions — the auditor could not
  run the suite, and I verified only items 1 and 2 by reading.
- No coverage manifest survived: the parent was killed before assembling it, so there is no
  file-by-file record of what was read.
