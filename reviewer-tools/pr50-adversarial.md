# PR #50 adversarial review: memory owner controls

- Reviewed code commit: `9e4149c` (head `a2c2c6c` only adds a mailbox entry). Base: `deea39c`.
- Method: read-only. No tests were run, and no repo was edited, committed or pushed.
- Line numbers refer to files at `9e4149c`.
  - `OC` = `apps/cloud-gateway/src/memory/memory-owner-controls.ts`
  - `REPO` = `apps/cloud-gateway/src/memory/memory-repository.ts`
  - `0016` = `apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql`
  - `OCT` = `apps/cloud-gateway/test/memory/memory-owner-controls.test.ts`
  - `RT` = `apps/cloud-gateway/test/memory/memory-repository.test.ts`

**Verdict: changes requested.** One High, four Medium, several Low.

---

## H1: `remember` accepts any substring of the owner's turn, including fragments that change the meaning

**Where**
- `OC:323-324`:
  ```ts
  const ownerText = await this.memory.validateOwnerTurn(ownerTurn);
  if (!ownerText.includes(text)) refuse();
  ```
- The accepted text is then stored with the strongest trust the schema has:
  - `OC:350-352`: `basis: "stated"`, `origin: "authenticated_first_person"`, `uncertain: false`.
  - `OC:375`: `ownerAuthorizingEventId` is set, so `actor = 'owner'` (`REPO:1562`).

**Inputs that pass today.** Each of these comes from a valid, fresh, owner-typed turn with `explicitMemoryIntent: true`:

| Owner turn (stored text) | `text` passed by adapter or model | Stored as owner-stated fact |
|---|---|---|
| `Remember I don't want to move to Boston.` | `want to move to Boston` | the opposite of what he said |
| `Remember I'm not allergic to peanuts.` | `allergic to peanuts` | an allergy he said he doesn't have |
| `Remember my brother said "Sid failed calculus".` | `Sid failed calculus` | reported speech treated as first person |
| `Remember if I get into Waterloo I will move.` | `I will move` | a conditional turned into a plan |
| `Remember I prefer teal.` | `I prefer tea` | a cut in the middle of a word |

**Consequence for Sid**
- A false memory is saved as something he stated himself, with `uncertain = false`.
- Nothing automatic can fix it later. 0016 `memory_item_transitions_insert_guard` (`0016:1399-1420`) blocks any non-owner transition on an item whose current transition actor is `owner`, except expiry.
- So rules and extraction can never supersede the wrong memory. Only Sid can, and only if he notices.
- The control path is weaker than automatic extraction, yet it grants higher trust.
  - `apps/cloud-gateway/src/memory/extraction-policy.ts`, `isAuthenticatedFirstPersonQuote` already requires a whole-sentence match at word boundaries, a first-person token, and no conditional, hedge or reported-speech framing.
- **Why this is High:** the service is documented as the enforcement boundary ("exact text from the authenticated owner's current turn", `OCT:157`). `text` will in practice be chosen by a model, and the owner requires that model-generated content never gets owner authority.

**Fix**
1. Normalise the owner turn by removing one leading control phrase from a closed list ("remember that", "please remember that", "remember:", …) and trimming whitespace.
2. Then require either:
   - `text === remainder`, or
   - `isAuthenticatedFirstPersonQuote({ quote: text, sourceText: remainder, authenticatedOwner: true })`.
3. Otherwise refuse before `appendCommand`, or commit as `proposed` / `uncertain` / `basis: "inferred"` without owner actor.
4. Add an explicit negation guard (`not`, `n't`, `never`, `no longer`) to the framing list. Its doc comment claims it rejects negation, but no pattern does beyond "don't know" and "not sure".

**Tests.** Each row above must return `memory_refused`, with `commandCount()` unchanged and no `memory_items` row. Keep the existing positive case "Please remember that I prefer concise release notes." passing through the prefix strip.

---

## M1: replaying `remember` after a forget returns the hidden text and says "Remembered"

**Where**
- `OC:315-321`: the replay path skips `validateOwnerTurn`. This is intentional and pinned by `OCT:163-164`.
- `OC:339-390`: the stored payload is fed to `commitInitialItem`.
- `REPO:775-777`: `inspectReplay === "exact"` returns `readCurrentItemInternal(...)`.
- `REPO:1594-1612`: `inspectReplay` only looks at version 1, the original source ids, and transition number 1. Forget and lift rows are never compared, so the result stays `"exact"` after any forget/lift cycle.
- `REPO:1795`, `1973`: the current item always carries `version.text` and `sources[].excerpt`, whatever its lifecycle state.
- `OC:386-390` returns that `item` with `receipt: "Remembered 1 memory…"` and `replayed: true`. It never checks `result.item.lifecycle.state`.

