# Owner channel parity

Sid approved `channel-parity` on 2026-09-23 at about 23:05 EDT:

> THE ONLY difference between call and telegram is the method of communication, THAT'S IT.

Baseline inspected: freshly fetched `origin/main` at `0d695563`. Scope is the authenticated owner agent and its production composition, including the tools' real storage boundaries. No live service, database, credentials, call or PC settings were used.

## Audit

`a` means a communication/authority/delivery constraint of the medium, retained. `b` means an accidental restriction, removed here. The one explicitly permitted deferral is named below, not described as completed parity.

| Surface | Verified baseline difference or correction | Result and classification |
|---|---|---|
| Tool definitions | Telegram advertises 12 tools, voice 9: `school_update`, `university_update`, `study_coach` missing | **b removed:** both import `OWNER_TOOL_DEFINITIONS` from `agent/owner-tools.ts`; no channel catalogue remains |
| Pipeline dispatch | Voice's `pipelineModel` always returns null; Telegram alone constructs the three adapters | **b removed:** one resolver and `createOwnerPipelineModels` construct the same bodies and stores for both |
| Pipeline acceptance | School falls back on voice; study refuses voice before interpreting the request | **b removed:** both accept the original authenticated channel without relabelling a call as Telegram |
| Database authority | 19 school/university/study triggers require `channel = 'telegram'`, even after adapter fixes | **b removed in migration 0044:** accept Telegram or voice; all existing principal, source-turn, lifecycle and row checks retained |
| System prompt | Both already share `OWNER_AGENT_SYSTEM_PROMPT`; voice adds wording plus an overbroad assertion that it cannot send anything | **b removed:** shared core retained, voice addition describes speech and confirmation surfaces only. Tool availability comes from the shared catalogue |
| Core profile | Already read from the same pinned-memory store every turn | No difference; remains shared |
| Honesty and receipts | `honestReply`, claim validation, caps and `composeReceiptReply` already live in `OwnerAgentCore`, contrary to an implication in the brief | No separate voice honesty implementation. **b fixed:** rewrites now retain the complete turn prompt, pinned profile and medium instructions instead of dropping them |
| Provider policy | Telegram configures pipeline thinking explicitly; voice lacked those pipelines and their policy | **b removed:** both compose the same owner pipeline policy, using the existing setting. The general provider's legacy option name is retained for compatibility |
| Automatic recall | Telegram uses canonical items, projected facts, D1/R2 literal history and optional meaning search; voice uses only projected facts plus recent history | **b removed:** both compose `TelegramMemoryRetriever`, now accepting either channel, with the same suppression, budgets, result validation and optional meaning reader |
| Explicit meaning search | Both already compose `MemoryMeaningService` when AI/Vectorize bindings exist; absent bindings already produce an explicit tool refusal | No difference. Binding absence is not reported as an empty successful search |
| Owner utterance history | Both baseline readers already read owner events by principal across channels; “nothing from Telegram reaches a call's context” is false | Existing partial continuity retained and canonical-memory recall shared. Neither path reads another principal's history |
| Assistant transcript continuity | Telegram delivered replies are history; voice `assistant_sent` replies have `historyEligible: false` and are excluded from the shared history indexes/readers | **b deferred by express scope option:** `CHANNEL-CONTINUITY-TRANSCRIPT` in QUEUE. A conversation cannot yet reliably continue both sides across arbitrary channel switches |
| Immediate reply grounding | Voice already reads the previous sent reply on the same call; it did not return null as an old Telegram comment claimed. The reply was not supplied to the model as immediate session context | **b removed:** both channels supply verified previous-session reply text and referenced ids as untrusted reference data. Voice additionally excludes replies sent after the current utterance |
| Memory target references | Telegram stages durable item ids; voice drops them, making `findLastReferencedTarget` empty | **b removed:** references persist with the settled voice event after its relay receipt. The real target finder reads that event, scoped to principal, call and earlier sequence; no in-memory cross-turn authority |
| Memory consent | Telegram inference confirmation uses a keyboard; voice had no usable target chain. A paragraph break after a receipt also broke the shared exact-question parser | **a:** voice accepts spoken affirmative wording tied to the exact stored question and staged target on the same call; Telegram's existing inference tap remains. **b removed:** paragraph delimiter and missing reference plumbing. Negation, exact wording and source proof remain required |
| Tier 3 | Both use the same gate and durable confirmation store. Voice raises a decision but cannot display the keyboard | **a:** retrieve the pending decision with Telegram `/decisions`, tap, then repeat the action on the call. Claim before body, same capability/argument binding, ten-minute expiry, single use, no refund. Spoken PIN remains the separate rebuild's work |
| Authority | Telegram verifies direct/private ingress, current text and swipe-target identity; voice has passphrase-authenticated call authority and owner principal | **a:** different proofs of the same owner. Forwarded/borrowed content never becomes direct memory authority; a voice principal mismatch still refuses before tool execution |
| Input/output redaction | Both use the same conversation redactor and streamed output sanitizer; Telegram additionally handles callback/provider metadata, voice handles authentication audio before owner turns | **a:** transport metadata differs. Shared content redaction is unchanged. Reference ids use the existing structural-id redaction path, including six-digit runs |
| Timeouts and interruption | Voice retrieval has a 750 ms outer deadline and disclosed fallback; model budgets are 8 s first token / 30 s total versus Telegram 40 s / 90 s. The owner core caps a turn at 20 s; Telegram anchors its cap on webhook arrival | **a:** latency/cancellation constraints retained. Voice receipt proves relay send, not human hearing. No streaming-loop or barge-in rewrite |
| Delivery, replay and ingress | Telegram has durable outbox retries, provider-message ids, swipe replies, typing and webhook deduplication; voice has a call DO, relay frames, interruptions and voice-sent receipts | **a:** transport mechanics retained. No shared DO or concurrent-turn ordering claim. Enrollment, slash commands and call-access control remain transport administration outside the owner tool catalogue |
| State carriers | STATE/QUEUE describe two catalogues, an empty voice recall projection and unusable confirmation as current code | **b removed:** code status corrected here; historical production observations stay explicitly dated and unverified in this task |

