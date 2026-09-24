# D2L collector review round 1

Signed: Codex GPT-6 builder, 2026-09-23 EDT. This answers the [independent review of 5abba94](https://github.com/stremysid/jarvis/pull/169#issuecomment-5806221250), read in full before changes. The earlier [build evidence](2026-09-23-d2l-collector.md) remains historical; its counts are not this round's gates.

**The upload contract is unchanged:** same `/school/*` routes, SignedRequestV1 semantics, audience, pairing request/response bodies and per-course batch format. Read-tool output adds `refusedTruncated` and `lastGoodReadUndatedItems`. Pairing's existing four-start budget is now per configured principal. No extension update is required for these fixes.

Merged freshly fetched `origin/main` at `c92078b964cf9a8ce22ee8494714da332e4f553b` (including #159 at `6e3f1ef`) in merge commit `ff3ae31`; no rebase or force-push. Four migration/backup list conflicts retain 0039 before 0040 and schema version 0040. Both complete AGENT_LOG blocks and the current QUEUE allocation row were preserved. Initial executable fixes and mutation specs are at `aa094f98a2602463b117e60996d81529ce0df969`; final executable changes are at `72094aea19dac430b309ccc564099d8569933eb1`.

The merged revoke test first failed exactly as reviewed: the collector was already revoked before any tap. Both school branches now validate all arguments before calling the existing gate. Status gets an autonomy audit and obeys refusal; revocation claims one matching tap before its body. Invalid arguments do not consume a standing tap.

Complete per-tool 403s now contribute no items from that tool while remaining raw evidence and appearing in `refused`. Tests cover grades and myItems with current state and projected deadlines, required-tool 403s, and continuing failures for transport, redirects, 401, 5xx, incomplete 403s and unfamiliar successful shapes. The failed-course fixture now uses 401, since 403 is expressly normal.

Read status queries use separate `LIMIT 1` aggregates for latest and last complete good read. Limiting a single history window would forget the last success after a long failure streak; the separate query preserves it. Refusals are sampled from the latest read with a SQL limit, the requested output limit, and explicit truncation. Every historical row remains available through evidence pagination. Tests observe actual SQL row counts, so removing LIMIT cannot be masked by slicing the JavaScript result.

Undated counts come from each batch once in the latest complete good read, not repeated raw-route rows or historical reads. A current digest states the count with no known date; stale/failed coverage still gets its existing protected gap. Code does not infer missed or submitted work.

The existing activation trigger now has a direct database-boundary non-Telegram test, bypassing the equivalent app predicate. `activateFromDecision` explicitly compares the response time with `school_collector_keys.expires_at`. Per-principal pairing isolation is tested. Pruning expired pending keys/nonces, public single-owner budget exhaustion, course-source retirement and duplicate-tap wording remain explicit [known gaps](../../KNOWN_ISSUES.md#school-collector-retention-and-public-pairing-remain-bounded-only-in-part); the user permitted documenting retention instead of introducing cleanup in this round.

No production, deploy tree, real DB, secret, real school/Telegram call, PC permission/service/task/registry operation or local-agent test was touched. The requested incident file is still absent. Live browser acceptance, remote D1 behavior and real delivery remain unverified and owner actions stay in [OWNER-ACTIONS](../OWNER-ACTIONS.md).

## Reproductions and focused checks

| Run | Passed | Failed | Skipped | What it established |
|---|---:|---:|---:|---|
| Merged revoke reproduction | 0 | 1 | 5 | The reported ungated revocation reproduced |
| Expanded collector tests before fixes | 41 | 10 | 0 | Every requested high/medium issue and cross-principal pairing interference reproduced |
| First fixed collector run | 50 | 1 | 0 | The new status-tier fixture contaminated the later read test |
| That read test in isolation | 1 | 0 | 8 | It passes without the earlier fixture mutation |
| Collector after restoring the fixture's shared tier | 51 | 0 | 0 | All three collector files pass together |

The capability fixture now restores `school.track` after each test. The real confirmation store also receives the fixture clock, matching #159's new time-bound tap claim. Neither is a production-policy relaxation.

An additional focused shape probe found that a successful submissions response with a null container was classified as good: **0 passed / 1 failed / 20 skipped**. The mapper now requires successful submissions to have an object container, preserving the observed empty object and the existing own-submission adapter. Nulls, arrays, strings and booleans fail, while complete 403 containers remain unparsed refusals. No route or payload format changed. After the fix at `72094aea`, all collector files passed **52 / 0 / 0**; all 17 affected mapping mutations were rerun before the full package gate.

## Final gates

| Gate | Observed result |
|---|---|
| Full cloud-gateway suite, once on the merged tree | **5192 passed / 0 failed / 0 skipped**, 196 files |
| Collector focused run and within the full suite | **52 passed / 0 failed / 0 skipped**, 3 files |
| Mutation specifications | **103 killed / 0 survived / 0 not applied / 0 invalid / 0 unconfirmed / 0 wrong-test kills**; two named red runs and a named restored pass each |
| Source typecheck | Exit 0, zero diagnostics |
| Test typecheck | Exit 1, **143 diagnostics outside collector files, zero collector diagnostics**; not a clean gate |
| State checker | Exit 0; 3 carriers and FACTS register passed, 0 warnings |
| Whitespace check | Exit 0; 0 whitespace errors |


Full command: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test --reporter=default --reporter=json --outputFile=C:/Users/Sid/codex-ledgers/d2l-r1-cloud-full.json`. Test counts come from the actual JSON result, not static test inventory. No unrelated known-flaky failure needed a rerun. Source code was unchanged after its passing typecheck. Test typing remains a non-green, non-CI legacy check; no independent refreshed-main typing count was measured, so no guessed cause is assigned to its total.

## Named mutation evidence

The [versioned specification](../../reviewer-tools/mutation-specs-d2l-collector.json) has 103 distinct cases. The full merged-tree sweep at `aa094f9` killed all 101 original/round-one cases and restored 10 files byte-for-byte. After the submissions-container correction at `72094aea`, all 17 mapping cases (15 rechecks plus two new guards) were killed and that file was restored byte-for-byte. Thus **118 attempts, 118 confirmed kills, 103 distinct cases, zero survivors/unapplied/invalid/unconfirmed/wrong-test outcomes**. Other mutation target files did not change between the sweeps.

The external runner is the same restored-pass-enhanced copy of `reviewer-tools/mutate.ps1` used in the original build. Each file baseline passed, each literal edit matched exactly once, each named mutant failed twice, and each restored named test passed. Logs and the runner remain outside the repository under `C:\Users\Sid\codex-ledgers`. Filtered skips below are other tests in that file, not untested guards.

| Mutation | Named test | Fault runs | Restored result |
|---|---|---|---|
| school_object_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_fields_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_id_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_source_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_time_future | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_manifest_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_routes_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_route_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_route_status_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_time_invalid | rejects malformed manifest, routes, source bindings and observation times | named failure twice | 1 passed / 21 skipped (22) |
| school_authority_invalid | refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes | named failure twice | 1 passed / 21 skipped (22) |
| school_signature_expired | refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes | named failure twice | 1 passed / 21 skipped (22) |
| school_signature_invalid | refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes | named failure twice | 1 passed / 21 skipped (22) |
| school_body_hash_invalid | refuses altered audience, owner, target, signature, timestamp, hash and noncanonical bytes | named failure twice | 1 passed / 21 skipped (22) |
| school_nonce_refused | accepts a canonical signed course batch and refuses the same nonce twice | named failure twice | 1 passed / 21 skipped (22) |
| key-status | refuses pending and revoked keys even with otherwise valid signatures | named failure twice | 1 passed / 21 skipped (22) |
| pending-expiry | stops an expired pending key from polling or growing the nonce table | named failure twice | 1 passed / 21 skipped (22) |
| school_device_label_invalid | bounds public pairing and binds it to an active configured human owner | named failure twice | 1 passed / 21 skipped (22) |
| school_challenge_invalid | refuses a wrong challenge, an expired pairing, a reused challenge, and a rejected tap | named failure twice | 1 passed / 21 skipped (22) |
| school_challenge_consumed | refuses a wrong challenge, an expired pairing, a reused challenge, and a rejected tap | named failure twice | 1 passed / 21 skipped (22) |
| pairing-rate | bounds public pairing and binds it to an active configured human owner | named failure twice | 1 passed / 21 skipped (22) |
| pairing-owner | bounds public pairing and binds it to an active configured human owner | named failure twice | 1 passed / 21 skipped (22) |
| tap-identity | activates only the proved key after the owner confirms its exact decision | named failure twice | 1 passed / 21 skipped (22) |
| tap-owner | activates only the proved key after the owner confirms its exact decision | named failure twice | 1 passed / 21 skipped (22) |
| school_batch_conflict | refuses manifest changes and altered retries while identical retries retain one receipt | named failure twice | 1 passed / 19 skipped (20) |
| school_status_options_invalid | paginates every evidence row without crossing the owner boundary | named failure twice | 1 passed / 19 skipped (20) |
| batch-manifest | refuses manifest changes and altered retries while identical retries retain one receipt | named failure twice | 1 passed / 19 skipped (20) |
| failed-course | fails the whole read if any course fails and keeps the previous good read time | named failure twice | 1 passed / 19 skipped (20) |
| enrollment-completeness | requires every declared course and completed enrollment before advertising a good read | named failure twice | 1 passed / 19 skipped (20) |
| stale-state | marks stale and failed reads in the digest and never prints nothing due for either | named failure twice | 1 passed / 19 skipped (20) |
| evidence-owner | paginates every evidence row without crossing the owner boundary | named failure twice | 1 passed / 19 skipped (20) |
| mapping-http-complete | retains raw malformed or refused route evidence without projecting a short successful list | named failure twice | 1 passed / 20 skipped (21) |
| mapping-required-route | retains raw malformed or refused route evidence without projecting a short successful list | named failure twice | 1 passed / 20 skipped (21) |
| resource_title_invalid | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | named failure twice | 1 passed / 20 skipped (21) |
| resource_date_invalid | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | named failure twice | 1 passed / 20 skipped (21) |
| resource_list_invalid | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | named failure twice | 1 passed / 20 skipped (21) |
| grade_shape_unverified | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | named failure twice | 1 passed / 20 skipped (21) |
| ambiguous_content_date | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | named failure twice | 1 passed / 20 skipped (21) |
| duplicate_resource | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | named failure twice | 1 passed / 20 skipped (21) |
| resource-identity | refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes | named failure twice | 1 passed / 20 skipped (21) |
| date-priority | prefers myItems dates then assignment DueDate then availability end and labels each source | named failure twice | 1 passed / 20 skipped (21) |
| positive-submission | keeps empty submissions and denied folder counts as evidence and only labels a positive own status submitted | named failure twice | 1 passed / 20 skipped (21) |
| undated-retention | maps the observed null DueDate through its linked module and retains undated work | named failure twice | 1 passed / 20 skipped (21) |
| http-body-cap | refuses oversized streaming bodies without trusting Content-Length | named failure twice | 1 passed / 21 skipped (22) |
| http-target | refuses wrong methods, unknown paths, query strings, missing owner and malformed envelopes | named failure twice | 1 passed / 21 skipped (22) |
| http-configured | does not advertise activation when delivery fails | named failure twice | 1 passed / 8 skipped (9) |
| pair-delivery | delivers the proved pairing decision and activates it through the real Telegram tap handler | named failure twice | 1 passed / 8 skipped (9) |
| tap-routing | delivers the proved pairing decision and activates it through the real Telegram tap handler | named failure twice | 1 passed / 8 skipped (9) |
| tool-dispatch | hands the model D2L evidence through the real tool dispatcher without an action receipt | named failure twice | 1 passed / 8 skipped (9) |
| digest-stale | marks stale and failed reads in the digest and never prints nothing due for either | named failure twice | 1 passed / 19 skipped (20) |
| digest-unavailable | keeps an unavailable collector status visible in the digest | named failure twice | 1 passed / 8 skipped (9) |
| school_collector_insert_guard | refuses directly inserted active keys and malformed public keys at the database boundary | named failure twice | 1 passed / 21 skipped (22) |
| school_collector_key_immutable | keeps collector key identity immutable and refuses key reuse in the device registry | named failure twice | 1 passed / 21 skipped (22) |
| school_collector_activation_guard | keeps collector key identity immutable and refuses key reuse in the device registry | named failure twice | 1 passed / 21 skipped (22) |
| school_collector_device_insert_guard | keeps collector key identity immutable and refuses key reuse in the device registry | named failure twice | 1 passed / 21 skipped (22) |
| school_collector_device_update_guard | refuses a collector key during ordinary device rotation and refuses an existing device key for pairing | named failure twice | 1 passed / 21 skipped (22) |
| school_collector_read_immutable | refuses manifest changes and altered retries while identical retries retain one receipt | named failure twice | 1 passed / 19 skipped (20) |
| school_collector_evidence_immutable | preserves later projected dates when an older device read arrives and keeps immutable evidence | named failure twice | 1 passed / 19 skipped (20) |
| school_collector_evidence_retained | preserves later projected dates when an older device read arrives and keeps immutable evidence | named failure twice | 1 passed / 19 skipped (20) |
| school_collector_deadline_order | preserves later projected dates when an older device read arrives and keeps immutable evidence | named failure twice | 1 passed / 19 skipped (20) |
| public-key-length | refuses directly inserted active keys and malformed public keys at the database boundary | named failure twice | 1 passed / 21 skipped (22) |
| batch-hash | refuses a malformed body hash and an invented batch outcome at the database boundary | named failure twice | 1 passed / 19 skipped (20) |
| batch-status | refuses a malformed body hash and an invented batch outcome at the database boundary | named failure twice | 1 passed / 19 skipped (20) |
| school_key_inactive | refuses pending and revoked keys even with otherwise valid signatures | named failure twice | 1 passed / 21 skipped (22) |
| school_pairing_unavailable | bounds public pairing and binds it to an active configured human owner | named failure twice | 1 passed / 21 skipped (22) |
| pairing-owner-active | bounds public pairing and binds it to an active configured human owner | named failure twice | 1 passed / 21 skipped (22) |
| signing-owner-active | refuses an active collector whose owner has been disabled | named failure twice | 1 passed / 21 skipped (22) |
| revoke-race | refuses a revocation racing verification before inserting the nonce | named failure twice | 1 passed / 21 skipped (22) |
| revoke-owner | refuses pending and revoked keys even with otherwise valid signatures | named failure twice | 1 passed / 21 skipped (22) |
| revoke-terminal | refuses pending and revoked keys even with otherwise valid signatures | named failure twice | 1 passed / 21 skipped (22) |
| key-status-check | refuses directly inserted active keys and malformed public keys at the database boundary | named failure twice | 1 passed / 21 skipped (22) |
| revoke-dispatch | revokes through the owner tool only after its tier-three confirmation tap | named failure twice | 1 passed / 8 skipped (9) |
| revoke-tier | revokes through the owner tool only after its tier-three confirmation tap | named failure twice | 1 passed / 8 skipped (9) |
| voice-school-tools | gives an owner's call the memory and school tools through the voice agent adapter the production runtime composes | named failure twice | 1 passed / 129 skipped (130) |
| projection-rejected | fails the read when deadline ingestion rejects an item and preserves the raw evidence | named failure twice | 1 passed / 19 skipped (20) |
| projection-thrown | fails the read when deadline persistence throws and preserves the raw evidence | named failure twice | 1 passed / 19 skipped (20) |
| projection-older | preserves later projected dates when an older device read arrives and keeps immutable evidence | named failure twice | 1 passed / 19 skipped (20) |
| projection-retry | refuses manifest changes and altered retries while identical retries retain one receipt | named failure twice | 1 passed / 19 skipped (20) |
| worker-school-route | receives a signed course batch through the production worker router | named failure twice | 1 passed / 8 skipped (9) |
| pairing-activate-once | activates only the proved key after the owner confirms its exact decision | named failure twice | 1 passed / 21 skipped (22) |
| status-gate | gates school status before reading evidence and records its refusal in the autonomy audit | named failure twice | 1 passed / 8 skipped (9) |
| revoke-gate | revokes through the owner tool only after its tier-three confirmation tap | named failure twice | 1 passed / 8 skipped (9) |
| status-validate-before-claim | validates school_d2l_status arguments before spending a matching confirmation tap | named failure twice | 1 passed / 8 skipped (9) |
| revoke-validate-before-claim | validates school_collector_revoke arguments before spending a matching confirmation tap | named failure twice | 1 passed / 8 skipped (9) |
| mapping-403-normal | records a grades 403 without failing the read or hiding available deadlines | named failure twice | 1 passed / 20 skipped (21) |
| mapping-http-failed | keeps required tool refusals empty while failing transport, authentication, incomplete and unfamiliar results | named failure twice | 1 passed / 20 skipped (21) |
| mapping-incomplete-403 | keeps required tool refusals empty while failing transport, authentication, incomplete and unfamiliar results | named failure twice | 1 passed / 20 skipped (21) |
| pairing-principal-budget | keeps pairing budgets separate for each configured principal | named failure twice | 1 passed / 21 skipped (22) |
| activation-trigger-telegram | refuses activation through a non-Telegram identity at the database boundary | named failure twice | 1 passed / 21 skipped (22) |
| latest-read-limit | returns at most one row from each read aggregate while retaining the last complete good read | named failure twice | 1 passed / 19 skipped (20) |
| good-read-limit | returns at most one row from each read aggregate while retaining the last complete good read | named failure twice | 1 passed / 19 skipped (20) |
| last-good-completeness | requires every declared course and completed enrollment before advertising a good read | named failure twice | 1 passed / 19 skipped (20) |
| refused-read-scope | bounds refusals to the latest read and requested limit without losing the older good read time | named failure twice | 1 passed / 19 skipped (20) |
| refused-sql-limit | bounds refusals to the latest read and requested limit without losing the older good read time | named failure twice | 1 passed / 19 skipped (20) |
| refused-output-limit | bounds refusals to the latest read and requested limit without losing the older good read time | named failure twice | 1 passed / 19 skipped (20) |
| refused-truncation-visible | bounds refusals to the latest read and requested limit without losing the older good read time | named failure twice | 1 passed / 19 skipped (20) |
| undated-good-read-scope | counts undated work from the latest good whole read and names it in a current digest | named failure twice | 1 passed / 19 skipped (20) |
| undated-only | counts undated work from the latest good whole read and names it in a current digest | named failure twice | 1 passed / 19 skipped (20) |
| digest-undated | counts undated work from the latest good whole read and names it in a current digest | named failure twice | 1 passed / 19 skipped (20) |
| digest-undated-current | counts undated work from the latest good whole read and names it in a current digest | named failure twice | 1 passed / 19 skipped (20) |
| digest-undated-positive | counts undated work from the latest good whole read and names it in a current digest | named failure twice | 1 passed / 19 skipped (20) |
| submission-container | fails unfamiliar successful submission containers while retaining complete submission refusals | named failure twice | 1 passed / 20 skipped (21) |
| submission-refusal-shape | fails unfamiliar successful submission containers while retaining complete submission refusals | named failure twice | 1 passed / 20 skipped (21) |
