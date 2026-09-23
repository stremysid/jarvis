# check-state hardening: builder evidence, 2026-09-23

Builder: Codex (GPT-6), branch `codex/check-state-harden`. This is builder evidence for the subsequent independent reviews, not an independent sign-off.

## Premises and baseline

Freshly fetched `origin/main`: `f9472d18a3634f186b36675c8da5995292da9e1d`.
The GitHub PR metadata confirms #152 merged at 2026-09-23T21:10:50Z with that merge commit.
#153 was open at `acbd35fe8c748b5297f3a2a4639173bc21f46b78`; its diff contains the checker follow-up row, although its title and body describe the separate PowerShell issue.

**No reported weakness was false.** All 20 cases below were run against the unchanged main script before implementation; `git diff --exit-code -- scripts/check-state.mjs` confirmed it was untouched. The initial authoritative suite had **37 tests: 5 passed, 32 failed, 0 skipped**. The first 20 were the reported defects; other failures were related boundaries. Fixtures copy the real CLI into a temporary checkout and freeze its clock at 2026-09-23T12:00:00Z. No service is queried by the fixtures.

FACTS lines 23–24 really did promise unset-row warnings. The empty-cell fixture proves the old implementation did not deliver them. That prose now names the actual rules and advisory behavior.

| Crafted input | Main exit / behavior | Hardened exit / behavior |
|---|---|---|
| Three-cell FACTS row | 0; skipped | 1 |
| Indented FACTS row with empty source | 0; skipped | 1 |
| Impossible observation 2026-13-45 | 0 | 1 |
| TODO source | 0 | 1 |
| Dash source | 0 | 1 |
| Old fact warning annotation | 0; plain text only | 0; ::warning |
| Empty Still true cell | 0; silent | 0; ::warning |
| No Still true cell | 0; silent | 0; ::warning |
| Old Last regenerated stamp | 0; silent | 0; ::warning |
| Backticked pipe in a fact cell | 1; shifted columns | 0 |
| Table in a section after the register | 1; checked as facts | 0 |
| CI run 35532044202 beside origin/main | 1; treated as sha | 0 |
| Link syntax inside inline code | 1; treated as link | 0 |
| 150 lines with a terminal newline | 1; reported 151 | 0 |
| Missing link in FACTS | 0; unchecked | 1 |
| Missing same-file anchor | 0; unchecked | 1 |
| Missing cross-file anchor | 0; unchecked | 1 |
| Missing reference-style destination | 0; unchecked | 1 |
| Missing angle-wrapped spaced destination | 0; unchecked | 1 |
| Wrong-case local path on Windows | 0; case folded | 1 |

## Design choices and limits

- The register is a bounded four-column table under `The register`, ending at its table boundary or the next peer/parent heading. Code spans and escaped pipes do not move its columns. Missing cells, placeholder sources, invalid dates and broken repository links fail.
- Calendar dates must round-trip exactly through ISO formatting. This catches both invalid months and normalized dates such as February 30. The existing 30-day threshold remains advisory and uses UTC calendar days, so the date exactly 30 days ago does not become stale at noon.
- Empty, dash, no, unknown and unconfirmed status cells warn, as do old observation and regeneration dates. Each annotation identifies its original file and line. Percent/newline escaping prevents text from altering the workflow command.
- Revision checking binds a literal to `origin/main` by adjacency or assignment, including reverse assignment and numeric shas. The previous whole-line hex search rejected unrelated CI run IDs.
- The local Markdown scanner has no new dependency, so this CI job still needs only Node and checkout. It covers inline/reference links, angle-wrapped spaces, escaped/balanced parentheses, encoded paths, ATX/setext headings, duplicate heading suffixes and explicit HTML anchors. It skips examples in code. Directory entries enforce exact case on Windows.
- A full Markdown renderer was not introduced just for these carriers. This is a tested scanner for their syntax, not a claim of full CommonMark/GitHub renderer equivalence: complex nested markup, HTML hyperlinks and every entity/heading rendering edge are not established here. External URL availability and non-Markdown fragments (for example source-file `#L1`) are deliberately not fetched or interpreted.
- Read `AGENTS.md`, `ARCHITECTURE.md`, `BUILDING.md` and `CODE-VS-JUDGMENT.md` before implementation. These checks enforce repository evidence contracts; they add no Jarvis product decisions.

