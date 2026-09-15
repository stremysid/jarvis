# PR #50 round-2 adversarial review: owner memory controls at 726b84b

- **Branch:** `origin/codex/r2-owner-controls-service`. Fix commit `726b84b`, head `ccf7c12` (mailbox only). Previous reviewed head: `a2c2c6c`.
- **Method:** read-only. No repo was edited, committed or pushed, and no `pnpm test` / vitest suite was run.
- **One proof run:** a standalone Node script in the scratchpad (`b1probe.mts`).
  - Its functions are sliced byte-for-byte out of `git show 726b84b` with `sed`:
    - `extraction-policy.ts` lines 9–163;
    - `memory-owner-controls.ts` lines 40–46 and 247–266;
    - `memory-projection.ts` `hasFactTextControls`.
  - Only a small harness was added.
  - The builder's own four B1 cases and the positive case come out exactly as the PR tests expect, so the replica is faithful.
- **Line references:** at `726b84b`.
  - `OC` = `apps/cloud-gateway/src/memory/memory-owner-controls.ts`
  - `EP` = `apps/cloud-gateway/src/memory/extraction-policy.ts`
  - `REPO` = `apps/cloud-gateway/src/memory/memory-repository.ts`
  - `OCT` = `apps/cloud-gateway/test/memory/memory-owner-controls.test.ts`
  - `0016` = `apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql`

**Verdict: changes requested.** One High, one Medium, six Low, and Info notes.

---

## H1: remember still stores a meaning-changing fragment. Context in a neighbouring sentence is never checked.

### Where
`OC:256-266`:
```ts
function isAuthorizedRememberText(text: string, ownerText: string): boolean {
  const remainder = rememberRemainder(ownerText);
  if (remainder.length === 0 || text !== text.trim()) return false;
  if (text === remainder) return true;
  if (NEGATION.test(remainder) && !NEGATION.test(text)) return false;
  return isAuthenticatedFirstPersonQuote({ quote: text, sourceText: remainder, authenticatedOwner: true });
}
```

Inside `isAuthenticatedFirstPersonQuote`, every framing check runs on the **quote only**:
- `EP:142`:
  ```ts
  return !FIRST_PERSON_UNTRUSTED_FRAMING.some((pattern) => pattern.test(quote));
  ```
- The only look at the surrounding text is "is the previous non-space character `.`, `!` or `?`" (`EP:118-119`). After the quote, nothing is checked at all.

The remainder-wide negation gate is also weak, for two reasons:
1. It is satisfied by *any* negation inside the quote. `no longer` is in `NEGATION` (`OC:46`) but not in the quote framing list (`EP:65-66`).
2. It is a closed ASCII list: `not|never|no longer|n['’]t`.

The accepted item is then stored with the strongest trust the schema has:
- `OC:425-427`: `basis: "stated"`, `origin: "authenticated_first_person"`, `uncertain: false`;
- `OC:450`: owner actor.

### Proof
Probe output. Every row goes through `validateItemText` and `isAuthorizedRememberText` exactly as `remember` calls them (`OC:380`, `OC:399`):

