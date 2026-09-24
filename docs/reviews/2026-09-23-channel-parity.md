# Owner channel parity

Sid approved `channel-parity` on 2026-09-23 at about 23:05 EDT:

> THE ONLY difference between call and telegram is the method of communication, THAT'S IT.

**2026-09-24 review correction.** The original build treated a spoken yes as equivalent to Telegram's tap for a model-inferred memory. Sid did not approve that builder-written consent rule. #174 now requires the shared tap on both channels and directs a caller to `/decisions`. The original mutation table below is historical evidence for the superseded head, not evidence for the corrected consent policy.

Baseline inspected: freshly fetched `origin/main` at `0d695563`. Scope is the authenticated owner agent and its production composition, including the tools' real storage boundaries. No live model or messaging service, real database, credentials, call or PC settings were used. GitHub access was limited to the authorized source/PR workflow.

## Audit

`a` means a communication/authority/delivery constraint of the medium, retained. `b` means an accidental restriction, removed here. The one explicitly permitted deferral is named below, not described as completed parity.

| Surface | Verified baseline difference or correction | Result and classification |
|---|---|---|
| Tool definitions | Telegram advertises 12 tools, voice 9: `school_update`, `university_update`, `study_coach` missing | **b removed:** both import `OWNER_TOOL_DEFINITIONS` from `agent/owner-tools.ts`; no channel catalogue remains. After merging #169 and #172, both expose **17 tools** (9 memory, 3 pipeline, 2 collector, 3 guided assignment) |
| Pipeline dispatch | Voice's `pipelineModel` always returns null; Telegram alone constructs the three adapters | **b removed:** one resolver and `createOwnerPipelineModels` construct the same bodies and stores for both |
| Pipeline acceptance | School falls back on voice; study refuses voice before interpreting the request | **b removed:** both accept the original authenticated channel without relabelling a call as Telegram |
| Database authority | 19 school/university/study triggers require `channel = 'telegram'`, even after adapter fixes | **b removed in migration 0044:** accept Telegram or voice; all existing principal, source-turn, lifecycle and row checks retained |
| System prompt | Both already share `OWNER_AGENT_SYSTEM_PROMPT`; voice adds wording plus an overbroad assertion that it cannot send anything | **b removed:** shared core retained, voice addition describes speech and confirmation surfaces only. Tool availability comes from the shared catalogue |
| Core profile | Already read from the same pinned-memory store every turn | No difference; remains shared |
| Honesty and receipts | `honestReply`, claim validation, caps and `composeReceiptReply` already live in `OwnerAgentCore`, contrary to an implication in the brief | No separate voice honesty implementation. **b fixed:** rewrites now retain the complete turn prompt, pinned profile and medium instructions instead of dropping them |
| Provider tool-count bound after #172 | The provider rejected more than 16 tools; the newly merged owner catalogue has 17, so production stopped before fetch | **b removed:** allow up to 32 definitions, retaining the serialized request byte bound. Production composition and the upper bound are tested and mutation-verified |
| Provider policy | Telegram configures pipeline thinking explicitly; voice lacked those pipelines and their policy | **a:** voice pipeline thinking stays disabled even when Telegram enables it, because a tier-3 tap is claimed before the body and voice has a tighter response deadline. The general provider's legacy option name is retained for compatibility |
| Automatic recall | Telegram uses canonical items, projected facts, D1/R2 literal history and optional meaning search; voice uses only projected facts plus recent history | **b removed:** both compose `TelegramMemoryRetriever`, now accepting either channel, with the same suppression, budgets, result validation and optional meaning reader |
| Explicit meaning search | Both already compose `MemoryMeaningService` when AI/Vectorize bindings exist; absent bindings already produce an explicit tool refusal | No difference. Binding absence is not reported as an empty successful search |
| Automatic memory capture | Both already distill eligible owner `conversation.user_committed` events from either channel with source and suppression checks | No difference; assistant speech is not promoted to owner evidence |
| Owner utterance history | Both baseline readers already read owner events by principal across channels; “nothing from Telegram reaches a call's context” is false | Existing partial continuity retained and canonical-memory recall shared. Neither path reads another principal's history |
| Assistant transcript continuity | Telegram delivered replies are history; voice `assistant_sent` replies have `historyEligible: false` and are excluded from the shared history indexes/readers | **b deferred by express scope option:** `CHANNEL-CONTINUITY-TRANSCRIPT` in QUEUE. A conversation cannot yet reliably continue both sides across arbitrary channel switches |
| Guided assignment state from #172 | Main added read/save/draft tools and shared assignment answers, raw/scribed text and step notes while this task was running | Shared unchanged: its three definitions now join the common catalogue; both adapters keep the same service, owner proof, gate and receipt provenance |
| Immediate reply grounding | Voice already reads the previous sent reply on the same call; it did not return null as an old Telegram comment claimed. The reply was not supplied to the model as immediate session context | **b removed:** both channels supply verified previous-session reply text and referenced ids as untrusted reference data. Voice additionally excludes replies sent after the current utterance |
| Memory target references | Telegram stages durable item ids; voice drops them, making `findLastReferencedTarget` empty | **b removed:** references persist with the settled voice event after its relay receipt. The real target finder reads that event, scoped to principal, call and earlier sequence; no in-memory cross-turn authority |
| Memory consent | Telegram inference confirmation uses a keyboard; voice had no usable target chain. A paragraph break after a receipt also broke the shared exact-question parser | **a corrected after review:** a model-inferred memory requires the shared tap on either channel, and voice directs Sid to `/decisions`. Spoken non-affirmative wording refuses. An owner-stated fact may still be grounded against the exact preceding question. **b removed:** paragraph delimiter and missing reference plumbing |
| Tier 3 | Both use the same gate and durable confirmation store. Voice raises a decision but cannot display the keyboard | **a:** retrieve the pending decision with Telegram `/decisions`, tap, then repeat the action on the call. Claim before body, same capability/argument binding, ten-minute expiry, single use, no refund. Spoken PIN remains the separate rebuild's work |
| Authority | Telegram verifies direct/private ingress, current text and swipe-target identity; voice has passphrase-authenticated call authority and owner principal | **a:** different proofs of the same owner. Forwarded/borrowed content never becomes direct memory authority; a voice principal mismatch still refuses before tool execution |
| Input/output redaction | Both use the same conversation redactor and streamed output sanitizer; Telegram additionally handles callback/provider metadata, voice handles authentication audio before owner turns | **a:** transport metadata differs. Shared content redaction is unchanged. Reference ids use the existing structural-id redaction path, including six-digit runs |
| Timeouts and interruption | Voice retrieval has a 750 ms outer deadline and disclosed fallback; model budgets are 8 s first token / 30 s total versus Telegram 40 s / 90 s. The owner core caps a turn at 20 s; Telegram anchors its cap on webhook arrival | **a:** latency/cancellation constraints retained. Voice receipt proves relay send, not human hearing. No streaming-loop or barge-in rewrite |
| Instrumentation and medium context | Telegram records webhook/retrieval/provider/delivery timings and supplies swipe targets as untrusted quoted context; voice records call/relay/fallback events | **a:** transport diagnostics and gestures remain separate. Legacy Telegram names on shared readers/settings are compatibility names |
| Delivery, replay and ingress | Telegram has durable outbox retries, provider-message ids, swipe replies, typing and webhook deduplication; voice has a call DO, relay frames, interruptions and voice-sent receipts | **a:** transport mechanics retained. No shared DO or concurrent-turn ordering claim. Enrollment, slash commands and call-access control remain transport administration outside the owner tool catalogue |
| State carriers | STATE/QUEUE describe two catalogues, an empty voice recall projection and unusable confirmation as current code | **b removed:** code status corrected here; historical production observations stay explicitly dated and unverified in this task |

