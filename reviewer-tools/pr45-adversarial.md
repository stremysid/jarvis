# PR #45 adversarial review (head 4ec4ea4 vs main f0bfbe9)

## Findings

**H1: One bad snapshot read stops every owner Telegram reply, with no way to recover from chat.**
`school-catchup-model.ts:265` calls `readSnapshot` with no try/catch, and it runs before any fallback. `readSnapshot` throws when the caps are exceeded (`school-catchup-repository.ts:192,196,202,207`). `applyOwnerPlan` checks those caps only against a snapshot taken before the batch (`repository.ts:265,349-357`). 0020 has no database-level cap. Turns are not serialised per session: the claim is per turnId, and each webhook gets its own `replyTo` (`index.ts:371`).
*Scenario:* Chemistry has 10 active facts. The owner sends two messages a few seconds apart, and each model response adds 6 facts. Both batches pass the check, leaving 22 active facts. From then on every owner message throws at :265, gets `model_failed`, and no reply is sent. Resolving facts needs a successful turn, and deletes are forbidden (`0020:253-257`), so the only fix is manual D1 work. The same happens with 11 courses and two concurrent new courses (`LIMIT 13`, :192). Deploying the Worker before 0020 is applied also kills all owner chat ("no such table").
Side effect: a stale `completeActionIds` becomes a silent no-op (`repository.ts:361-363 AND status='planned'`), but the reply still says it was done.
*Tests:* run two `applyOwnerPlan` calls from the same stale snapshot, then assert `adapter.stream` still replies. Make `readSnapshot` reject and assert the base model answers.

**M1: Resolving a fact can never be undone, and the same fact can never be recorded again.**
`knownFactKeys` holds only *active* owner facts (`repository.ts:334-341`). A resolved fact keeps its `fact_key`, so re-adding it hits UNIQUE and the insert guard (`0020:85,199-215`). The whole batch aborts and the adapter throws (`model.ts:300-301`). Reactivating is forbidden (`0020:245-251`).
*Scenario:* "I missed the lab", then "lab done" (resolved), then a week later "I missed the lab". Every turn that restates it now fails with no reply.
*Test:* resolve a fact, then add the same kind and statement. Expect success or reactivation.

**M2: Anything the model says gets saved as "owner_reported", and completions are never checked against what the owner said.**
"Directly supported by the owner message" and "only when the owner clearly says so" are rules in the prompt only (`model.ts:228,230`). The repository stamps `owner_reported` plus the owner's turn on every model-emitted fact or card (`repository.ts:307-314,343-347`). It applies `resolveFactIds` and `completeActionIds` without checking them (`:326-331,359-364`). The model's input includes retrieved history and `third_party`-origin facts (`model.ts:237`; `context-retriever.ts:91-92,165`).
*Scenario:* the owner writes "thanks". A hallucination, or a retrieved third-party fact saying "all chemistry work is done", produces `engaged:true` and resolves every fact and action. That is stored permanently with the owner's own provenance, and M1 then blocks re-recording it.
*Test:* a model response that resolves or completes items or adds facts on a message like "ok" is rejected or needs confirmation.

**M3: When the school path falls back, the owner can be told something was saved when nothing was.**
There are two silent fallbacks to the unfiltered base model:
- The prompt is over 48 KB (`model.ts:267-272`). Context alone can reach 32 KB, and state can add 48 facts × 512 B, so a mature history bypasses the school path on most turns.
- Any one invalid field fails the parse (`:282-289`), for example a statement containing a newline or 17 facts.

The base reply ("Noted, I've added that") goes out with no "not saved" signal.
*Test:* on parse failure or an oversized prompt for a school message, assert that nothing implies a save, or that a fixed notice is sent.

**M4: The reply guards are a deny-list of phrases. They miss paraphrases and also wreck ordinary answers.**
`FALSE_EXTERNAL_COMPLETION` (`model.ts:22`) only catches first-person past-tense phrasing. These all get through:
- "Submitted it for you"
- "Your teacher has been emailed"
- "I went ahead and emailed"
- "I **submitted**"
- "we paid"

Nothing checks the "Platform-confirmed" labels in a reply against the stored evidence. Every owner message now goes through this path, including non-school chat. False positives replace real answers with canned school text: "Never share your verification code" and "enter your new password on Google's page" both match `SECRET_REQUEST` (:21).
*Test:* a table of paraphrases that must be caught, plus non-school replies that must pass through unchanged.

**L1: The migration doesn't stop UPDATE OR REPLACE from silently deleting another course card.**
`school_course_cards_primary_key_immutable` pins only `principal_id` and `course_id` (`0020:186-191`). Nothing rejects `NEW.course_key` colliding with another row. `UPDATE OR REPLACE ... SET course_key=<other card's key>` deletes the other card without firing `reject_delete`. Today only the FK `ON DELETE RESTRICT` from action rows prevents this (`0020:131-132`), and nothing tests that. The migration test covers only INSERT OR REPLACE/IGNORE (test:124-218).
*Test:* UPDATE OR REPLACE on a card with no child rows must abort. Add a collision guard trigger.

**L2: The digest keeps model-proposed study steps ahead of real due dates.**
Catch-up is the first candidate section (`digest-composer.ts:281`). `fit()` trims from the last unprotected section (:245-266), so "Due" lines are dropped before catch-up lines. The catch-up section has no "proposed" or evidence label.
*Test:* overflow past 4096 characters and assert Due survives ahead of catch-up.

**L3: No retention, and timestamps are loosely checked.**
Every engaged turn inserts up to 21 action rows plus a receipt, and resolved or superseded rows are never pruned. `created_at` on cards is not pinned on UPDATE. Nothing checks that `completed_at` or `resolved_at` is at or after `created_at`.

## Checked and sound

- **Evidence stays separated:** there is no evidence field in the model schema, and `exactRecord` requires exact keys (`model.ts:34-48`). The repository hard-codes `owner_reported`. The CHECK ties `platform_confirmed` to a `source_ref` with no turn (`0020:88-91`). No code writes `platform_confirmed`.
- **Classroom text:** Classroom titles live only in the deadlines tables. They never reach the school prompt or the context retriever.
- **Owner-only:** the adapter is used only when the principal is `OWNER_PRINCIPAL_ID` (`index.ts:111`). Every query binds the principal. The digest uses `OWNER_PRINCIPAL_ID`, and commands skip the school path (`index.ts:358-371`).
- **One reply, no false success on persistence failure:**
  - The adapter emits exactly one reply or passes through one base stream.
  - When persistence fails it throws before yielding, so the turn settles as `model_failed` and nothing is staged (`conversation-service.ts:874-914`).
  - Provider errors are not retried.
  - A replay of the same turn is a no-op thanks to the receipt plus the response hash.
- **Migration guards:**
  - INSERT OR REPLACE/IGNORE is rejected on all four tables, and the fact and action key columns are pinned.
  - Receipts are immutable, and owner rows require a Telegram turn from the same principal.
  - Triggers use only `SELECT RAISE … WHERE`, with no CASE or CTE.
- **Digest:** a failed read becomes a protected gap. Course and action text go through `neutraliseInline` and get a rank prefix, so they can't fake a heading.