| Owner turn | `text` (model/adapter-chosen) | Result | Meaning lost |
|---|---|---|---|
| `Remember my plan if Waterloo rejects me. I'll take a gap year.` | `I'll take a gap year.` | **ACCEPTED** | conditional |
| `Remember, if I get into Waterloo. I'll move to Ontario.` (a typical voice STT split; the comma also defeats the prefix strip) | `I'll move to Ontario.` | **ACCEPTED** | conditional |
| `Remember what Sam texted me. I'm quitting the team.` | `I'm quitting the team.` | **ACCEPTED** | reported speech (Sam's "I") |
| `My brother said this. I failed calculus.` | `I failed calculus.` | **ACCEPTED** | reported speech |
| `I'm not sure yet. I no longer want to study engineering.` | `I no longer want to study engineering.` | **ACCEPTED** | hedge (negation gate satisfied by `no longer`) |
| `Remember, maybe. I'm moving to Boston next year.` | `I'm moving to Boston next year.` | **ACCEPTED** | hedge |
| `I dont think this is true. I failed calculus.` | `I failed calculus.` | **ACCEPTED** | `dont` (no apostrophe, common on a phone) |
| `I cannot confirm this. I have a peanut allergy.` | `I have a peanut allergy.` | **ACCEPTED** | `cannot` |
| `Remember I failed calculus. Jk.` | `I failed calculus.` | **ACCEPTED** | trailing retraction |
| `Remember I love calculus. Just kidding!` | `I love calculus.` | **ACCEPTED** | trailing retraction / sarcasm |
| `Remember I have a peanut allergy. That's a lie.` | `I have a peanut allergy.` | **ACCEPTED** | trailing retraction |
| `Should I even say this? I failed calculus.` | `I failed calculus.` | **ACCEPTED** | question / hedge |
| `Sam said this. “I failed calculus”.` | `“I failed calculus”` | **ACCEPTED** | quotation stored as first person |
| `I donʼt know if it is true. I failed calculus.` (U+02BC) | `I failed calculus.` | **ACCEPTED** | apostrophe lookalike defeats `n['’]t` |
| `I'm n<U+200B>ot sure. I failed calculus.` | `I failed calculus.` | **ACCEPTED** | zero-width space splits `not`; `hasFactTextControls` doesn't cover U+200B |

Controls that correctly refuse:
- `n't` / `n’t` in a prior sentence;
- a trailing `Not.`;
- `My brother says: I like jazz.` (the colon blocks it);
- the round-1 H1a, reported-speech, conditional and mid-word cases;
- nested `Remember remember that …`.

The PR's own test `OCT:781-783` already relies on picking one sentence out of a multi-sentence, un-prefixed turn: "I prefer dark mode. I prefer compact menus." → "I prefer dark mode."

### Consequence for Sid
This is the same harm as round-1 B1:
- Jarvis holds a conditional, hedged, retracted or someone-else's statement as something Sid firmly said himself.
- The `0016` `memory_item_transitions_insert_guard` then blocks every non-owner correction of an owner-actor item (the `current_transition.actor = 'owner'` clause).

The voice-STT and "jk" rows are everyday inputs. The uni-plan rows are exactly Sid's current topics.

### Fix (fail closed)
1. **Give owner-stated authority only to `text === remainder`.**
   - For any sub-sentence pick, refuse, or commit as `proposed` / `uncertain: true` / `basis: "inferred"` without the owner actor.
2. **If sub-sentence picks must stay authoritative**, require **all** of these:
   - every other sentence of the remainder passes `FIRST_PERSON_UNTRUSTED_FRAMING` and `NEGATION`, plus a closed retraction list: `jk`, `kidding`, `joking`, `lie`, `not true`, `false`, `sarcasm`, `/s`;
   - the remainder contains no `?` anywhere;
   - the negation gate is "the remainder has no negation outside the quote", not "the quote has some negation".
3. **Before matching**, extend negation to `cannot|can't|cant|dont|doesnt|didnt|wont|isnt|arent|wasnt|no|nobody|nothing|none|neither|nor`.
4. **Normalise the text:**
   - map U+02BC, U+2032, U+FF07 and backtick to `'`;
   - refuse, or strip, U+200B–U+200D, U+2060 and U+FEFF in both `text` and `ownerText`.

### Test
Turn every ACCEPTED row above into an `it.each` expecting all of:
- `memory_refused`;
- `commandCount()` unchanged;
- no `memory_items` row for the turn.

Keep `OCT:222` ("Please remember that I prefer concise release notes.") passing. If fix 1 is chosen, turn `OCT:781-783` into an expected refusal or a `proposed` outcome.

---

## M1: a sibling-hidden turn's content still comes back through `text`, remember replay and lift

The S3 fix nulls excerpts only in `explain`, and only the `excerpt` field. The same suppressed content leaves by three other routes.

### (a) `explain` returns `version.text` for a sibling-hidden item, and for remembered items that text *is* the nulled excerpt
- `OC:492`: `text: hidden ? null : item.version.text`, where `hidden` is only `state === "forgotten"` (`OC:483`).
- `OC:440`: remember stores `excerpt: text`. The test fixture does the same (`OCT:171`).
- The PR test pins the leak itself. `OCT:805-810` expects:
  ```ts
  text: "I prefer compact menus.",
  sources: [{ excerpt: null }],
  ```
  So the excerpt is "not revealed", yet the identical string is returned one field up. This comes right after the forget receipt told Sid the sibling is hidden (`OCT:796`).

### (b) remember replay only checks "is my transition still current"
- `OC:462-464`:
  ```ts
  const transitionIsCurrent = result.item.lifecycle.transitionId === payload.transitionId;
  ... item: replayed && !transitionIsCurrent ? suppressMemoryText(result.item) : result.item,
  ```
- **Scenario:**
  1. Turn E: "Remember I have a dentist appointment Friday."
  2. Item A is created by remember, and item B by automatic extraction from E.
  3. Sid forgets B. E is suppressed, and the receipt says "also hid 1 other active memory".
  4. A redelivery of E's remember runs.
- **Result:** A's transition is unchanged, so the full text and the suppressed excerpt come back with the receipt "Remembered 1 memory".

### (c) lift returns the full item even when `retrievable` is false
- `OC:610`: `item: result.item`. The receipt at `OC:617` says the memory is still hidden by another forgotten memory on the same turn, but excerpts of that still-suppressed turn are returned.
- For extraction items, an excerpt may be up to 8,192 bytes of the turn (`REPO:642`). It can therefore contain the *other* forgotten memory's content.

### Consequence for Sid
After "forget B", Jarvis can still say or print B's turn (or A's identical text) through explain, a retry, or a lift of A. That is the S3 disclosure the round was meant to close.