## Design and coordination

The adapters keep authority and presentation; they do not choose which school or memory action Sid means. One catalogue and one pipeline constructor prevent the two production sites drifting. Relabelling voice as Telegram would evade the real authority proof and was rejected. Removing database owner-turn guards would weaken enforcement and was rejected: migration `0044_owner_channel_parity.sql` changes only the channel predicate in 19 existing triggers.

At allocation, all 11 open PRs' changed filenames were checked: #169 carries 0040, #168 carries 0041, and #172 carries 0043. Main carries 0039. 0036/0037 stay unused; 0044 is after the highest occupied number. No migration was applied outside mocked/local Vitest D1.

Fresh main `f56f279dd90ddce69d3885c63c4c9fbf2c19b850` is integrated normally, including #169, #173, #170 and **merged #172**. Its guided assignment/scribe definitions are in `agent/owner-tools.ts`; dispatch remains in the shared core. Both channels expose 17 definitions. Its assignment catalogue, shared state, direct-owner proof and typed receipt-claim validation are preserved alongside channel-parity's previous-reply context. The production backup-restore registry and test migration lists preserve the order 0039 → 0040 → 0043 → 0044. The restore-cache test exercises that production registry.

The original allocation check covered all 11 open PRs; a second check covered all 10 then-open PRs and still found no competing 0044. The normal #158 merge preserved all 456/460 parent log headings, #169 preserved 461/463, #172 preserved 464/465, and #170 preserved 466/468, with zero missing. One read-only heading-verification command exceeded Node's default output buffer; the PowerShell heading comparison completed successfully. This was not a test or mutation result.