Today's carriers pass the new rules with **0 warnings**. **No fact row needed repair under a new rule.** The FACTS change corrects the checker description; it is not a fresh verification of the truth of every factual assertion.

## Final observed gates

Windows, Node 24.19.0, pnpm 11.19.0. Dependencies installed successfully from the offline cache with `pnpm install --offline --frozen-lockfile --ignore-scripts`; no dependency or lockfile changed.

| Command / check | Passed | Failed | Skipped | Detail |
|---|---:|---:|---:|---|
| `node --test scripts/test/check-state.test.mjs` | 57 | 0 | 0 | Real CLI fixtures |
| `node --test scripts/test/*.test.mjs` | 84 | 0 | 0 | Entire scripts suite, including deployment tests |
| `pnpm test` | 5461 | 0 | 0 | 209 files passed; exit 0, 192.72 s |
| Mutation-runner self-checks | 3 | 0 | 0 | Absent literal, harmless change, invalid syntax |
| `node --check` on checker, its suite and mutation runner | 3 | 0 | 0 | Three exit-0 syntax checks |
| `node scripts/check-state.mjs` | 1 | 0 | 0 | Four documents checked, 0 warnings |
| `git diff --check` | 1 | 0 | 0 | No whitespace errors |
| Agent-log preservation comparison | 1 | 0 | 0 | Every prior committed byte preserved; 38 lines prepended after the preamble |

No unrelated flaky test failed, so no file-only flake rerun was needed. The workspace emitted existing Wrangler test-environment binding warnings; these were not test failures. Untouched local-agent, watchdog and Hermes package suites were not rerun.

CI previously ran only `scripts/test/deploy.test.mjs` from this directory. The new suite is explicitly wired next to it in the Windows job and before the checker in the existing Linux state-carriers job. Both commands were run locally through the gates above. Linux execution and GitHub's annotation display were not observed locally. A separate local YAML-parser check could not start: PyYAML was absent both from the offline dependency cache and the available interpreter. The workflow diff was inspected; CI parsing is not claimed as a local result.