**Scenario**
1. Turn E: "remember X". This succeeds.
2. Turn F: "forget X". This succeeds.
3. The adapter or queue retries E with identical input (webhook redelivery, crash recovery).
4. Result: the caller receives the forgotten item's text and excerpt, plus a receipt saying it was remembered, while the item stays forgotten.

**Consequence.** Forgotten text is handed back to the channel adapter, which may speak or print it. Sid is also told something false.

**Fix.** After `commitInitialItem`, if `result.replayed` and either the state is not active or `lifecycle.transitionId !== payload.transitionId`:
- return a receipt without `item` text (for example `state` and `itemId` only, "That request was already handled; the memory is currently hidden"), or
- refuse.

**Test.** remember → forget → replay remember:
- `JSON.stringify(result)` must not contain the text;
- no new command event;
- the state is reported as forgotten.

---

## M2: the provenance flags cannot be checked against the ledger, and intent is not tied to an operation

**Where**
- `memory-types.ts:178-185`: all the flags are asserted by the caller.
- `REPO:875-877`: `validateOwnerTurn` can only check the booleans.
- `REPO:904-908`: the stored `conversation.user_committed` payload must have exactly five keys (`schemaCode`, `channelCode`, `sensitivityCode`, `historyEligible`, `text`).
- `conversation-repository.ts` `getOrCreateTurn` writes `historyPayload(channel, userText, true)`. No forwarded, quoted, pasted, attachment or guest provenance is stored anywhere.
- `OC:191-193`: the key is `${eventId}:${operation}`, and `explicitMemoryIntent` is one boolean for all four operations.

**Scenarios**
- A Telegram forward that the adapter mislabels as `forwarded: false` is fully accepted. After the fact there is no record showing it was forwarded.
- A turn classified as a "remember" request ("Remember I don't need the calculus notes any more") can be sent to `forget(E, item)` or `lift(E, item)` with the same `explicitMemoryIntent: true`.
  - Keys differ per operation, so there is no idempotency conflict.
  - The 0016 sequence guards pass because each command is appended after E.

**Consequence.** Sid's core rule ("only from my own turn, never forwarded/quoted/…") depends entirely on adapter code that doesn't exist yet and cannot be audited afterwards.

**Fix**
- Persist a closed provenance code in `conversation.user_committed` at ingress (owner-typed / forwarded / quoted-reply / pasted / attachment / guest) and require the owner-typed code in `validateOwnerTurn`.
- Replace `explicitMemoryIntent` with `memoryIntent: "remember" | "forget" | "lift" | "explain" | null`. It must equal the invoked operation and belongs in the request hash.
- Refuse a second, different mutating operation on the same event.

**Tests**
- `forget` with `memoryIntent: "remember"` → `memory_refused`, no command.
- An event stored with the forwarded provenance code but `forwarded: false` in the input → `memory_refused`.

---

## M3: suppression works per turn, not per item, so forget hides other memories and lift can report a restore that didn't happen

**Where**
- `REPO:928-945`: forget suppresses every source *event* of the item.
- `0016:942-977`: `memory_retrievable_item_versions` hides any item whose source or creation event has an active suppression, whichever item created it.
- `REPO:956-963`: `prepareLiftItem` lifts only suppressions with `forgotten_transition_id = current transition`. This is correct scoping.
- `REPO:1218-1220` / `OC:513`: the lift receipt says "Restored" without checking retrievability.
- `OC:400,411`: `explain` hides excerpts only when *this* item is `forgotten`.

**Scenario.** Items A and B share source turn E1. Example: an explicit remember plus an automatic extraction from the same turn, which `commitInitialItem` allows.
1. `forget(A)` suppresses E1. B is still `active`, but it silently drops out of `memory_retrievable_item_versions`. The receipt says "Forgot 1 memory".
2. `explain(B)` still returns B's text and the excerpt of the suppressed turn E1.
3. `forget(B)` records newly hidden 0 of 1.
4. `lift(A)` restores A's lifecycle and lifts S_A, but S_B still covers E1. A stays unretrievable while the receipt says "Restored 1 memory and lifted 1 suppressions".

**Consequence.** Sid is told memory was restored when recall still can't see it. "Forget X" also silently hides Y.

