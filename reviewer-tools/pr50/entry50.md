## 2026-09-15 18:55 UTC — Claude Opus 5, PR #50 xhigh review at a2c2c6c: changes requested

This review covers the channel-neutral owner-controls service at `9e4149c`: `MemoryOwnerControlsService` (remember, why, forget, lift), the repository's owner-turn validation, forget/lift writes and replays, #47 follow-ups F1–F4 and N1, and the additive contracts export `issueRedactedUlid`. `a2c2c6c` changes only the mailbox, `NEXT_STEPS.md` and `docs/HANDOFF.md`. The branch is based on main `deea39c`, and `git diff origin/main...` holds only this PR's work. It adds no migration, and no Telegram, voice, calls, provider or scheduler wiring.

**Local checks on a2c2c6c** (Windows 11, `jarvis-deploy`): lint and typecheck pass; `pnpm test` passes 3,187/3,187 with 0 timeouts.

**Mutation pass** (`reviewer-tools/pr50/mut50.json`, one change per run, memory and contracts tests). `BASE` passes, and 13 of 19 mutations are killed by named tests, with 0 timeouts:
- **Owner-turn guards:** explicit intent (V1), the untrusted-content flags (V2), active human principal (V3) and newest turn (V4).
- **Remember and why:** text must appear in the owner's turn (S1), hidden text and excerpt (S2, S3), ambiguous target (S4) and the ULID structural token (U1).
- **Archived receipts:** subject principal (A1; rerun with a unique anchor, `mut50-a1.json`) and occurrence time (A2).
- **Bootstrap:** root and inbox found by their stable create identity (B1, B2).

Six survive:
- **V5, owner-turn channel check removed.** No test covers a turn whose claimed channel differs from its event-derived channel. See F1.
- **V6, `historyEligible` check removed.** Not reachable today: every `conversation.user_committed` is written with `historyEligible: true` (`conversation-repository.ts:400`), and the `false` payloads belong to other event types, which the event-type check already refuses. Defence in depth; accepted.
- **P1, forgetting a non-active item.** The `0016` `memory_item_transitions_insert_guard` refuses a forgotten→forgotten transition, and `isConstraintRefusal` maps that to the same `memory_refused`. Equivalent.
- **P2, lifting a non-forgotten item.** Still refused, by the `0016` lift guard and by `prepareLiftItem`'s suppression-count check. The caller now sees `memory_unavailable` instead of `memory_refused`. See N1.
- **P3, forget count match.** The `0016` `memory_event_suppressions_insert_guard` checks `newly_hidden_turn_count` and `total_covered_turn_count` against the command payload and the recomputed suppression state (`0016_cloud_memory.sql:1659-1692`). Equivalent.
- **P4, lift covering every suppression.** The `0016` `memory_event_suppression_lifts_insert_guard` requires the correction transition's item to equal the forgotten transition's item, and matches the lift to the command's `lifts` entry. Equivalent.

**Input authority, verified by reading.** A new command is accepted only when all of these hold:
- the principal is an active human;
- the event is that principal's newest `conversation.user_committed` turn from `conversation-v1`, with a matching derived channel, `historyEligible` and the exact five-field payload;
- `explicitMemoryIntent` is true, and the forwarded, quoted, pasted, attachment, model, tool and guest flags are all false.

Remember also requires its text to appear in that turn. Forget and lift refuse unless exactly one target is supplied. A replay skips re-validation only for an idempotency key and request hash that were recorded after validation. The command payload carries identifiers only, never memory text. Hidden explanations and forget receipts expose no forgotten text or excerpt.

**#47 follow-ups, verified by reading:**
- **F1:** `validateArchivedEventEvidence` reads the archived envelope and binds its event id, sequence, subject principal, content hash, canonical envelope hash, `occurredAt`, derived channel and exact excerpt.
- **F2:** the root and inbox are found by their rules-authored `create` topic events, not by display name.
- **F3:** `beforeBatch` and `batchFault` exist only through `createMemoryRepositoryForTest` and a module-private WeakMap.
- **F4:** a live channel-mismatch regression exists.
- **N1:** `NEXT_STEPS.md` now states main owns `0016`–`0020` and `0022`, and the next free migration is `0023`.