For completeness, observed development fixture totals (pass/fail/skip) were **6/31/0** in the first draft, **5/32/0** after changing the literal fact name `Fact` so it could not be mistaken for the old header, **35/2/0** in the first implementation (the two assertions mistook the summary's “0 warning(s)” for a warning), then **52/0/0**, **55/0/0**, and the final **57/0/0**. Only the corrected baseline is used to adjudicate the reported weaknesses.

## Mutation evidence

Run `node scripts/mutate-check-state.mjs`. The exact literal replacements and named tests are committed in [check-state.mutations.json](../../scripts/test/check-state.mutations.json). The runner refuses zero/multiple matches, verifies changed bytes and valid syntax, requires the exact test to fail twice, restores in `finally`, checks byte equality and reruns that test.

**Final: 57 KILLED, 0 SURVIVED, 0 NOT APPLIED, 0 INVALID.** For every row below: baseline **1 passed / 0 failed / 0 skipped**; mutant **0 / 1 / 0**; confirmation **0 / 1 / 0**; restored **1 / 0 / 0**. Source restoration was byte-identical.

The first sweep was **54 killed / 3 survived**. The fixtures did not isolate a tilde fence opener, a non-angle link title, or a normalized reference label whose destination is broken. Those fixtures were strengthened; the final sweep above then killed all three. These were observed survivals, not zero-match edits.

The runner controls separately produced exactly the expected verdicts: a nonexistent literal was **NOT APPLIED**, a comment-only mutation **SURVIVED**, and invalid JavaScript was **INVALID**, with combined exit 2. None was counted as a killed checker guard.

| Mutation | Named test killed twice and passing after restoration |
|---|---|
| utc-calendar-age | does not warn until a date is more than thirty calendar days old |
| terminal-newline | counts a terminal newline as the end of line one hundred fifty |
| fence-opener | ignores code fences and indented code when checking links |
| fence-closer | checks real links following a closed fence |
| indented-code | ignores code fences and indented code when checking links |
| inline-code | ignores link syntax inside inline code |
| pipe-in-code | accepts a backticked pipe inside a fact cell |
| escaped-pipe | accepts escaped pipes and multiple-backtick code spans |
| leading-pipe | accepts the unchanged valid fixture without warnings |
| trailing-pipe | accepts the unchanged valid fixture without warnings |
| register-presence | rejects a missing register table or a changed register header |
| register-end | stops the register at the next section even without a blank line |
| header-section-boundary | does not borrow a register table from a later section |
| register-header | rejects a missing register table or a changed register header |
| separator-validation | rejects a missing table separator |
| table-end | leaves a table after the register to its own section |
| short-row | rejects a three-cell fact row instead of silently dropping it |
| extra-cell | rejects a fifth fact cell instead of discarding its evidence |
| real-calendar-date | rejects an observation date that overflows February |
| finite-calendar-date | rejects an impossible observation date |
| observation-date | rejects a non-ISO observation date |
| source-required | checks an indented fact row for a missing source |
| todo-source | rejects TODO as a fact source |
| dash-source | rejects a dash as a fact source |
| unset-status | lists an unset Still true cell as a warning |
| no-status | lists a no Still true cell as a warning |
| unknown-status | warns for unknown and unconfirmed facts |
| old-fact-warning | annotates an old fact as a warning without failing the check |
| annotation | annotates an old fact as a warning without failing the check |
| annotation-escaping | escapes percent sequences in warning annotations |
| angle-destination | accepts real anchors and spaced paths with optional link titles |
| destination-escapes | accepts escaped parentheses in destinations |
| open-parenthesis | checks percent-encoded paths and balanced parentheses |
| close-parenthesis | checks percent-encoded paths and balanced parentheses |
| destination-whitespace | accepts real anchors and spaced paths with optional link titles |
| first-reference | uses the first reference definition and normalizes its label |
| reference-label-normalization | resolves normalized reference labels before checking their destinations |
| escaped-link | ignores escaped links and external URLs |
| reference-destination | checks a reference-style link destination |
| undefined-reference | ignores escaped links and external URLs |
| exact-path-case | rejects a wrong-case path even on Windows |
| duplicate-heading | accepts duplicate headings setext headings and explicit HTML anchors |
| explicit-anchor | accepts duplicate headings setext headings and explicit HTML anchors |
| anchor-code-exclusion | does not create an HTML anchor from inline code |
| external-link | ignores escaped links and external URLs |
| link-target-exists | checks links in the facts register |
| link-anchor-exists | rejects an absent same-file anchor |
| malformed-link | reports malformed URL escapes as link failures |
| facts-links | checks links in the facts register |
| carrier-required | retains missing-carrier and missing-BLOCKS failures |
| regeneration-date | rejects a malformed regeneration date |
| regeneration-age | warns when a carrier was last regenerated more than thirty days ago |
| state-budget | rejects a genuinely over-budget state file |
| forward-revision | rejects an explicit current revision including an all-digit sha |
| reverse-revision | rejects an explicit current revision including an all-digit sha |
| blocks-column | retains missing-carrier and missing-BLOCKS failures |
| failure-exit | rejects a three-cell fact row instead of silently dropping it |

## Ownership and remaining verification

No parallel-builder file, migration, production state or secret changed. No owner-only action arose, so no OWNER-ACTIONS row is needed. Automated review and the independent adversarial review follow the PR; neither is claimed here.

Raw local observations and the retained continuity ledger live outside the repository in `C:\Users\Sid\codex-ledgers\`: `check-state-harden.md`, `check-state-baseline.tap`, `check-state-focused-final.tap`, `check-state-scripts-full.tap`, `check-state-workspace.log`, `check-state-mutations-final.log`, and `check-state-runner-self-check.log`.
