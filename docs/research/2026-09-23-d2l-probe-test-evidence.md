# D2L probe local evidence — 2026-09-23

## Review hardening round (latest)

Normal merge `fdc2cd05741065985e7a3d335ae106309b9988f9` brought in main at
`a6a0efdf3bfe5c0b23e058b30afb5a9f70d70e8f`, preserving both log insertions and owner
rows. The probe's single owner action supersedes #160's overlapping requests.

| Gate | Observed result |
|---|---|
| Focused host, network and permission tests | **3 pass / 0 fail / 0 skip** |
| `node --test apps/d2l-extension/test/*.test.js`, full suite once this round | **35 pass / 0 fail / 0 skip**, 0 cancelled, 0 todo |
| `node apps/d2l-extension/test/mutate.js`, complete sweep | **51 killed / 0 unconfirmed / 0 NOT APPLIED** |
| `node scripts/check-state.mjs` | **pass**, 3 carriers |
| New PowerShell load block, parser only | **0 syntax errors**, not executed |

All 51 mutations had **1/0/0** baseline and restored counts and **0/1/0** counts
in each of two faulted runs. The original 46 cases below were rerun; the manifest
permission test is now named `It grants only the LDSB host and storage in Manifest V3.`,
and its mutation reintroduces `alarms`. These five cases were added:

| Mutation | Named test | Baseline | Mutated | Confirmed | Restored |
|---|---|---|---|---|---|
| H1 literal API host | It pins every route to the literal LDSB HTTPS origin. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| H9 popup fetch | It permits only the probe read fetch call across every runtime script and popup asset. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| popup HTML EventSource | It permits only the probe read fetch call across every runtime script and popup asset. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| remote worker import | It permits only the probe read fetch call across every runtime script and popup asset. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| second transport fetch call | It permits only the probe read fetch call across every runtime script and popup asset. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |

## Initial build (historical)

Builder: Codex. Base: `a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`. Windows PowerShell 7.6.6, Node 24.19.0.

Only `apps/d2l-extension` application code changed. All fetch, browser APIs and clipboard tests are mocked. No Opera GX or real D2L test was run.

| Gate | Observed result |
|---|---|
| Initial focused API tests | 17 pass, 0 fail, 0 skip |
| Initial focused wiring tests | 12 pass, 0 fail, 0 skip |
| Added timeout and real-listener wiring tests | 2 pass, 0 fail, 0 skip |
| Startup-error regression before fix | 0 pass, 1 fail, 0 skip: `It rejects a failed tab preflight instead of presenting an old report as a completed pass.` |
| Final full package suite, run once | **33 pass, 0 fail, 0 skip**, 0 cancelled, 0 todo |
| Mutations, latest covering batches (44 + 2) | **46 killed, 0 unconfirmed, 0 NOT APPLIED** |
| `node scripts/check-state.mjs` | **pass**, 3 carriers; no failures reported |
| `node --check` on the 5 runtime JS files | **5 pass**, 0 fail |

The failed regression proved the controller swallowed a tab-query rejection before a report existed. It now rejects that preflight with a fixed error, and the popup receives `done: false`. The named test passed at baseline and restoration in the final mutation batch and in the full suite.

The final suite command was `pnpm --filter @jarvis/d2l-extension test`. pnpm also linked the workspace's cached dependencies (94 packages, 0 downloads) and accepted the lockfile; no other package's suite was invoked. No unrelated flaky tests failed or were rerun.

## Named mutation evidence

Every row records pass/fail/skip counts. Each mutation matched exactly once, was read back after application, and was restored byte-for-byte. The two mutated runs both failed the named test. The runner also normalizes only the match/replacement line endings for Windows checkouts; its backup/restoration remains byte-exact.

Reproduce: `node apps/d2l-extension/test/mutate.js`. An optional list of mutation names runs only those cases during iteration.

