You are a narrow second reviewer for the Jarvis project (repo ksid1229-ops/jarvis; owner "Sid"). PR #88 (branch `codex/r2-memory-filing-followups`, head `92889ea`, base `origin/main` `743c4e5`) implements follow-ups F1–F4 from Claude's entry "PR #82 max re-review at e4fb760: cleared with follow-ups" in `docs/AGENT_LOG.md` on main: a wrapping re-file cursor, existing-area hints in the extraction prompt, per-attempt D1 charging, NFKC + default-ignorable folding for names and aliases, and named tests. The main reviewer is re-running gates and the PR #82 round-2 adversarial tests. Treat claims as unproven. The diff is at `<scratchpad>/pr88/source.diff`; the prior report is `<scratchpad>/pr82r2-narrow.md`.

CHECK ONLY THESE
1. Existing-area hints: the tree names sent to DeepSeek are bounded in bytes, only Sid's own active topics, safely framed as untrusted data (an area name containing instructions cannot steer extraction or authority), still exactly one provider call, reserved worst-case tokens/cost still honest, and the model actually gets enough to reuse areas (top two levels).
2. Folding: NFKC then strip Default_Ignorable then lowercase, applied consistently to creation, lookup, aliases and re-file; existing stored rows (NFC-lowercase normalized_name with the unique index) still resolve; no two siblings can now collide in a way that trips the unique index or `readActiveChild` corrupt() (e.g. an existing "Music ❤" and "Music ❤️" created before this PR); no name becomes empty after stripping.
3. Wrapping re-file cursor: bounded, wraps correctly, persists safely without a migration (where is the cursor stored?), idempotent, cannot skip movable rows forever.
4. D1 charging: counting-proxy worst cases (every first attempt failing; failing re-file inserts) are within the charged/reserved figures.
5. Guards whose deletion no named test catches (mutation).

HOW
- Do NOT use `C:\Users\Sid\jarvis-pr39` or `C:\Users\Sid\jarvis-pr40`. Reuse the short-path worktree `C:\Users\Sid\jarvis-pr82-adv`: `git -C C:\Users\Sid\jarvis-pr82-adv checkout --detach 92889ea` (keep its untracked tests), `pnpm.cmd install --frozen-lockfile`, add tests in `apps/cloud-gateway/test/memory/adversarial-pr88.test.ts`, run from that worktree root: `npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/memory/adversarial-pr88.test.ts`. Tests assert CORRECT behaviour (a failing test = a proven defect). Do not push, merge, deploy or call real DeepSeek. Leave the worktree in place.

OUTPUT: write `<scratchpad>/pr88-narrow.md` and return it. One-line verdict and counts; findings High → Low with **Where** (file:line at 92889ea), **Proven**, **Effect for Sid**, **Fix**; then short "checked and sound" and "unverified" lists. No padding.

<scratchpad> is C:\Users\Sid\AppData\Local\Temp\claude\C--javis--claude-worktrees-jarvis-code-review-0b1695\f3f2b419-52e6-4c42-b275-f2c7a15d27ac\scratchpad
