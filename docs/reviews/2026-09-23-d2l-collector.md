# D2L collector receiving-end evidence

Local Windows / PowerShell checks, 2026-09-23 EDT (logs continue into 2026-09-24 UTC). Signed: Codex GPT-6 builder. No real school requests, Telegram delivery, database migration, deployment or local-agent test ran. No PC permissions, services, registry or scheduled tasks were changed.

## Revision and gates

Started from freshly fetched main `a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`; refreshed onto `a6a0efdf3bfe5c0b23e058b30afb5a9f70d70e8f` after #154 merged. The rebase preserved both OWNER-ACTIONS additions. Final executable feature code is `e5332f86dcedd67ebfc2a5705f7cb57ad31900ad`; later edits are documentation, corrected test expectations and a type-only Request annotation. Only cloud-gateway was changed as a package.

| Gate | Observed result |
|---|---|
| Full cloud-gateway suite, one run | **5150 passed / 5 failed / 0 skipped**; 190 passed files / 3 failed files |
| Corrected three files, full file rerun | **35 passed / 0 failed / 0 skipped**; all five failures resolved through test-only expectation changes |
| Collector files within the full run | 40 passed / 0 failed / 0 skipped |
| Final focused ingest and wiring | 20 passed / 0 failed / 0 skipped |
| Mutation coverage, final distinct cases | **80 killed / 0 survived / 0 unmatched / 0 invalid / 0 unconfirmed**, each with two named failing runs and a named restored pass |
| Product typecheck | Exit 0, 0 diagnostics |
| Test typecheck | Exit 1: 143 diagnostics outside collector files; 0 collector diagnostics. Not a clean gate |
| State check | Exit 0: 3 carriers, 0 reported failures |
| Whitespace check | Exit 0: 0 errors |

Full command: `npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test --reporter=default --reporter=json --outputFile=C:/Users/Sid/codex-ledgers/d2l-cloud-full.json`. No local-agent pytest or integration test ran. Gates are local evidence, not CI, live D1 or device acceptance.

The full run's five failures were stale expectations: four digest counts omitted the new collector gap, and one voice test expected only memory tools. These assertions now name the new gap/tools. The three affected files were rerun together: 35/0/0. Product code did not change. Following the one-full-run rule, the already-passing 190 files were not rerun. This is **not** described as one green full-suite run; it is one full run plus the corrected file results, with no unresolved failing file.

## What failed during development

- Initial security: 12 passed / 3 failed. A delivered decision had not been marked delivered; production records delivery after successful notification, and fixtures now simulate that event.
- Initial related six-file run: 100 passed / 8 failed. Restore expected the old seeded capability count. Correcting that and trigger formatting produced 10 passed / 0 failed / 0 skipped in the restore file, including the 5,000-row case.
- First two wiring attempts: 3 passed / 1 failed each. A synthetic Telegram subject violated its numeric contract; then the fixed-date pairing expired against real time. Corrected fixture identity and a Date-only test clock resolved these. A later collector run was 33 passed / 0 failed / 0 skipped before adding more guard cases.
- Expanded collector run: 36 passed / 1 failed. An isolated revoke test also failed (1 failed / 4 filtered skips). Its decision used fixture time, but the real autonomy service used wall time and treated it as stale. Injecting the same clock into that service produced 5 passed / 0 failed / 0 skipped in wiring.
- Test typing initially reported 149 diagnostics, including five new fixture errors. Those were fixed. After refreshing main it reported 143, with none in collector files. The new worker-router test then added one Request generic mismatch (144 total); the final annotation is type-only. The baseline was not independently remeasured, so no guessed explanation is assigned to the changed legacy count.

## Mutation method and corrections

The versioned [80-case specification](../../reviewer-tools/mutation-specs-d2l-collector.json) is literal-matched. The runner is a local copy of [mutate.ps1](../../reviewer-tools/mutate.ps1), additionally running the named test after each restoration, checking the resolved Temp backup parent before deletion, and using the named filter for fault runs after round one. Its exact copy and logs remain in `C:\Users\Sid\codex-ledgers`. No missing match is called a survivor. Round one was at `e09155efd9929ff1c4504e1683ad3e1705a797d7`; round two at `1ca890d33841`; round three at `e5332f86dcedd67ebfc2a5705f7cb57ad31900ad`.

