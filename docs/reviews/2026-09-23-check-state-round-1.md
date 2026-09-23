# check-state hardening: round 1 builder evidence, 2026-09-23

Signed: Codex (GPT-6), builder of PR #155. This records observed builder checks, not an independent review. The [initial submission report](2026-09-23-check-state-hardening.md) is historical; the rules and counts below supersede it.

Reviewed head: `c7d603193de03ba94caa0918e0fd509eb2a969bc`. Fresh main: `a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`. After the full mutation sweep, main was merged normally in `565c2924c147d93771ce8f41e354adf47f7e2dc3`, whose second parent is that exact main revision. No rebase or force push was used. Main contributed only the #153 QUEUE edit.

## Findings and before/after fixtures

All reported checker defects reproduced against the unchanged reviewed script. No review finding was false. The new regression suite before the fixes had **102 tests: 68 passed, 34 failed, 0 skipped**. Supporting cases that already worked remain positive controls. In particular, the nested reference-label case already passed; the reported nested inline-label case failed.

| Review item / crafted input | Reviewed checker | Fixed checker |
|---|---|---|
| `origin/main (a666097)` | Passes incorrectly | Fails for literal sha |
| `origin/main → a666097` | Passes incorrectly | Fails for literal sha |
| `origin/main is now a666097` | Passes incorrectly | Fails for literal sha |
| `origin/main was a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d` | Passes incorrectly | Fails for literal sha |
| `a666097 (origin/main)` | Passes incorrectly | Fails for literal sha |
| `origin/main, at a666097` | Passes incorrectly | Fails for literal sha |
| A broken link in a four-space nested bullet, and a four-space bullet naming a literal revision | Both hidden as code | Both fail |
| An unmatched backtick in one paragraph followed by code spans and a broken link in another | Broken link hidden | Broken link fails |
| A register row after a blank gap, including an indented row after intervening prose | Row silently omitted | Fails at the row's line |
| Today's carriers with the clock injected as 2026-10-25 | 41 annotations | 4 annotations, 41 plain detail lines |
| Still true cells `unverified`, `not verified`, `?`, `false`, `superseded`, `partly` | No warning | Each warns without failing |
| Sources `—`, `–`, `TBD`, `N/A`, `?`, `none` | Accepted | Each fails |
| Empty Fact cell | Accepted | Fails |
| Observed or Last regenerated at 2026-09-25 with today fixed to 2026-09-23 | Accepted | Each fails; 2026-09-24 remains allowed |
| `Evidence[^1]` with `[^1]: Sid said so` | Treats `Sid` as a path | Passes; real links in footnote bodies still checked |
| `[see [1]](Missing.md)` | Misses the broken link | Fails |
| Six anchor/query transformations | Every requested mutant survives the original 57-test suite | Every mutant fails its new named fixture twice, then passes after restoration |

Each fixture copies the CLI to a temporary checkout and injects the clock, without fetching destinations. The original 15 weakness categories and their fixtures remain covered.

## Decisions

- Restore main's whole-visible-line `origin/main` plus 7–40-character hex-word rule. Exempt only individual tokens marked by `run`, `run id`, `runs/`, `#`, or contained in a URL. Positive run-ID examples and mixed run-ID-plus-real-sha failures prevent a whole-line exemption from hiding a revision. This replaces the initial PR's narrower assignment/adjacency rule, which demonstrably missed six ordinary phrasings.
- Preserve list text and paragraph continuations. Indented code starts only at a blank boundary outside a list; it can then continue. Inline code spans can span lines within one paragraph, but cannot swallow a subsequent paragraph.
- Keep the register bounded by its section. A pipe-led row after its table has ended is a structural failure, rather than silently dropping evidence. A separate table in a later section remains valid.
- Keep stale or unconfirmed information advisory. One annotation per affected file reports its count and first affected line; prefixed plain lines retain every detail. Row text is kept out of workflow commands and CR/LF cannot inject a new detail line. This avoids spending the annotation allowance on the first few FACTS rows.
- A formatted, case-insensitive `yes` prefix is the sole affirmative status. A missing claim, a placeholder source, an invalid date or a date more than one UTC day ahead fails. None of these checks evaluates whether the factual statement is substantively true; they enforce the carrier's evidence contract, consistent with CODE-VS-JUDGMENT.
- Skip footnote labels as reference definitions while scanning their prose for real links. Balanced labels cover nested brackets without swallowing a later paragraph. The scanner remains dependency-free; full Markdown-renderer equivalence is not claimed.

The merged real carriers pass with **0 warnings and 0 failures**. **No carrier row violates a new rule, so no row was repaired and no newly detected lie is being claimed.** FACTS prose was updated to describe the new rules. The October 25 probe yields one annotation each for STATE, QUEUE and OWNER-ACTIONS, plus one for FACTS containing 38 items; all 41 detail lines remain visible in the raw log.

## Mutation evidence

The exact replacements and named tests live in [check-state.mutations.json](../../scripts/test/check-state.mutations.json). Run `node scripts/mutate-check-state.mjs`. The runner requires a unique literal match, changed source bytes, valid syntax, an exact named test failure twice, byte-identical restoration, and a passing restored test. A zero-match edit is NOT APPLIED.

**Final sweep: 107 KILLED, 0 SURVIVED, 0 NOT APPLIED, 0 INVALID.** Every mutation had baseline **1 passed / 0 failed / 0 skipped**, mutant **0 / 1 / 0**, confirmation **0 / 1 / 0**, and restoration **1 / 0 / 0**.