This needs a shared-turn sibling, which R2 automatic extraction will create routinely, so it is Medium.

### Fix
Add one helper, used by `explain`, every `remember` return and `lift`: `redactHidden(item, visibility)`.
- When `!visibility.retrievable` or `suppressedSourceIds.length > 0`, null `version.text` / `textHash`.
  - Or at least null them whenever the text equals, or is contained in, any suppressed excerpt.
- Null each suppressed source's `excerpt` / `excerptHash`.
- Return an empty `topicPath`.
- Call `readItemVisibility` in `remember` too, not only after lift.

### Tests
Shared turn, A by remember and B by `commitItemFromTurn`, then forget B:
1. `explain(A)` → `JSON.stringify(result)` doesn't contain A's text.
2. The remember replay for A → no text or excerpt, and a "hidden" receipt.
3. Forget A, forget B, lift A → `retrievable: false`, and the result has no excerpt of the shared turn.

Change `OCT:807` to expect `text: null`.

---

## Low

### L1: stale remember replay still returns the topic path
- **Where:** `suppressMemoryText` (`OC:226-236`) spreads `...item`, so `topicPath` (topic display names) survives on the hidden replay. The N4 fix hides forgotten topic paths only in `explain` (`OC:489-491`).
- **Consequence:** once auto-filing names topics (for example "Health / Therapy"), a replay after forget reveals the category.
- **Fix:** set `topicPath: []` in `suppressMemoryText`.
- **Test:** add `topicPath: []` to `OCT:279-283`.

### L2: forget and lift can still leave a dangling command after a race
- **Where:** `forgetItem` re-prepares and refuses when counts drift (`REPO:1174-1180`).
- **Scenario:**
  1. Forget A is prepared with `newlyHiddenTurnCount: 1` for shared turn E.
  2. Before A's batch runs, a concurrent forget of sibling B suppresses E.
  3. The `0016` suppression guard now requires `0`, so A's stored payload can never apply.
  4. The command is recorded, `E:mutation` is burned, and every exact replay refuses.
- Lift has the same shape: a concurrent re-forget or lift changes `previousVersionId`.
- **Consequence:** "forget A" fails with `memory_refused`, and the owner must repeat it on a new turn. Race-only.
- **Fix:** have the adapter treat a post-append `memory_refused` as "please say it again". Or put the count derivation out of the command's authority, which needs a 0016 change and is not worth it now. Record it under N3/N8.