| Guard or invariant | Named test | Baseline | Mutated | Confirmed | Restored |
|---|---|---|---|---|---|
| manifest host scope | It grants only the LDSB host and alarms and storage in Manifest V3. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| manifest permission scope | It grants only the LDSB host and alarms and storage in Manifest V3. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| content host scope | It grants only the LDSB host and alarms and storage in Manifest V3. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| content isolation | It grants only the LDSB host and alarms and storage in Manifest V3. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| connect scope | It grants only the LDSB host and alarms and storage in Manifest V3. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| schema key allowlist | It reports nested field presence and nulls without printing values or unknown keys. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| scalar redaction | It distinguishes empty arrays, empty objects, lists and Objects envelopes. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| null field distinction | It reports nested field presence and nulls without printing values or unknown keys. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| array shape distinction | It distinguishes empty arrays, empty objects, lists and Objects envelopes. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| null body distinction | It distinguishes empty arrays, empty objects, lists and Objects envelopes. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| Objects envelope distinction | It distinguishes empty arrays, empty objects, lists and Objects envelopes. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| nested array traversal | It reports nested field presence and nulls without printing values or unknown keys. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| nested object traversal | It reports nested field presence and nulls without printing values or unknown keys. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| route allowlist | It refuses unknown routes and path injection before calling fetch. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| identifier validation | It refuses unknown routes and path injection before calling fetch. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| GET only | It hard-codes GET and forbids redirect following and request bodies. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| no redirect follow | It hard-codes GET and forbids redirect following and request bodies. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| session credentials | It hard-codes GET and forbids redirect following and request bodies. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| request timeout | It supplies a fifteen-second abort signal to the fetch transport. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| opaque response refusal | It refuses redirected and opaque responses without reading their bodies. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| redirected response refusal | It refuses redirected and opaque responses without reading their bodies. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| 3xx response refusal | It refuses redirected and opaque responses without reading their bodies. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| HTML body refusal | It refuses HTML and missing content types without reading web pages. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| successful status discovery | It does not treat refused enrollments as a successful discovery. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| transport error discovery refusal | It stops discovery when a transport error accompanies a nominal success status. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| enrollment shape check | It reports unexpected enrollment shapes instead of claiming there are no courses. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| access eligibility | It discovers all accessible enrollment pages and probes every folder through the student route. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| enrollment pagination continuation | It discovers all accessible enrollment pages and probes every folder through the student route. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| bookmark type check | It stops missing or repeated enrollment bookmarks without following response URLs. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| empty bookmark check | It stops missing or repeated enrollment bookmarks without following response URLs. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| repeated bookmark check | It stops missing or repeated enrollment bookmarks without following response URLs. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| folder status check | It continues unrelated routes after refusals and does not discover folders from errors. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| folder shape check | It reports unexpected folder shapes as unprobed submissions. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| student submission route | It discovers all accessible enrollment pages and probes every folder through the student route. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| run lock | It prevents a duplicate click from starting a second concurrent pass. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| tab context choice | It runs open-tab requests through the content script and retains the background comparison. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| before-fetch no-tab check | It interrupts a background pass when a D2L tab opens before a request. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| after-fetch no-tab check | It interrupts a background pass when a D2L tab opens during a request. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| popup extension identity | It accepts probe commands only from this extension popup. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| popup source check | It accepts probe commands only from this extension popup. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| popup command check | It accepts probe commands only from this extension popup. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| content extension identity | It accepts content reads only from its extension and never from a tab sender. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| content tab sender refusal | It accepts content reads only from its extension and never from a tab sender. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| content command check | It accepts content reads only from its extension and never from a tab sender. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| content transport branch | It runs open-tab requests through the content script and retains the background comparison. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |
| preflight error propagation | It rejects a failed tab preflight instead of presenting an old report as a completed pass. | 1/0/0 | 0/1/0 | 0/1/0 | 1/0/0 |

## Limits

These are local checks, not live acceptance or independent review. Browser session cookies attaching to API requests, Opera GX loading, content-script availability on Sid's page, real clipboard access and worker lifetime await the owner action in `docs/OWNER-ACTIONS.md`. Scheduled/overdue routes are first-page shape probes, not completeness claims.