The streaming builder owns its loop and the PIN builder owns spoken-PIN proof. Neither is implemented here. The existing #159 gate remains claim-before-body, single use and no refund.

`CHANNEL-CONTINUITY-TRANSCRIPT` is deliberately separate: admitting voice-sent replies requires consistent role/channel/eligibility validation in recent history, literal/archive history and meaning-index ingestion, plus suppression of answers derived from forgotten owner turns. A one-line query expansion would bypass those checks and misrepresent relay send as Telegram delivery. Same-call owner-stated grounding uses the existing durable voice receipt; model-inferred confirmation still requires the shared tap. Neither makes that broader history claim.

## Evidence

Local synthetic providers, real adapters/repositories and local Vitest D1 only. **No full package or workspace suite ran on this PC.** Sid's 2026-09-24 resume instruction superseded the earlier full-local-suite request. The full workspace suite, including every cloud-gateway test and Telegram regression suite, is delegated to GitHub Actions. Its observed result and exact-head link will be posted in the PR and the external ledger after publication; no CI pass is assumed here.

After #172, the restored six-file focused run passed **97/0/0** and the final two changed provider/production files passed **186/0/0**. Both commands used `--maxWorkers=1 --no-file-parallelism`. The intervening selected production/backup run was **1/1/139**: backup restoration passed, while production parity failed before fetch. Changing only the provider catalogue bound from 16 to 32 made that named test pass **1/0/129**, establishing the cause. Both the old bound and removal of the bound were then mutation-checked. Earlier restored coverage passed 184/0/0 in nine files and 2/0/28 in the two selected supplemental checks. Filtered-out tests are reported as skipped, not passes.

The committed [47-case mutation spec](../../reviewer-tools/channel-parity-mutations.json) produced **47 confirmed kills, 0 wrong-test kills, 0 unconfirmed, 0 survived, 0 not applied, 0 invalid**. Each expected named test failed twice with the fault still present. The original 42 cases ran at `b2bad04f` and restored eight files byte-identically. Two supplemental cases after #169 at `126ddaab` removed its collector tool from voice and omitted 0044 from the production restore registry; two files were restored byte-identically. After #172 at `68a8bbb2`, removing `guided_assignment_save` from voice killed the named parity test twice (0/1/18 each), and its one file was restored byte-identically. Finally, the provider-bound sweep at `a0f66608` restored its one file byte-identically after two confirmed kills. The required dropped-`study_coach` mutation killed “offers tools that deep-equal Telegram and tells the model it is speaking on a call” twice (18/1/0 each). Restored tests passed after all four sweeps.

The repository runner's verdict logic was used with kill confirmation enabled. Its external copy adds raw logs and validates the absolute temporary-backup path before cleanup. Supplemental runs select only the affected test name; the final guided-tool sweep also uses one worker and serial files. One initial wrapper launch failed with one PowerShell parser error **before any mutation applied**; it is not a mutation verdict. Raw logs and continuity ledger are retained outside repositories at `C:\Users\Sid\codex-ledgers\channel-parity*`.

Source typecheck after #172: **exit 0, zero diagnostics**. All six observed source diagnostic counts, in order, are **4, 1, 0, 0, 0, 0**. Test typecheck remains a known non-gate: four observed runs each reported **143 diagnostics** (three branch runs and a live main baseline at `44a3058a`). The branch diagnostics matched that baseline after normalizing line/column offsets, including after #169; no diagnostic was in a new parity test. It was not repeated after #172. State-carrier validation is recorded in the PR after this documentation update.