| Requested mutation | Named fixture | Original 57-test suite | With new fixture and in final sweep |
|---|---|---|---|
| `anchor-space`: collapse consecutive spaces | preserves both spaces around removed punctuation in an anchor | SURVIVED | KILLED |
| `anchor-html`: remove HTML-tag stripping | strips HTML tags from a heading anchor | SURVIVED | KILLED |
| `anchor-link-text`: remove link-text stripping | uses the visible link text in a heading anchor | SURVIVED | KILLED |
| `anchor-connector`: remove `\p{Pc}` | preserves underscores in a heading anchor | SURVIVED | KILLED |
| `anchor-decode`: remove fragment decoding | decodes a percent-encoded Unicode anchor | SURVIVED | KILLED |
| `link-query`: remove query stripping | strips the query before resolving a local link | SURVIVED | KILLED |

All six original mutations actually applied and each left **57 passed / 0 failed / 0 skipped**. The initial and restored original suites also passed 57/0/0. With the new fixtures and before implementation changes, their separate sweep was **6 killed / 0 survived / 0 not applied / 0 invalid**. `Voice — tools` to `#voice--tools`, `snake_case`, and `#caf%C3%A9` are literal test cases.

The first full new sweep was **105 killed / 2 survived / 0 not applied / 0 invalid**. `escaped-link` survived because the new bracket helper duplicated the caller's opening-escape check; the helper now accepts an opening bracket already validated by its caller. `bounded-warning-annotations` survived because the assertion counted only commands with properties and missed `::warning::extra`; it now counts both command forms. Both are killed in the final sweep. Fifteen obsolete literal replacements from the initial implementation were updated before running; none was called an applied mutation without a match.

Runner controls were also rerun: **3 passed / 0 failed / 0 skipped**. The nonexistent literal was NOT APPLIED, a comment-only edit SURVIVED, and invalid JavaScript was INVALID, with expected combined exit 2 and byte-identical restoration. Those controls are separate from the 107 checker guards.

## Observed gates

Windows, Node 24.19.0, pnpm 11.19.0. Offline installation completed with `pnpm install --offline --frozen-lockfile --ignore-scripts`; no dependency or lockfile changed.

| Gate | Passed | Failed | Skipped | Detail |
|---|---:|---:|---:|---|
| Focused checker suite | 109 | 0 | 0 | `node --test scripts/test/check-state.test.mjs` |
| Full scripts suite after installation | 136 | 0 | 0 | `node --test scripts/test/*.test.mjs` |
| Root workspace suite | 5461 | 0 | 0 | `pnpm test`; 209 passing files, exit 0, 203.15 s |
| Mutation-runner controls | 3 | 0 | 0 | Expected NOT APPLIED, SURVIVED and INVALID controls |
| Node syntax checks | 3 | 0 | 0 | Checker, its test suite and mutation runner |
| Merged carrier check | 1 | 0 | 0 | `node scripts/check-state.mjs`; 0 warnings |
| October 25 warning probe | 1 | 0 | 0 | Exit 0; 4 annotations, 41 detail lines |
| Staged whitespace check | 1 | 0 | 0 | `git diff --cached --check` |
| Other agent-log entries preserved | 1 | 0 | 0 | Every committed byte after this builder's entry is identical |
| Normal merge ancestry | 1 | 0 | 0 | Two parents; exact requested main is the second parent and an ancestor |

The checker, fixture suite and mutation specification are unchanged across the merge and final evidence edits: three committed-blob comparisons passed. A final carrier rerun also passed with 0 warnings.

The workspace needed no failed-file rerun. Existing Wrangler test-environment binding warnings were logged; they were not test failures.

The first full scripts attempt started alongside installation and failed to import `@iarna/toml`: **129 passed / 1 failed / 0 skipped**, with one test file unable to load its seven cases. After installation, that unchanged file passed alone: **7 / 0 / 0**. The subsequent full suite passed **136 / 0 / 0**. This was a builder command-ordering error, not a claimed known flaky test.

Other observed development totals: first fixed suite **102/0/0**; an additional three-test boundary probe **1/2/0**, exposing bracket pairing across paragraphs and an incorrect indentation boundary after a code fence; corrected suite **105/0/0**; final focused suite **109/0/0**. The two boundary defects were fixed and have their own mutations.

CI wiring remains the initial PR's explicit checker-test step beside the Windows deployment tests and before the Linux state check. No workflow changes were needed in this round. Linux execution, hosted CI completion, GitHub's rendered annotation UI, external URL availability, and the subsequent automated/independent review are not claimed as local evidence. Untouched local-agent, watchdog and Hermes suites were not rerun. No parallel-builder file, migration, real database, production state or secret was touched; no owner-only action arose.

Raw logs remain beside `C:\Users\Sid\codex-ledgers\check-state-harden.md`, outside every repository: `check-state-r1-fixture-baseline.tap`, `check-state-r1-anchor-baseline.log`, `check-state-r1-anchor-fixtures.log`, `check-state-r1-mutations.log`, `check-state-r1-mutations-final.log`, `check-state-r1-focused-final.tap`, `check-state-r1-scripts-full.tap`, `check-state-r1-dependency-rerun.tap`, `check-state-r1-scripts-final.tap`, `check-state-r1-workspace.log`, `check-state-r1-runner-controls.log`, `check-state-r1-carriers.log`, and both `check-state-r1-warning-*.log` files.

Next: the assigned automated and independent reviewers assess PR #155 when its new head is pushed. No merge into main or deployment is authorized here.