## Design and coordination

The adapters keep authority and presentation; they do not choose which school or memory action Sid means. One catalogue and one pipeline constructor prevent the two production sites drifting. Relabelling voice as Telegram would evade the real authority proof and was rejected. Removing database owner-turn guards would weaken enforcement and was rejected: migration `0044_owner_channel_parity.sql` changes only the channel predicate in 19 existing triggers.

At allocation, all 11 open PRs' changed filenames were checked: #169 carries 0040, #168 carries 0041, and #172 carries 0043. Main carries 0039. 0036/0037 stay unused; 0044 is after the highest occupied number. No migration was applied outside mocked/local Vitest D1.

#172 (`codex/guided-assignment`) was open at the initial audit. Its assignment/scribe definitions and dispatch must join `agent/owner-tools.ts` and the shared pipeline resolver if it lands after this PR. A freshly fetched main is integrated before publication. The streaming builder owns its loop; the PIN builder owns spoken-PIN proof. Neither is implemented here. The existing #159 gate is unchanged.

`CHANNEL-CONTINUITY-TRANSCRIPT` is deliberately separate: admitting voice-sent replies requires consistent role/channel/eligibility validation in recent history, literal/archive history and meaning-index ingestion, plus suppression of answers derived from forgotten owner turns. A one-line query expansion would bypass those checks and misrepresent relay send as Telegram delivery. Same-call confirmation uses the existing durable voice receipt and does not make that broader history claim.

## Evidence

Local synthetic providers, real adapters/repositories and local Vitest D1 only. Counts and mutation results are filled after the final gates. No live model quality, acoustic transcription, real tap, latency percentile, deployment, migration rehearsal or cross-channel transcript acceptance is claimed.