No live model quality, acoustic transcription, real tap, latency percentile, production, remote migration rehearsal or complete cross-channel transcript acceptance is claimed. OWNER-ACTIONS contains the separately authorized 0044 rehearsal/apply/deploy and live acceptance. No sync-recovery/store-permissions files were changed. No streaming-loop rewrite or spoken PIN was implemented.

All test tuples below are **passed / failed / skipped**. A suite collection failure is listed separately from failed tests.

| Gate | P / F / S | Files | What the result established |
|---|---:|---|---|
| Focused iteration 1 | 25/5/0 | 2 failed; 1 passed (3) | Two fixture errors: voice used the Telegram repository marker; direct adapter input lacked the output cap. |
| Focused iteration 2 | 30/5/0 | 2 failed; 1 passed (3) | Three real Telegram-only database triggers, plus two empty confirmation outputs. |
| Voice diagnostic | 14/1/0 | 1 failed (1) | One confirmation refusal remained after exposing a nonempty result. |
| Migration-hook diagnostic | 0/0/15 | 1 failed (1) | One suite failed before tests: the migration hook ran before school tables. This is not a mutation result. |
| Exact-question diagnostic | 0/1/14 | 1 failed (1) | Named confirmation test failed; receipt paragraph delimiter rejected the exact question. |
| Focused iteration 4 | 23/0/0 | 2 passed (2) | Voice and real pipelines passed after fixes. |
| Related suites | 538/1/0 | 1 failed; 11 passed (12) | One old school-planner source-location assertion failed after the shared constructor move. |
| Focused iteration 5 | 40/0/0 | 2 passed (2) | Voice and corrected school-paste assertion. |
| Expanded voice tests | 19/0/0 | 1 passed (1) | Same-call boundaries, metadata and prompt coverage. |
| Migration tests | 21/0/0 | 1 passed (1) | 19 installed-trigger comparisons and two owner-isolation cases. |
| Restored files and main integration | 184/0/0 | 9 passed (9) | Nine related files after restoration, main integration and the production restore registration. |
| Restored extra mutations | 2/0/28 | 2 passed (2) | Voice parity and the production backup registry after the extra two mutations were restored. |
| Restored guided-assignment merge | 97/0/0 | 6 passed (6) | Six related files, serial with one worker, after #172 and the guided-tool mutation restoration. |
| Production composition and backup restore after #172 | 1/1/139 | 1 failed; 1 passed (2) | Production parity failed before fetch at the old 16-tool provider bound; the backup restore test passed. |
| Production composition after the bound fix | 1/0/129 | 1 passed (1) | The same named production test passed with the bound raised to 32; no other source changed for this diagnosis. |
| Restored provider and production files | 186/0/0 | 2 passed (2) | Two changed files, serial with one worker, after both provider-bound mutations were restored. |

Mutation baselines (one run per file):

| File | P / F / S |
|---|---:|
| `apps/cloud-gateway/test/voice/voice-agent.test.ts` | 19/0/0 |
| `apps/cloud-gateway/test/channels/owner-telegram-pipelines.integration.test.ts` | 8/0/0 |
| `apps/cloud-gateway/test/providers/deepseek-provider.test.ts` | 55/0/0 |
| `apps/cloud-gateway/test/school/school-paste.test.ts` | 22/0/0 |
| `apps/cloud-gateway/test/autonomy/tier3-agent-dispatch.test.ts` | 12/0/0 |
| `apps/cloud-gateway/test/persistence/channel-parity-migration.test.ts` | 21/0/0 |
| `apps/cloud-gateway/test/voice/voice-agent.test.ts (after main integration)` | 19/0/0 |
| `apps/cloud-gateway/test/backup/memory-backup-restore.test.ts (after main integration)` | 1/0/10 |
| `apps/cloud-gateway/test/voice/voice-agent.test.ts (after main integration)` | 1/0/18 |
| `apps/cloud-gateway/test/voice/call-session-do.test.ts (after main integration)` | 1/0/129 |
| `apps/cloud-gateway/test/providers/deepseek-provider.test.ts (after main integration)` | 1/0/55 |