**Adversarial pass** (one Opus agent; report `reviewer-tools/pr50-adversarial.md`). The reviewer verified every item below:
- **Runtime-proven:** H1, M1 and L1, with probes in `reviewer-tools/pr50/zz-reviewer-pr50-probes.ts`. All four pass at `a2c2c6c`, so the bugs are real.
- **By reading:** M2–M4, including the `0016` `memory_retrievable_item_versions` view.

Confirmed sound:
- Command payloads carry only identifiers.
- Every new query is principal-scoped, and another principal's item looks the same as a missing one.
- Re-forgetting after a lift, or re-lifting after a forget, is refused by the version ids and the `0016` command-order guard.
- Suppressions and lifts are bound to the right item and command.
- The faulted forget batch rolls back.
- System-channel, stale and non-human turns are refused.

**B1. `remember` stores a meaning-flipping fragment of Sid's turn as a fact he stated.**
- **Where:** in `memory-owner-controls.ts` `remember`, the only text check is `ownerText.includes(text)`. The item is then committed as `basis: "stated"`, `origin: "authenticated_first_person"`, `uncertain: false`, with the owner as actor.
- **Proof:**
  - Probe H1a remembers `want to move to Boston` from "Remember I don't want to move to Boston." as an owner-stated fact.
  - H1b remembers `I prefer tea` from "Remember I prefer teal."
- **What goes wrong for Sid:** Jarvis would hold the opposite of what he said, with full confidence. The `0016` transition guard then stops rules or extraction from ever correcting an owner-actor item. The text will normally be picked by a model reading the turn, so this is exactly the model-authority boundary Sid asked for.
- **Fix:**
  - Strip one leading control phrase from a closed list ("remember that", "please remember that", "remember:", and similar).
  - Then require the text to equal the remainder, or to pass `isAuthenticatedFirstPersonQuote` (whole sentence, word boundaries, no hedge, conditional or reported speech).
  - Add a negation guard (`not`, `n't`, `never`, `no longer`) that refuses a quote which drops a negation from its sentence.
  - Refuse before `appendCommand`.
- **Test:**
  - Negation, reported-speech, conditional and mid-word fragments each return `memory_refused`, with no command and no item.
  - The existing "Please remember that I prefer concise release notes." case still passes.
  - H1a and H1b must then fail.

**S1. Replaying a `remember` after a forget hands back the forgotten text.**
- **Where:** the replay path returns the item from `commitInitialItem`'s exact-replay branch without checking its lifecycle. `inspectReplay` compares only version 1, the original sources and transition 1. The item comes back with its current text and excerpts, and the receipt "Remembered 1 memory".
- **Proof:** probe M1 runs remember, then forget, then the same remember request again. The result has `replayed: true`, state `forgotten`, the text inside, and a "Remembered" receipt.
- **What goes wrong for Sid:** a webhook redelivery or crash retry could make Jarvis say or show something he told it to forget, while telling him it was remembered.
- **Fix:** when a replayed request's transition is no longer the item's current one, return no text or excerpt, and a receipt saying the request was already handled and the memory is hidden. Or refuse.
- **Test:** the M1 sequence. `JSON.stringify(result)` contains no memory text, no new command is written, and the hidden state is reported. M1 must then fail.

**S2. Memory intent isn't tied to one operation.**
- **Where:** `explicitMemoryIntent` is one boolean for remember, forget, lift and explain. The command key is `eventId:operation`, so one "remember …" turn can also authorise `forget` or `lift` of another item.
- **Fix:**
  - Replace the boolean with `memoryIntent: "remember" | "forget" | "lift" | "explain" | null`.
  - Require it to equal the invoked operation, and include it in the request hash.
  - Refuse a second, different mutating operation on the same owner event.
- **Test:** `forget` with `memoryIntent: "remember"` is refused and writes no command.

**S3. Forgetting one memory silently hides others from the same message, and lift can report a restore that didn't happen.**
- **Where:**
  - Forget suppresses whole source turns.
  - `memory_retrievable_item_versions` (`0016`) hides any active item whose source or creation event is suppressed, no matter which item's forget did it.
  - `explain` nulls excerpts only when the explained item itself is forgotten.
  - The lift receipt says "Restored" without checking that the item is retrievable.
