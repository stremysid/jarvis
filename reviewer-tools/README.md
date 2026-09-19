# Reviewer tools (not for merge)

This is the Claude Opus 5 reviewer's toolbox, kept on `claude/reviewer-tools` so a new reviewer session can reuse it. **Read `REVIEWER-MANUAL.md` first** for how the role works, then the newest `HANDOFF-*.md` for the current state.

## Scripts (Node; run from Git Bash or PowerShell)
- **`mutrun.mjs`** runs mutations. Usage: `node mutrun.mjs spec.json [idPrefix]`.
  - Spec: `{root, branch, mutations:[{id, file, from, to, also?:{from,to}, runner?:"vitest"|"pytest", tests:[...]}]}`.
  - It refuses to start if `root` is dirty, then checks out `branch` detached (a SHA works if it's fetched).
  - Each `from` must match exactly once. It may span several lines; CRLF is normalized.
  - vitest runs `npx.cmd vitest --config vitest.workspace.ts run <tests>`; pytest runs `uv run pytest -q` in `apps/local-agent`.
  - It restores the file with git after each run and ends by checking out `origin/main`.
  - A SURVIVED/KILLED line reflects the exit code only, so classify with `killcheck.mjs`. If the whole run is interrupted, `git -C <root> checkout -- <file>`.
- **`gen-trig.mjs`** generates a spec that removes each SQL trigger. Usage: `node gen-trig.mjs <local sql copy> <out.json> <branch-or-sha> <root> <repo-relative sql path> <test1,test2,...>`.
  - Get the local copy with `git show origin/<branch>:<sql path> > x.sql`.
  - It adds a no-op `BASE` mutation, which must pass, then one `T-<trigger>` removal (`to: ""`) per trigger.
  - Split large specs into chunks of about 15–20 by hand; about 60 minutes is the tool limit.
- **`gen39b.mjs`** is the older 0016-specific version of `gen-trig.mjs`.
- **`killcheck.mjs`** classifies trigger-removal runs. Usage: `node killcheck.mjs run1.txt [run2.txt ...]`. Buckets:
  - named kill: a failing test names the trigger or its table;
  - other kill: hand-check it for relevance and `timed out`;
  - survived;
  - invalid: no test failed, or nothing ran.
- **`agentlog-insert.mjs`** prepends an entry below the rules in `docs/AGENT_LOG.md` and keeps CRLF. Usage: `node agentlog-insert.mjs docs/AGENT_LOG.md entry.md`.
- **`agentlog-union.mjs`** resolves an AGENT_LOG merge conflict by keeping both sides' entries, newest first. Usage: `node agentlog-union.mjs <ours> <theirs> <output> <crlf|lf>`.

## Probes
Each probe asserts the bug **exists**, so it passes on the buggy head and must FAIL once fixed. Copy one into a test copy only, never a PR branch.
- `pr35-probe.test.ts` and `pr35-probe2.test.ts`: #35 quote classifier and evaluator. They import `../../src/memory/...`, so they go two levels under `apps/cloud-gateway/test/`, e.g. `apps/cloud-gateway/test/memory/`.
- `pr39-h2-probe.test.ts`: `INSERT OR REPLACE` rewinds `memory_cursors`. Fixed at eb70b70; it must keep failing.
- `pr39-nf1-probe.test.ts`: an explicit-rowid `INSERT OR REPLACE` deletes a guarded `memory_model_prices` row. It must FAIL on the #39 round-3 fix. The #39 probes import `./migration.js`, so place them in `apps/cloud-gateway/test/persistence/`.

## Specs, reports, notes
- **Mutation specs:** `mut35*.json`, `mut37*.json`, `mut38.json`, `mut39*.json`, and `mut40b-triggers*.json` (the 6b63d08 SQL; regenerate on the #40 fix head).
- **Reports:** `pr39-adversarial.md`, `pr39-reverify.md`, `pr39-reverify2.md`, `pr40-adversarial.md`, `adv40.md` (the #40 blockers text), and `review-notes-2026-09-14.md` (#29–#32, #35/#36).
- **`notes-2026-09-15/`:**
  - `reviewer-log-2026-09-14.md`: the full chronological log of the Sep 14–15 reviewer sessions;
  - the #39 round texts (`adv39.md`, `rev39.md`, `rev39c.md`);
  - `remote39.md`: the scratch remote-D1 proof requirements;
  - the `vals*.json` files;
  - every test and mutation run output.
- **Page sources:** `jarvis-status-board.html` is Sid's status page (https://claude.ai/artifact/XjrTCjXg4o6rBEzi7t89f5, also https://claude.ai/code/artifact/f8eddfb6-11ab-4e9e-99d7-906d993eb888). `jarvis-memory-plan.html` is the Memory Plan (https://claude.ai/artifact/CiyukSCFtUpHe9J4Uc3PZo). Republish either with the Artifact tool, passing its `url`.