**Fix**
- After lift, query `memory_retrievable_item_versions` for the item. Report "restored, but still hidden because another forgotten memory covers the same conversation turn", or refuse the lift with a clear code.
- The forget receipt should count other active items that become hidden.
- `explain` should null the excerpt for any source event under an active suppression.

**Tests**
- Two items on one turn: forget A → assert B's retrievability is reported.
- Forget A, forget B, lift A → assert the receipt matches `memory_retrievable_item_versions` (count 0).

---

## M4: F2 is only half fixed. Moving or merging the inbox disables `remember` permanently

**Where**
- `REPO:1367-1371`:
  ```ts
  if (inbox !== null && (inbox.status !== "active" || inbox.parentTopicId !== root.topicId)) refuse();
  ```
- 0016 allows the move: the `move` guard (`0016:1955-2021`) only blocks moving the root.
- 0016 allows the merge: the `merge` guard (`0016:2022+`) only blocks merging the root.
- `topic.move` and `topic.merge` are whitelisted owner operations in 0019.

**Scenario.** The inbox gets merged into another topic, or moved under one, by an owner topic command or by future rules-based tidying.
- `bootstrapTopics` then refuses on every call.
- It never creates a new inbox, because `inbox !== null`.
- Every `remember` returns `memory_refused` for ever.

Renames are handled correctly (`RT:564-586`).

**Consequence.** One routine topic tidy-up silently breaks "remember" permanently.

**Fix** (either):
- follow merge redirects to the active target and accept any parent for the bootstrap inbox; or
- add a migration guard that forbids moving or merging the bootstrap inbox.

**Test.** Move the inbox under a child topic, then merge it. `bootstrapTopics` still resolves and `remember` succeeds.

This is forward-looking: there is no move/merge caller in `src` yet.

---

## Low

### L1: commands are left dangling when the refusal comes after the append
- `OC:307-308` allows `text` up to 32,768 UTF-16 units. The repository refuses version text over 4,096 UTF-8 bytes (`REPO:651`) and excerpts over 8,192 (`REPO:632`).
- Because `appendCommand` runs first (`OC:327`), a long "remember …" leaves a valid `memory.owner_command` that authorises nothing, and burns `E:remember`.
- The same thing happens for forget/lift when `forgetItem` or `liftItem` refuses after the append (`REPO:1016-1022`, `1121-1124`), for example after a race.
- **Fix:** pre-validate text with the repository's rules (byte limits, NFC, `hasFactTextControls`) before the append.
- **Test:** a 4,097-byte text → `memory_refused` and `commandCount()` unchanged.

### L2: lift always sets `active`
- `OC:495`, `REPO:1180`. `prepareForgetItem` allows forgetting `proposed` items (`REPO:927`).
- Lifting a forgotten `proposed` item with `origin: model` aborts in `0016:1421-1434`. That happens after the command is appended, so the item is stuck forgotten and every retry fails the same way.
- For a `deterministic_observation` proposed item, lift promotes it to owner-actor `active` and skips confirmation.
- **Fix:** restore the lifecycle state that held before the forget.
- **Test:** forget, then lift, a proposed model item → state `proposed`, suppressions lifted.

### L3: replay has no age limit and skips `validateOwnerTurn`
- `OC:315-321`, `426-432`, `478-484`.
- A stored but unapplied forget or lift command can be completed days later by replaying the turn, if item state still matches. For example, a rules `proposed→active` keeps the version id, and 0016's command-sequence guard ignores rules transitions.
- If the idempotency row vanished between `hasCommand` and `append`, the minimal `{operation,targetId}` payload would be inserted as a real command. No idempotency pruning exists in `src` (checked with git grep), so this is theoretical.
- **Fix:** bound replay by the command's age, or refuse when the item has a transition newer than the command.

### L4: `explain` on a forgotten item still reveals metadata
- `OC:405-412` returns topic display names, source event ids, `occurredAt` and channel.
- Once auto-filing names topics (for example "Health / Therapy"), the path itself is content.
- **Fix:** return `topicPath: []` or null when the item is hidden.

### L5: the latest-turn check counts `assistant_delivered`
- `REPO:909-912`.
- If the pipeline commits the assistant reply ("OK, forgetting that") before running the control, the control refuses.
- **Fix:** make sure controls run before delivery, or count only newer `user_committed` turns.

### L6: some error mappings hide corruption
- A 0019/0016 trigger abort during append (for example the principal deactivated mid-flight) becomes `memory_unavailable` (`OC:599`) instead of refused.
- A tampered stored command payload decodes to `memory_refused` (`OC:159-168`, `204-209`) instead of `memory_corrupt`.
- A `validateEnvelope` `TypeError` inside `toAppended` becomes `memory_unavailable`.
- **Fix:** map a decode failure of a *stored* envelope to `memory_corrupt`.