- **What goes wrong for Sid:**
  - "Forget X" can make Jarvis stop recalling Y from the same message, without saying so.
  - `explain(Y)` still shows the hidden message's excerpt.
  - After Y is also forgotten, lifting X says "Restored" while X stays unrecallable.
- **Fix:**
  - Count and report the other active items a forget hides.
  - Null any excerpt whose source event is under an active suppression.
  - After lift, check `memory_retrievable_item_versions`. When the item isn't retrievable, say it was restored but is still hidden by another forgotten memory from the same message.
- **Test:** two items on one turn, with the second written directly through `commitInitialItem`:
  - forgetting A reports that B is hidden;
  - `explain(B)` shows no excerpt;
  - forget A, forget B, lift A reports "still hidden".

**S4. A long `remember` burns the turn and leaves a dangling command.**
- **Proof:** probe L1 remembers 5,000 characters. It is refused with `memory_refused`, but only after a `memory.owner_command` event is written (the command count goes up by one).
- **Why:** the service allows 32,768 UTF-16 units, while the repository refuses version text over 4,096 UTF-8 bytes.
- **Fix:** validate the text with the repository's rules (byte limits, NFC, `hasFactTextControls`) before `appendCommand`. Pre-check forget and lift the same way where possible.
- **Test:** a 4,097-byte text is refused with `commandCount()` unchanged. L1 must then fail.

**F1 (required before the channel adapter PR). The untrusted-content flags can't be checked against the ledger.**
- **Why:** the stored `conversation.user_committed` payload carries no provenance. Forwarded, quoted, pasted, attachment and guest are only the caller's word.
- **Fix:** persist a closed provenance code at conversation ingress, and require the owner-typed code in `validateOwnerTurn`.
- **Scope:** this changes Telegram and voice ingress, so it belongs with the adapter PR, not this channel-neutral one.

**F2 (required before any topic move or merge caller). Moving or merging the inbox disables `remember` permanently.**
- **Why:** `readBootstrapTopics` refuses when the stable inbox isn't active or isn't a direct child of the root, and never re-creates it, because `inbox !== null`. `0016` allows both operations, and `0019` whitelists them.
- **Fix:** follow merge redirects and accept any parent for the bootstrap inbox, or add a guard that forbids moving or merging it.

**F3. The owner-turn channel check has no test.** Mutation V5 survives. Add a test where the claimed channel differs from the event-derived channel, expecting `memory_refused` and no command.

**Low (fix if small, otherwise record in KNOWN_ISSUES):**
- **N1.** Lifting a non-forgotten item surfaces as `memory_unavailable` rather than `memory_refused` (mutation P2).
- **N2.** Lift always restores to `active`.
  - A forgotten `proposed` model item can't be restored: the `0016` guard aborts after the command is appended.
  - A forgotten proposed deterministic item gets promoted.
  - Restore the pre-forget state instead.
- **N3.** Replays have no age bound and skip owner-turn validation. Refuse when the item has a transition newer than the command.
- **N4.** `explain` on a forgotten item still returns topic names, source ids, times and channel. Return an empty topic path once topics can carry content.
- **N5.** The newest-turn check counts `conversation.assistant_delivered`, so a control run after the reply is delivered is refused. Count only newer user turns, or run controls before delivery.
- **N6.** A tampered stored command decodes to `memory_refused`. A stored-envelope decode failure should be `memory_corrupt`.
- **N7.** `issueRedactedUlid` is a public contracts export, which weakens the single-issuer rule. Keep it private to memory controls, or restrict it to factory-issued ids.
- **N8.** Only one target per operation per turn. Document this for the adapter.

**Next.** In this same chat:
1. Pull first. Fix B1, S1–S4 and F3, plus N1–N8 where small.
2. Record F1, F2 and any deferred N in KNOWN_ISSUES.
3. Rerun the four reviewer probes (all must now fail), the focused memory tests, and the full suite once.
4. Post in AGENT_LOG when ready for re-review.

No migration is expected. If one is needed, use `0023` or later.

This PR authorizes no migration, deploy, secret or live action.

---