### L3: lift to `proposed` freezes the item
- **Where:** lift writes `actor = 'owner'` with `lifecycle_state = 'proposed'` (`REPO:1338-1353`).
- **Why it freezes:** the `0016` transition guard refuses every non-owner transition while the current transition's actor is `owner`, except expiry. So rules can never promote (deterministic observation) or reject the restored proposed item.
- No owner "confirm" control exists yet, but the receipt says "it still needs confirmation before recall" (`OC:614`).
- **Fix:** record in KNOWN_ISSUES that a confirm control is required, or restore proposed items with a rules-compatible path.
- **Test:** forget, then lift, a proposed `deterministic_observation` item; a rules promotion afterwards should succeed, or the limitation should be documented.

### L4: `memoryIntent` is as unverifiable as the provenance flags
- **Where:** `requireMemoryIntent` (`OC:222-224`) and `validateOwnerTurn` (`REPO:1017`) only compare the caller's own claim with the operation.
- **Consequence:** a casual "Forget that, anyway…" still becomes a forget if the adapter mislabels it. KNOWN_ISSUES F1 mentions only the forwarded, quoted, pasted, attachment and guest flags.
- **Fix:** extend F1: the adapter PR must persist, or deterministically derive, the intent classification, and the service must check it against the ledger.

### L5: `issueRedactedUlid` is still a public module export
- **Where:** `packages/contracts/src/calls.ts:157` keeps `export function issueRedactedUlid`. Removing it from the index is a convention: any module can import `calls.js` by relative path, as `OC:11` does.
- **Today:** there is no other importer (checked with `git grep`).
- **Fix:** move the function into `OC` as a module-private helper, or add a lint or import-boundary rule.

### L6: recovering an unapplied remember command can create a memory from a turn Sid has since forgotten
- **Where:** the `existing` path skips all turn checks (`OC:392-396`). `commitInitialItem` doesn't check suppression, and the `0016` item and source guards don't either.
- **Scenario:**
  1. The command for remember E is appended, then the worker crashes before commit.
  2. Sid forgets a sibling on E, so E is suppressed.
  3. The retry commits a new owner-actor active item from E and returns its text with "Remembered 1 memory".
- **Fix:** on the `existing` path, refuse or return a text-free receipt when the creation event is under an active suppression. Record this in N3.

---

## Info

- **Archival vs owner controls** (pre-existing; suspicion, needs confirmation).
  - `archive-repository.ts:421-428` `purgeDelivered` deletes `events` rows without checking `memory_item_sources` that still reference them as `live`.
  - `validateReceipt` refuses a missing live event (`if (sourceLocation === "live") refuse();`), and `readSources` maps that refusal to `memory_corrupt`.
  - So once a remembered turn is purged, `explain`, `forget` and `lift` of that memory return `memory_corrupt` before any append. No dangling command, but Sid couldn't forget an old memory.
  - Worth an F-item unless a live→archived source relocation exists elsewhere.
- **Request-hash dictionary attack.**
  - `idempotency_records.request_hash` hashes guessable fields plus the text.
  - The plaintext is already retained in the `conversation.user_committed` event and in `memory_item_versions.text` after forget, so there is no new exposure.
  - Replay receipts null `textHash`, and forget/lift receipts carry no text or hash.
- **`explain` reads the item twice without a transaction** (`OC:481-482`). A concurrent forget between the two reads could return text with nulled excerpts. The race is tiny.
- **`MEMORY_CONTROL_POLICY_VERSION` is unchanged** although the hash layout changed (`memoryIntent` replaces `explicitMemoryIntent`). Nothing is deployed, so there are no stored commands to conflict. Bump it before any deployment if semantics change again.

---

## Checked and found sound

### B1 prefix strip
- **Closed list, one strip only.** The anchored `^` prefix list (`OC:40-45`) fails closed on:
  - nested prefixes;
  - Cyrillic lookalikes ("rеmember");
  - NBSP, and a comma after "Remember" (no strip: only the whole text or a whole sentence can match);
  - case-folded prefixes, which are fine.
- **Whole remainder.** `text === remainder` stores Sid's words verbatim, so meaning is preserved.
- **Same-sentence fragments** are impossible:
  - the word boundary and sentence start/end are enforced (`EP:116-137`);
  - interior `!`, `?` and unknown periods refuse (`EP:106-114`);
  - a colon, ellipsis, emoji or opening quote before the sentence refuses.