### L7: `issueRedactedUlid` is a public contracts export
- `calls.ts:157-162`, re-exported from the contracts index.
- It ends the "one issuer" invariant: any module can mint an unredacted token for any 26-character Crockford string, which can contain a six-digit run.
- In this PR only ids from `idFactory` or from database rows reach it (checked), so there is no leak today.
- **Fix:** keep it module-private to the memory controls, or accept only ids produced by an issuing factory.

### L8: one target per operation per turn
- `OC:184-193`: "forget both of those" is impossible, and after a failed first attempt the turn is burnt.
- Functional limit only. Document it in the adapter contract.

### Info
- **Forget leaves echoes visible.** It hides the source turns only. The assistant's reply echoing the content ("Got it, you prefer…") stays in `memory_visible_recent_events`. This matches the spec literally but leaks in practice.
- **Idempotency hash.** `request_hash` in `idempotency_records` is a hash over mostly guessable fields plus the memory text. That is no worse than `memory_item_versions.text`, which forget keeps anyway.

---

## Checked and found sound

- **Envelope content.** Command payloads carry only ids, fixed enum strings, 0/1 and nulls. No memory text reaches the event log.
  - `rememberPayload`, `forgetPayload` and `liftPayload` enforce exact keys (`OC:195-283`).
  - `redactPayload` refuses any string the sanitiser would change (`OC:170-182`).
  - The ULID regex is anchored, not multiline, lowercase only. `OCT:197-221` covers a ULID containing a six-digit run.
- **Cross-principal isolation**
  - Every new query is scoped by `principal_id` / `subject_id`: `validateOwnerTurn`, the prepare functions, both replay readers, and `readCurrentItemInternal`.
  - The idempotency key is not principal-bound, but the request hash includes `principalId`, so a mismatch refuses.
  - Another principal's item gives `memory_not_found`, identical to a missing one. Existence doesn't leak.
- **F1 (archived receipts)**
  - `validateArchivedEventEvidence` (`REPO:1453-1480`) binds `subjectId`, `eventId`, sequence, `contentHash`, the envelope SHA and, for sources, `occurredAt`, channel and excerpt.
  - The tests at `RT:657-682` are real.
- **F2 (renames)**
  - Root and inbox are found by their rules-created `create` topic event and reason string. The reason strings are unchanged from `deea39c`, so existing roots are still found.
  - The `memory_topics_one_root` unique index (`0016:300-302`) prevents duplicate roots in a race.
  - `RT:564-586` is real.
- **F3 (test seams)**
  - They are stored only in a WeakMap filled by `createMemoryRepositoryForTest`. `MemoryRepositoryOptions` no longer exposes them.
  - Nothing in `apps/*/src` or `packages/*/src` imports the factory or the service (checked with git grep).
  - The factory is still exported from the production module. Moving it to a test helper would be tidier.
- **F4 (channel mismatch).** `RT:684-694` is real: a voice claim on a Telegram event gives `memory_refused` and zero item rows.
- **Channel, stale turn, principal type**
  - A `system` channel can never match, because `validateOwnerTurn` requires `user_committed` with `channelCode` 1 or 2.
  - A stale turn refuses before any command is written (`OCT:243-253`).
  - A service principal refuses in both the service and the 0019 trigger.
- **Idempotency**
  - The same turn with a different target or text gives a hash mismatch and `memory_refused`.
  - Concurrent identical requests converge on the stored envelope.
  - Replaying forget after a lift refuses, for two reasons: the version id changed, and 0016 requires `command.sequence >` the previous owner command.
  - Replaying lift after a re-forget refuses the same way (`previousVersionId` mismatch plus sequence ordering).
- **Forget/lift integrity**
  - 0016 suppression rows are bound to the forgotten transition, source id, target event and the exact `json_each` entry of the command, with an exact newly-hidden count.
  - Lift rows are bound to the same item, the owner, a later command and the current transition. `UNIQUE(suppression_id)` prevents a double lift.
  - Lift cannot touch another item's or another principal's suppressions.
  - The batch is atomic, and the faulted batch rolls back (`OCT:450-483`).
  - Raw evidence is kept.
- **`explain` on a forgotten item** nulls the text and excerpts (`OCT:411-417`), apart from the metadata noted in L4.
- **Repository error handling.** `safely` passes `MemoryRepositoryError` codes (including `memory_corrupt`) through unchanged.