| Round | Killed | Survived | Invalid | Unmatched | Unconfirmed | Byte-identical restored files |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 59 | 3 | 1 | 0 | 0 | 9 |
| 2 | 18 | 0 | 0 | 0 | 0 | 6 |
| 3 | 6 | 0 | 0 | 0 | 0 | 3 |

These are 87 attempts and 80 distinct final mutations; three already-killed cases were rechecked after route/fixture corrections. All 83 confirmed kills had named restored passes. File baselines were green before each round. Filtered skips in the table below are the other tests in that file, not skipped guard checks.

The three original survivors were handled explicitly:

- `school_time_future`: its fixture also violated fetched-time ordering. An empty route list isolates the read-start guard; it now fails when that guard is disabled.
- `tap-owner`: removing one redundant SQL predicate did not remove owner authorization. The final mutation removes all three application owner predicates, and a foreign configured owner using the legitimate response identity is refused by the baseline.
- `resource_list_invalid`: deleting the explicit array check still left a throwing `.map`. The corrected fault accepts malformed input as an empty list, disabling the actual refusal boundary.

Deleting the device-insert trigger originally stranded its preceding comment and broke the migration splitter before tests ran. A diagnostic reproduction yielded a suite error near `__JARVIS_TRIGGER_3__`, with 20 skipped tests; that was **INVALID**, not a kill. The final mutation preserves SQL structure and replaces its rejecting body with `SELECT 1`, producing a named failure and restored pass.

## Named final evidence

Every row below failed its named test twice under the planted fault. The last column is the actually observed restored test summary.