- **Negation handling.** `n't`, `n’t`, `not` and `never` anywhere in the remainder force whole-remainder matching.
- **Input text.** `validateItemText` requires NFC and refuses C0/C1 controls and U+2028/2029 (`REPO:452-456`). `isAuthenticatedFirstPersonQuote` NFC-normalises both sides.

### S1 (stale replay)
- **Remember → forget → replay:** text, textHash, excerpt and excerptHash are nulled, the receipt says hidden, and no new command is written (`OCT:262-288`).
- **Remember → forget → lift → replay:** suppressed, with the "changed" receipt.
- **Forget replay after a lift:** `readForgetReplay` returns null because of the state, then `prepareForgetItem` refuses on the `versionId` mismatch (`REPO:1174`).
- **Lift replay after a re-forget:** `readLiftReplay` returns null, then the `previousVersionId` mismatch refuses (`REPO:1281`).
- **Receipts:** forget receipts hold ids, counts and fixed strings only. Lift and remember leaks are covered by M1 and L1 above.

### S2 (intent and one key per event)
- **Operation-bound intent:**
  - the key is `${eventId}:mutation` for remember, forget and lift (`OC:218-220`);
  - `memoryIntent` must equal the operation (`OC:223`, and again at `REPO:1017`);
  - `memoryIntent` and `operation` are both in the hash (`OC:669`, `OC:675`).
- **Sequential second operation:** refused by `hasCommand` on the hash mismatch (`OC:658`, `OCT:547`).
- **Concurrent different operations:** both miss `hasCommand` and both append.
  - `idempotency_records` has `PRIMARY KEY (scope, key)` (`0001_foundation.sql:115`), so the loser's batch fails.
  - `resolveIdempotency` then compares hashes and throws `IdempotencyConflict`, which becomes `memory_refused` (`event-repository.ts:220-223, 321-322`; `OC:702`).
  - `OCT:629` covers this.
- **Retries of the same operation:**
  - the same hash takes the `existing` path, which returns the stored envelope;
  - concurrent identical requests converge on the winner's ids through `inspectReplay` "exact".
- **Explain:** it never writes a command or a key, so it can't block a mutation, and a mutation can't block it.
- **Key not bound to the principal:** safe, because `principalId` is in the hash.

### S3 (siblings and retrievability)
- **`retrievable`** reads the `0016` `memory_retrievable_item_versions` view directly (`REPO:~848`), so overlapping suppressions (forget A, forget B, lift A) come out correct.
- **`countSiblingItemsHiddenByForget`:**
  - principal-scoped;
  - counts only active siblings whose source or creation event is newly hidden by *this* transition;
  - excludes siblings already hidden by any other active suppression, including `history.suppress` rows, via `forgotten_transition_id IS NOT ?`.
- **Suppressed source ids** are validated against the item's own sources, with duplicate checks.

### S4 (dangling commands)
- **Remember** now validates the text (bytes, NFC, controls), kind and sensitivity before `hasCommand` and append (`OCT:360` covers a 4,097-byte text).
- **Lift** of a non-forgotten item refuses in `prepareLiftItem` before append (`OCT:609`).
- **Remaining post-append refusals** are race-only (L2), or a principal deactivated mid-flight.

### N2 (restored lifecycle state)
- The previous transition's state (active or proposed) and `versionId` are read (`REPO:1105-1117`) and bound in the payload.
- The `0016` guard binds `payload.lifecycleState = NEW.lifecycle_state`, and the lift guard allows proposed/active.
- The model-origin proposed restore no longer aborts (`OCT:836`).

### Round-1 properties with no regression
- **Command payloads:** ids plus closed enum strings only. `lifecycleState` `"active"`/`"proposed"` passes `redactPayload` unchanged.
- **Principal scoping:** every new query is scoped by principal.
- **0016 command order and owner actor:** unchanged. The lift and forget batches are unchanged apart from the lifecycle bind.
- **Faulted forget batch:** still rolls back (`OCT:868`).
- **Stored-payload corruption:** now `memory_corrupt` (`OC:238-245`).
- **N5:** only newer `conversation.user_committed` rows make a turn stale (`REPO:1050-1053`).
- **F3:** the channel-mismatch test exists (`OCT:406`).
- **#47 F1–F4:** archived evidence binding, bootstrap by create identity, WeakMap test seams and the channel test are untouched by this diff.
