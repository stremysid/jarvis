# check-state hardening: round 2 builder evidence

Signed: Codex (GPT-6), builder of PR #155, 2026-09-23. Reviewed head: `d22a87bd43ae8b425fe9d8aad918bef66b61d980`. This supersedes the revision-exemption rule in the [round 1 report](2026-09-23-check-state-round-1.md); it is builder evidence, not an independent review.

## Reproduction and change

All four reported bypasses and the uppercase false positive reproduced against the unchanged reviewed checker. No reported finding was false. The expanded suite before the fix had **125 tests: 111 passed, 14 failed, 0 skipped**. `git diff --exit-code -- scripts/check-state.mjs` confirmed the checker was unchanged for that run. Fixtures execute the copied CLI in a temporary checkout with its clock injected; they do not fetch URLs.

| Input beside origin/main | Reviewed checker | Fixed checker |
|---|---|---|
| Commit URL containing a 40-character lowercase revision | Incorrectly passes | Fails |
| Markdown tree link containing `a666097` | Incorrectly passes | Fails |
| `#a666097` | Incorrectly passes | Fails |
| `run a666097` | Incorrectly passes | Fails |
| `https://example.invalid/a666097` | Incorrectly passes | Fails |
| Actions run URL containing `a666097` | Incorrectly passes | Fails |
| Commit, tree or blob URL containing all-decimal `35532044202` | Incorrectly passes | Each fails |
| Generic `/runs/35532044202` URL | Incorrectly passes | Fails |
| `/actions/runs/35532044202` occurring only in a query or fragment | Incorrectly passes | Each fails |
| `/actions/runs/earlier/35532044202` | Incorrectly passes | Fails |
| `origin/main: DEFACED nothing` | Incorrectly fails | Passes |
| `https://github.com/stremysid/jarvis/actions/runs/35532044202` | Passes | Passes |
| Marked decimal IDs before and after that URL on the same line | Passes | Passes |

The main script's SHA expression was checked directly with `git show origin/main:scripts/check-state.mjs`: it has no case-insensitive flag. The fixed checker likewise scans only lowercase hexadecimal words. An exemption requires every character in the matched word to be a decimal digit. Outside a URL it also requires the run marker; inside a URL it instead requires the immediately preceding path segments to be `/actions/runs/`. A run marker inside a generic URL cannot bypass that path check. Query strings and fragments cannot pose as the path.

This replaces the broad URL exemption, which hid actual commit/tree/blob references, and the untyped marker exemption, which accepted hex revisions as IDs. The whole-visible-line rule and all other carrier rules remain in place. Only repository proof tooling changed; no Jarvis product decision, dependency, CI wiring, migration, parallel-builder file or production state changed.

The first and final focused suites each passed **125 / 0 / 0**. After the final sweep, main was fetched again and `git merge --no-ff --no-commit origin/main` reported **Already up to date**. Current main is still `a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`, already an ancestor through the round 1 normal merge `565c2924c147d93771ce8f41e354adf47f7e2dc3`. No rebase, force push or artificial merge commit was used.

`node scripts/check-state.mjs` on that merged branch passed with **0 warnings and 0 failures**. No carrier row required correction, and no newly discovered factual lie is claimed. All three Node syntax checks passed.

## Reproducible evidence

Run `node --test scripts/test/check-state.test.mjs`, then `node scripts/mutate-check-state.mjs`. The [mutation specification](../../scripts/test/check-state.mutations.json) retains prior guards, adapts six literal replacements to the changed source, and adds eleven mutations. Every replacement must match once and change bytes; the runner verifies valid syntax, the exact named failure twice, byte-identical restoration, and the restored named test passing. Zero matches are NOT APPLIED.

The eleven added mutations cover decimal marked IDs, decimal URL IDs, lowercase SHA matching, each URL token boundary, URL/marker isolation, the actions path, query exclusion, fragment exclusion, the immediate run segment, and numeric commit URLs. No adapted literal is claimed applied merely because it was listed.

The first full sweep produced **117 killed / 1 survived / 0 not applied / 0 invalid**. The surviving `run-marker-boundary` mutation was applied: removing the marker's end anchor left the fixture green because its later revision contained a hex letter and was rejected by the new decimal guard first. The fixture now also puts an unmarked all-decimal revision after each valid marked ID. The targeted rerun was **1 killed / 0 survived / 0 not applied / 0 invalid**, with the exact named test failing twice and passing after byte-identical restoration. This was a test-coverage correction; the checker source did not change after its first focused pass.

**Final full sweep: 118 killed / 0 survived / 0 not applied / 0 invalid**, exit 0. Every named baseline and restoration was **1 passed / 0 failed / 0 skipped**; every mutant and repeated confirmation was **0 / 1 / 0**. The runner verified byte-identical source restoration. The raw final log is `check-state-r2-mutations-final.log`; the targeted log is `check-state-r2-boundary-mutation.log`.

## Final gates

Windows, Node 24.19.0, pnpm 11.19.0. Offline installation completed before the full suites with `pnpm install --offline --frozen-lockfile --ignore-scripts`; no dependency or lockfile changed.

| Gate | Passed | Failed | Skipped | Detail |
|---|---:|---:|---:|---|
| Focused checker suite | 125 | 0 | 0 | Both initial and strengthened-fixture runs |
| Full scripts suite | 152 | 0 | 0 | `node --test scripts/test/*.test.mjs`, exit 0 |
| Root workspace suite | 5461 | 0 | 0 | `pnpm test`, 209 passing files, exit 0, 334.53 s |
| Merged carrier check | 1 | 0 | 0 | `node scripts/check-state.mjs`, 0 warnings |
| Node syntax checks | 3 | 0 | 0 | Checker, fixture suite and mutation runner |
| Staged whitespace check | 1 | 0 | 0 | `git diff --cached --check` |
| Other agent-log entries preserved | 1 | 0 | 0 | Every prior committed byte after this builder's entry preserved |
| Current main ancestry | 1 | 0 | 0 | Exact freshly fetched main is an ancestor |
| Tested files unchanged | 3 | 0 | 0 | Checker, fixtures and spec match fix commit after final docs edits |

No full-suite test failed and no flaky-file rerun was needed in round 2. Existing Wrangler test-environment binding warnings were not test failures. No mutation-runner control rerun is claimed in this round; its implementation is unchanged, and its prior control evidence remains in the historical reports.

Raw observations are retained beside `C:\Users\Sid\codex-ledgers\check-state-harden.md`: `check-state-r2-baseline.tap`, `check-state-r2-focused.tap`, `check-state-r2-focused-final.tap`, `check-state-r2-mutations.log`, `check-state-r2-mutations-final.log`, `check-state-r2-boundary-mutation.log`, `check-state-r2-install.log`, `check-state-r2-scripts-full.tap`, `check-state-r2-workspace.log`, and `check-state-r2-carriers.log`.

Hosted CI completion, Linux execution, and the independent review of this new head are not claimed locally. Untouched local-agent, watchdog and Hermes suites were not rerun. No owner-only action arose. The updated head is for the assigned reviewer to assess after publication; this builder has no authority to merge PR #155 into main or deploy it.