| Mutation | Named test | Final round | Restored result |
|---|---|---:|---|
| school_object_invalid | rejects malformed manifest, routes, source bindings and observation times | 1 | 1 passed / 17 skipped (18) |
| school_fields_invalid | rejects malformed manifest, routes, source bindings and observation times | 1 | 1 passed / 17 skipped (18) |
| school_id_invalid | rejects malformed manifest, routes, source bindings and observation times | 1 | 1 passed / 17 skipped (18) |
| school_source_invalid | rejects malformed manifest, routes, source bindings and observation times | 1 | 1 passed / 17 skipped (18) |
| school_time_future | rejects malformed manifest, routes, source bindings and observation times | 2 | 1 passed / 19 skipped (20) |
| school_manifest_invalid | rejects malformed manifest, routes, source bindings and observation times | 1 | 1 passed / 17 skipped (18) |
| school_routes_invalid | rejects malformed manifest, routes, source bindings and observation times | 1 | 1 passed / 17 skipped (18) |
| school_route_invalid | rejects malformed manifest, routes, source bindings and observation times | 2 | 1 passed / 19 skipped (20) |
| school_route_status_invalid | rejects malformed manifest, routes, source bindings and observation times | 1 | 1 passed / 17 skipped (18) |
| school_time_invalid | rejects malformed manifest, routes, source bindings and observation times | 1 | 1 passed / 17 skipped (18) |
| school_authority_invalid | refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes | 1 | 1 passed / 17 skipped (18) |
| school_signature_expired | refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes | 1 | 1 passed / 17 skipped (18) |
| school_signature_invalid | refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes | 1 | 1 passed / 17 skipped (18) |
| school_body_hash_invalid | refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes | 1 | 1 passed / 17 skipped (18) |
| school_nonce_refused | accepts a canonical signed course batch and refuses the same nonce twice | 1 | 1 passed / 17 skipped (18) |
| key-status | refuses pending and revoked keys even with otherwise valid signatures | 1 | 1 passed / 17 skipped (18) |
| pending-expiry | stops an expired pending key from polling or growing the nonce table | 1 | 1 passed / 17 skipped (18) |
| school_device_label_invalid | bounds public pairing and binds it to an active configured human owner | 1 | 1 passed / 17 skipped (18) |
| school_challenge_invalid | refuses a wrong challenge, an expired pairing, a reused challenge, and a rejected tap | 1 | 1 passed / 17 skipped (18) |
| school_challenge_consumed | refuses a wrong challenge, an expired pairing, a reused challenge, and a rejected tap | 1 | 1 passed / 17 skipped (18) |
| pairing-rate | bounds public pairing and binds it to an active configured human owner | 1 | 1 passed / 17 skipped (18) |
| pairing-owner | bounds public pairing and binds it to an active configured human owner | 2 | 1 passed / 19 skipped (20) |
| tap-identity | activates only the proved key after the owner confirms its exact decision | 1 | 1 passed / 17 skipped (18) |
| tap-owner | activates only the proved key after the owner confirms its exact decision | 2 | 1 passed / 19 skipped (20) |
| school_batch_conflict | refuses manifest changes and altered retries while identical retries retain one receipt | 1 | 1 passed / 11 skipped (12) |
| school_status_options_invalid | paginates every evidence row without crossing the owner boundary | 1 | 1 passed / 11 skipped (12) |
| batch-manifest | refuses manifest changes and altered retries while identical retries retain one receipt | 1 | 1 passed / 11 skipped (12) |
| failed-course | fails the whole read if any course fails and keeps the previous good read time | 1 | 1 passed / 11 skipped (12) |
| enrollment-completeness | requires every declared course and completed enrollment before advertising a good read | 1 | 1 passed / 11 skipped (12) |
| stale-state | marks stale and failed reads in the digest and never prints nothing due for either | 1 | 1 passed / 11 skipped (12) |
| evidence-owner | paginates every evidence row without crossing the owner boundary | 1 | 1 passed / 11 skipped (12) |
| mapping-http-complete | retains raw malformed or refused route evidence without projecting a short successful list | 1 | 1 passed / 11 skipped (12) |
| mapping-required-route | retains raw malformed or refused route evidence without projecting a short successful list | 1 | 1 passed / 11 skipped (12) |
| resource_title_invalid | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | 1 | 1 passed / 11 skipped (12) |
| resource_date_invalid | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | 1 | 1 passed / 11 skipped (12) |
| resource_list_invalid | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | 2 | 1 passed / 11 skipped (12) |
| grade_shape_unverified | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | 1 | 1 passed / 11 skipped (12) |
| ambiguous_content_date | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | 1 | 1 passed / 11 skipped (12) |
| duplicate_resource | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | 1 | 1 passed / 11 skipped (12) |
| resource-identity | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | 1 | 1 passed / 11 skipped (12) |
| date-priority | prefers myItems dates then assignment DueDate then availability end and labels each source | 2 | 1 passed / 11 skipped (12) |
| positive-submission | keeps empty submissions and denied folder counts as evidence and only labels a positive own status submitted | 1 | 1 passed / 11 skipped (12) |
| undated-retention | maps the observed null DueDate through its linked module and retains undated work | 1 | 1 passed / 11 skipped (12) |
| http-body-cap | refuses oversized streaming bodies without trusting Content-Length | 1 | 1 passed / 17 skipped (18) |
| http-target | refuses wrong methods, unknown paths, query strings, missing owner and malformed envelopes | 1 | 1 passed / 17 skipped (18) |
| http-configured | does not advertise activation when delivery fails | 1 | 1 passed / 3 skipped (4) |
| pair-delivery | delivers the proved pairing decision and activates it through the real Telegram tap handler | 1 | 1 passed / 3 skipped (4) |
| tap-routing | delivers the proved pairing decision and activates it through the real Telegram tap handler | 1 | 1 passed / 3 skipped (4) |
| tool-dispatch | hands the model D2L evidence through the real tool dispatcher without an action receipt | 1 | 1 passed / 3 skipped (4) |
| digest-stale | marks stale and failed reads in the digest and never prints nothing due for either | 1 | 1 passed / 11 skipped (12) |
| digest-unavailable | keeps an unavailable collector status visible in the digest | 1 | 1 passed / 3 skipped (4) |
| school_collector_insert_guard | refuses directly inserted active keys and malformed public keys at the database boundary | 1 | 1 passed / 17 skipped (18) |
| school_collector_key_immutable | keeps collector key identity immutable and refuses key reuse in the device registry | 1 | 1 passed / 17 skipped (18) |
| school_collector_activation_guard | keeps collector key identity immutable and refuses key reuse in the device registry | 1 | 1 passed / 17 skipped (18) |
| school_collector_device_insert_guard | keeps collector key identity immutable and refuses key reuse in the device registry | 2 | 1 passed / 19 skipped (20) |
| school_collector_device_update_guard | refuses a collector key during ordinary device rotation and refuses an existing device key for pairing | 1 | 1 passed / 17 skipped (18) |
| school_collector_read_immutable | refuses manifest changes and altered retries while identical retries retain one receipt | 1 | 1 passed / 11 skipped (12) |
| school_collector_evidence_immutable | preserves later projected dates when an older device read arrives and keeps immutable evidence | 1 | 1 passed / 11 skipped (12) |
| school_collector_evidence_retained | preserves later projected dates when an older device read arrives and keeps immutable evidence | 1 | 1 passed / 11 skipped (12) |
| school_collector_deadline_order | preserves later projected dates when an older device read arrives and keeps immutable evidence | 1 | 1 passed / 11 skipped (12) |
| public-key-length | refuses directly inserted active keys and malformed public keys at the database boundary | 1 | 1 passed / 17 skipped (18) |
| batch-hash | refuses a malformed body hash and an invented batch outcome at the database boundary | 1 | 1 passed / 11 skipped (12) |
| batch-status | refuses a malformed body hash and an invented batch outcome at the database boundary | 1 | 1 passed / 11 skipped (12) |
| school_key_inactive | refuses pending and revoked keys even with otherwise valid signatures | 2 | 1 passed / 19 skipped (20) |
| school_pairing_unavailable | bounds public pairing and binds it to an active configured human owner | 2 | 1 passed / 19 skipped (20) |
| pairing-owner-active | bounds public pairing and binds it to an active configured human owner | 2 | 1 passed / 19 skipped (20) |
| signing-owner-active | refuses an active collector whose owner has been disabled | 2 | 1 passed / 19 skipped (20) |
| revoke-race | refuses a revocation racing verification before inserting the nonce | 2 | 1 passed / 19 skipped (20) |
| revoke-owner | refuses pending and revoked keys even with otherwise valid signatures | 2 | 1 passed / 19 skipped (20) |
| revoke-terminal | refuses pending and revoked keys even with otherwise valid signatures | 2 | 1 passed / 19 skipped (20) |
| key-status-check | refuses directly inserted active keys and malformed public keys at the database boundary | 2 | 1 passed / 19 skipped (20) |
| revoke-dispatch | revokes through the owner tool only after its tier-three confirmation tap | 2 | 1 passed / 4 skipped (5) |
| revoke-tier | revokes through the owner tool only after its tier-three confirmation tap | 2 | 1 passed / 4 skipped (5) |
| voice-school-tools | gives an owner's call the memory and school tools through the voice agent adapter the production runtime composes | 2 | 1 passed / 129 skipped (130) |
| projection-rejected | fails the read when deadline ingestion rejects an item and preserves the raw evidence | 3 | 1 passed / 13 skipped (14) |
| projection-thrown | fails the read when deadline persistence throws and preserves the raw evidence | 3 | 1 passed / 13 skipped (14) |
| projection-older | preserves later projected dates when an older device read arrives and keeps immutable evidence | 3 | 1 passed / 13 skipped (14) |
| projection-retry | refuses manifest changes and altered retries while identical retries retain one receipt | 3 | 1 passed / 13 skipped (14) |
| worker-school-route | receives a signed course batch through the production worker router | 3 | 1 passed / 5 skipped (6) |
| pairing-activate-once | activates only the proved key after the owner confirms its exact decision | 3 | 1 passed / 19 skipped (20) |