Each mutation below was applied once, run, immediately rerun with the fault still present, then restored. The named test must fail on both runs to count as killed. Trigger cases compare SQLite-installed SQL with the previous installed definition, allowing only the channel predicate to change; the two migration ownership tests additionally execute invalid inserts and updates across three entry tables on both channels. These are preservation checks, not a claim of comprehensive adversarial coverage of all old triggers.

| Mutation | Expected named test | First P / F / S | Confirmation P / F / S | Verdict |
|---|---|---:|---:|---|
| `voice-drops-study-tool` | offers tools that deep-equal Telegram and tells the model it is speaking on a call | 18/1/0 | 18/1/0 | KILLED |
| `voice-drops-pipeline-dispatch` | owner voice agent validated feature pipelines > lets the agent choose school and preserves the existing validated save and receipt | 4/4/0 | 4/4/0 | KILLED |
| `voice-loses-staged-references` | confirms a staged model memory from a spoken yes on the same call with the real target finder | 18/1/0 | 18/1/0 | KILLED |
| `voice-inference-requires-missing-button` | confirms a staged model memory from a spoken yes on the same call with the real target finder | 18/1/0 | 18/1/0 | KILLED |
| `finder-drops-voice-references` | confirms a staged model memory from a spoken yes on the same call with the real target finder | 18/1/0 | 18/1/0 | KILLED |
| `confirmation-borrows-another-call` | refuses a spoken yes on another call even when the proposed memory is in context | 17/2/0 | 17/2/0 | KILLED |
| `confirmation-reads-a-future-reply` | does not use a reply sent after the current owner utterance as confirmation evidence | 18/1/0 | 18/1/0 | KILLED |
| `confirmation-lends-voice-to-telegram` | does not lend voice confirmation references to a Telegram turn with the same session label | 18/1/0 | 18/1/0 | KILLED |
| `metadata-allows-telegram-envelope` | rejects invalid reference metadata in a settled voice reply | 18/1/0 | 18/1/0 | KILLED |
| `metadata-allows-empty-ids` | rejects invalid reference metadata in a settled voice reply | 18/1/0 | 18/1/0 | KILLED |
| `metadata-allows-too-many-ids` | rejects invalid reference metadata in a settled voice reply | 18/1/0 | 18/1/0 | KILLED |
| `metadata-allows-invalid-ids` | rejects invalid reference metadata in a settled voice reply | 18/1/0 | 18/1/0 | KILLED |
| `metadata-allows-duplicate-ids` | rejects invalid reference metadata in a settled voice reply | 18/1/0 | 18/1/0 | KILLED |
| `metadata-allows-nonarray-ids` | rejects invalid reference metadata in a settled voice reply | 18/1/0 | 18/1/0 | KILLED |
| `confirmation-rejects-paragraph-delimiter` | confirms a staged model memory from a spoken yes on the same call with the real target finder | 18/1/0 | 18/1/0 | KILLED |
| `prompt-invents-a-previous-reply` | offers tools that deep-equal Telegram and tells the model it is speaking on a call | 18/1/0 | 18/1/0 | KILLED |
| `rewrite-drops-profile-and-medium` | keeps the call instructions and pinned profile when rewriting an unsupported action claim | 18/1/0 | 18/1/0 | KILLED |
| `recall-rejects-voice` | retrieves the same canonical memory and owner history on either channel | 18/1/0 | 18/1/0 | KILLED |
| `resolver-accepts-unregistered-pipeline` | refuses a tool that no channel-neutral catalogue gives a call, instead of running it | 18/1/0 | 18/1/0 | KILLED |
| `voice-uses-different-provider-policy` | uses the same configured thinking policy for an owner pipeline on voice | 54/1/0 | 54/1/0 | KILLED |
| `shared-planner-drops-profile-store` | wires the school planner to the production core-profile database | 21/1/0 | 21/1/0 | KILLED |
| `pipeline-bypasses-tier3-gate` | requires a tap before dispatching the tier-3 tool school_update on voice | 4/8/0 | 4/8/0 | KILLED |
| `memory-bypasses-tier3-gate` | requires a tap before dispatching the tier-3 tool memory_pin on voice | 11/1/0 | 11/1/0 | KILLED |
| `schema-owner-guard-school_course_cards_require_owner_turn_insert` | preserves every source and owner check while admitting voice in school_course_cards_require_owner_turn_insert | 18/3/0 | 18/3/0 | KILLED |
| `schema-owner-guard-school_course_cards_require_owner_turn_update` | preserves every source and owner check while admitting voice in school_course_cards_require_owner_turn_update | 18/3/0 | 18/3/0 | KILLED |
| `schema-owner-guard-school_course_facts_require_owner_turn` | preserves every source and owner check while admitting voice in school_course_facts_require_owner_turn | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-school_catchup_actions_require_plan_turn` | preserves every source and owner check while admitting voice in school_catchup_actions_require_plan_turn | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-school_catchup_turn_receipts_require_turn` | preserves every source and owner check while admitting voice in school_catchup_turn_receipts_require_turn | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-university_programs_require_owner_turn_insert` | preserves every source and owner check while admitting voice in university_programs_require_owner_turn_insert | 18/3/0 | 18/3/0 | KILLED |
| `schema-owner-guard-university_programs_require_owner_turn_update` | preserves every source and owner check while admitting voice in university_programs_require_owner_turn_update | 18/3/0 | 18/3/0 | KILLED |
| `schema-owner-guard-university_program_items_require_owner_turn` | preserves every source and owner check while admitting voice in university_program_items_require_owner_turn | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-university_tracker_turn_receipts_require_turn` | preserves every source and owner check while admitting voice in university_tracker_turn_receipts_require_turn | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-school_study_preferences_require_owner_turn_insert` | preserves every source and owner check while admitting voice in school_study_preferences_require_owner_turn_insert | 18/3/0 | 18/3/0 | KILLED |
| `schema-owner-guard-school_study_preferences_require_owner_turn_update` | preserves every source and owner check while admitting voice in school_study_preferences_require_owner_turn_update | 18/3/0 | 18/3/0 | KILLED |
| `schema-owner-guard-school_practice_items_source_guard` | preserves every source and owner check while admitting voice in school_practice_items_source_guard | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-school_practice_items_status_transition` | preserves every source and owner check while admitting voice in school_practice_items_status_transition | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-school_study_evidence_source_guard` | preserves every source and owner check while admitting voice in school_study_evidence_source_guard | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-school_study_evidence_status_transition` | preserves every source and owner check while admitting voice in school_study_evidence_status_transition | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-university_application_items_require_owner_turn_insert` | preserves every source and owner check while admitting voice in university_application_items_require_owner_turn_insert | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-university_application_items_require_owner_turn_update` | preserves every source and owner check while admitting voice in university_application_items_require_owner_turn_update | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-university_workflow_revisions_require_owner_turn` | preserves every source and owner check while admitting voice in university_workflow_revisions_require_owner_turn | 20/1/0 | 20/1/0 | KILLED |
| `schema-owner-guard-school_study_signal_controls_insert_guard` | preserves every source and owner check while admitting voice in school_study_signal_controls_insert_guard | 20/1/0 | 20/1/0 | KILLED |
| `voice-drops-new-main-collector-tool` | offers tools that deep-equal Telegram and tells the model it is speaking on a call | 18/1/0 | 18/1/0 | KILLED |
| `production-restore-loses-parity-migration` | downloads and hashes each verified object once before later restore steps use the durable cache | 0/1/10 | 0/1/10 | KILLED |
| `voice-drops-new-main-guided-assignment-tool` | offers tools that deep-equal Telegram and tells the model it is speaking on a call | 0/1/18 | 0/1/18 | KILLED |
| `provider-catalogue-bound-regresses-to-sixteen` | gives the production voice agent the same complete tool definitions as Telegram | 0/1/129 | 0/1/129 | KILLED |
| `provider-catalogue-size-guard-is-neutered` | accepts a bounded catalogue of thirty-two tools and refuses thirty-three before fetching | 0/1/55 | 0/1/55 | KILLED |

Observed mutation-run distribution: 36 runs at 18/1/0; 2 runs at 4/4/0; 2 runs at 17/2/0; 2 runs at 54/1/0; 2 runs at 21/1/0; 2 runs at 4/8/0; 2 runs at 11/1/0; 12 runs at 18/3/0; 26 runs at 20/1/0; 2 runs at 0/1/10; 2 runs at 0/1/18; 2 runs at 0/1/129; 2 runs at 0/1/55.