## Premises and acceptance limits

- #161 at `63ae51d2ebfe18470d5a36a7fc9ec9e1a11b3618` and #160 at `9092950c45bf923bfff559e669af4f29a9efcdf6` were open, not merged, when inspected. #160 informed isolation/pairing/security only. No live D2L claim is made from these local tests.
- #161 observed the entity `submissions/` response, not `mysubmissions/`, and did not observe myItems or populated grades/submissions. Fixtures preserve its documented shapes with invented values; myItems and positive own-status examples are explicitly synthetic. Unknown shapes fail the read while retaining evidence.
- #163's probe showed that myItems is a global content route with `orgUnitIdsCSV`. The initial course-path assumption was corrected and mutation-checked. Its probe does not sign or upload; a production extension adapter remains separate builder work.
- #159 initially claimed 0040 despite its assigned 0039. At `ebd02ca1f5e6e3a0a0f881abcb0547e5bca1cd0d` it correctly uses 0039. This receiver keeps assigned 0040; 0036/0037 remain unused. Rollout must preserve assigned migration order. Shared wiring/backup files will need normal integration with #159; this branch does not merge it.
- No #157 runtime/test files, sync handlers, sync-service, device repository, contracts sync module or local-agent files were changed. The only existing signed-request edits export three pure helpers, preserving its verifier logic.
- The requested PC-incident file was absent. This task stayed with mocked cloud tests and never invoked permission-changing or local-agent code. Remote D1 SQL behavior, real Opera GX session transport, real delivery, populated response shapes, and live completeness remain unverified. Owner-only steps are in [OWNER-ACTIONS](../OWNER-ACTIONS.md).
