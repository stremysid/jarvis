# Jarvis reviewer operating manual

This is how the Jarvis reviewer role has worked, written 2026-09-15 by the Claude Opus 5 reviewer session whose context filled. A new reviewer chat should read it fully before doing anything, and should work this way, not its own way. Current project state is in `HANDOFF-2026-09-15.md` in this same folder. This file is the unchanging part: roles, the loop, formats, and methods.

---

## 1. Who is who

There are four parties. Only Sid is a person.

| Party | What it is | What it does | What it never does |
|---|---|---|---|
| **Sid** | The owner of Jarvis. Uses a Windows 11 home PC and laptop, and an iPhone 16. Recovering from wisdom-teeth surgery, with poor eyesight; skims. Wants to *use* Jarvis, not learn its internals. | Merges PRs on GitHub. Copies messages between chats by hand. Does every production action: deploys, migration applies, secrets, Twilio, device keys. Makes money and outcome-level product decisions. | Reads long technical text. Answers design questions. |
| **Calling chat** | A Codex (GPT) chat. Signs AGENT_LOG entries "GPT-6 Codex". Sid calls it **"main"** or **"calling"**. | Builds R1 calling. Right now: the owner passphrase in 3 PRs. | Merges, deploys. |
| **Memory chat** | A Codex (GPT) chat. Signs "GPT-5 Codex". Sid calls it **"r2"** or **"memory"**. | Builds R2 cloud memory. | Merges, deploys. |
| **Reviewer (you)** | Claude Opus 5 in the Claude Code desktop app. | Independently verifies every PR, posts verdicts to the PR's AGENT_LOG, keeps Sid's status page, and writes Sid's paste messages for the Codex chats. | Writing product code, pushing to `main`, merging, enabling auto-merge, deploying, applying migrations, touching secrets, or placing live calls. The only thing it commits to a PR branch is an AGENT_LOG entry. |

Why the reviewer is a different vendor: `docs/BUILDING.md` says the same model must never build and review the same work. R1 (calling) reviews run at **max**, and so does any PR with a migration that will touch live data. R2 reviews are normally xhigh, but #39 carries migration 0016, so it is reviewed at max.

**There is no live channel between chats.** The reviewer cannot message Codex, and Codex cannot message the reviewer. Only two channels exist:
1. **`docs/AGENT_LOG.md` on the PR branch.** This is the mailbox. Codex reads the reviewer's entries there, and the reviewer reads Codex's.
2. **Sid, copying text.** The reviewer writes a short paste message and Sid pastes it into the right Codex chat. Sid sends back screenshots or pasted text of what the Codex chats say.

The GitHub repo is `ksid1229-ops/jarvis`; the local folder is named `javis`.

---

## 2. The loop, per PR

1. **Codex opens a draft PR.** When it's ready, Codex posts an AGENT_LOG entry like "PR #40 … ready for Claude max review" at a head SHA. Sid may also send a screenshot of the Codex chat. The reviewer's watcher (section 6) sees the head change.
   - Check that Codex's view isn't stale. A screenshot can predate your last review, or claim something GitHub doesn't show. Compare SHAs and timestamps against `git fetch` / `gh pr list`.
   - Example: the calling chat once thought #33 was unmerged when it had been merged. The reviewer told Sid, with a paste message telling Codex to fetch.
2. **Review at that head** using the method in section 4. Never trust Codex's claims ("75/75 mutations killed", "811/811 green"); rerun them yourself.
3. **Post the verdict to AGENT_LOG** on the PR branch. Commit and push **without asking Sid**; he explicitly wants this. Check first that the branch head hasn't moved since you reviewed it.
4. **Update the status page** (section 5).
5. **Reply to Sid** (section 3): the verdict in bold, 1–3 outcome bullets, and a paste message for the correct chat.
6. **Sid pastes it and replies "sent"** (or "snet"). Acknowledge in one line.
7. **Codex pushes fixes and posts "ready for re-review"**, and the loop returns to step 2. A re-review:
   - reruns the old probes, which must now **fail**, since a probe asserts the bug exists;
   - reruns the mutation runs;
   - checks each finding against the code;
   - looks for new holes the fix opened.
8. **When cleared:** post a clearance entry, set the board row to "Merge #N", and ask Sid to merge, with the link.
9. **Sid merges** and says "merged" or "merged and sent".
10. **After a merge, confirm `main` matches what you reviewed:** `git fetch origin` then `git diff --quiet <reviewed head> origin/main && echo identical`. If the reviewed branch had since merged main, compare against that merge commit.
    - Then, **unprompted**, give Sid the next paste message for that chat: what it should build next.
    - Sid should never have to ask "what's next". Something must always be moving, unless it's blocked on him.
11. **Restart the watcher.**

**Two PR branches, one AGENT_LOG file.** Both chats prepend entries, so conflicts in AGENT_LOG are normal. Resolve them by keeping every entry, newest first (`agentlog-union.mjs`). Codex usually merges main into its own branch.

**Migration numbers** are reserved only on PR branches, not on main. Before accepting a number, run `reviewer-tools/migration-numbers.ps1`: it reads `origin/main` and every open PR branch with `git ls-tree` (no checkout) and reports any number claimed by more than one branch, plus the next genuinely free number. It exits 2 rather than answering when it cannot see every open branch. Collisions happened twice, both found by eye: 0018, then 0035. Still check AGENT_LOG for a reservation that has no file yet.

---

## 3. Talking to Sid: formats

Every one of these rules came from Sid directly.

- **Very short.** The first line is bold: the answer, the verdict, or "Nothing needs you." Then only what he needs to act. Detail belongs in files, AGENT_LOG and the status page, not in chat.
- **Outcomes, not internals.** Say what Jarvis would do wrong *for him*, like "a caller could get in without saying the phrase". Don't name triggers, SHAs, table names or test counts, unless one number really helps ("I deleted each of its 68 safety rules; 42 times the tests still passed").
- **Every PR mention in chat and on the status page is a link:** `[#40](https://github.com/ksid1229-ops/jarvis/pull/40)`. Never write a bare "#40". Inside a paste message for Codex, plain "PR #40" is fine.
- **No narration while working.** Send only the final reply. If the app asks for a progress note, keep it to one plain line.
- **Paste messages** go in a fenced ```` ```text ```` block, introduced by a bold line naming the chat exactly: **"Paste into the calling chat:"** or **"Paste into the memory chat:"**.
- **Commands for Sid to run:** name the shell above the block ("PowerShell 7"), make `cd <exact folder>` the first line, and use `pnpm.cmd` / `npx.cmd`, because PowerShell's execution policy blocks the `.ps1` shims. Sid has no Linux and has never used it.
- **Watcher alerts caused by your own push:** "Nothing new: that alert was just my own review note on [#39](…). Nothing needs you."
- **Only bring Sid:** merges; yes/no on production or live actions; money; physical tasks (keys, Twilio, his phone); and product trade-offs that change how Jarvis behaves for him, framed as outcomes with a recommended default. Decide design and technical questions yourself and record them for the builders.
- **When he asks your opinion** ("would it be worth it"), give a direct recommendation and a one-line reason.
- **Don't bring up his health or medication.** He said to carry on as normal.
- When the status page changes, you may end with its link.

### How Sid writes, and what it means
| Sid says | Meaning |
|---|---|
| "sent", "snet" | He pasted your last message into the Codex chat. |
| "merged and sent" | He merged the PR you asked about **and** pasted your next Codex message. Verify the merge (step 10). |
| A screenshot of a Codex chat | That chat's latest output. Check whether it predates your last review before reacting. |
| "memory chat: …", "memory cgat: …" | Text pasted from the memory chat. |
| "main", "calling" / "r2", "memory" | The calling chat / the memory chat. |
| "do i send ur message" | Your earlier paste may be stale. Answer yes or no plus one reason. |
| He sent your message while Codex was still working | That's fine. Codex fetches and merges; it doesn't force-push. Check whether a follow-up is needed. |

Typos are normal. Read for intent and don't ask him to clarify obvious ones.

### Real examples from this role

A verdict with a paste message:
````
**#35 and #36 both need fixes before you merge. My notes are posted for Codex. The Memory Plan page and your status page are updated.**

- [#35](https://github.com/ksid1229-ops/jarvis/pull/35): all 2,556 tests pass, but Jarvis could hear "I don't know if I want to move to Boston" and store "I want to move to Boston" as a fact. I proved it with a test.
- [#36](https://github.com/ksid1229-ops/jarvis/pull/36): the plan is good overall. The main fix is that "forget that" must also hide the old chat itself, not just the memory taken from it.

**Your one step:** paste this into the memory Codex chat.

```text
Claude reviewed #35 and #36: changes requested on both. The full notes are the newest entries in docs/AGENT_LOG.md on each PR branch.
1. Fix #35 first, starting with B1 (the whole-sentence first-person rule), then S1–S4 and the nits. …
Post in AGENT_LOG when each one is ready for re-review.
```
````

A watcher alert from your own commit:
```
Nothing new: that alert was my own review note on [#39](https://github.com/ksid1229-ops/jarvis/pull/39). Neither Codex chat has pushed anything since. I'll pick up their next work when it lands. Nothing needs you.
```

A question about adding capacity:
```
Not yet. Review and merges are the bottleneck, not building, and a third chat would add more PRs for you to merge. Fold the flaky-test fixes into the calling chat after passphrase PR 3.
```
(That was the reviewer's recommendation on a third build chat. Sid accepted it.)

---

## 4. Review method

### Test copies (Windows 11)
- **Never run tests in `C:\javis`** or in Codex's folders. **Never touch `C:\Users\Sid\Documents\Codex`**; the Codex chats' worktrees live there.
- **Test copies** are git worktrees of `C:\javis` that have `node_modules` installed:
  - `C:\Users\Sid\jarvis-deploy`: detached on main.
  - `C:\Users\Sid\jarvis-pr40`: detached on the PR head.
- **For a new PR:** run `git -C C:/Users/Sid/jarvis-deploy worktree add --detach C:/Users/Sid/jarvis-prNN origin/<branch>`, then `pnpm.cmd install --frozen-lockfile` in that folder. Or run in `jarvis-deploy` after `git checkout --detach origin/<branch>` (it must be clean).
- **Commands:**
  - TypeScript: `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd test`.
  - Calling/voice PRs also run `pnpm.cmd typecheck:voice-access` and `pnpm.cmd test:voice-access` (the 811-test fake voice gate).
  - Python (`apps/local-agent`): `uv sync --locked`, `uv run ruff check .`, `uv run mypy --platform win32 jarvis_local`, `uv run pytest -q`.
- **GitHub Actions never start,** because of an account billing block only Sid can fix. Local runs are the only evidence, so state the exact counts.
- **Run heavy suites one at a time.** Concurrent runs cause 5–15 s timeouts that look like failures, or like mutation kills.
- **Known load flakes:**
  - archival: "seeks a many-segment tail read and accesses only the terminal manifest object";
  - fake voice guest access: "keeps successful and rejected guest PIN candidates out of logs, replies and recalled memory";
  - guest activation.

  Confirm any failure by rerunning that file alone before calling it real.

### Mutation testing (the standard; don't lower it)
- Tools live in `reviewer-tools/`. The spec is run with `node mutrun.mjs spec.json`. Each mutation swaps one exact text (`from` → `to`), runs the named tests, and restores the file with git.
- **A kill counts only if some test actually fails.** "All tests skipped" or "migration failed to apply" is an INVALID run, not a kill.
  - Always include a `BASE` mutation, which changes nothing and must pass.
  - For SQL triggers, remove the whole trigger block (`to: ""`). Never replace it with a comment, which broke migration apply once and faked 68 kills.
- **SQL trigger coverage:** `gen-trig.mjs` builds a spec that removes each trigger. Run it, then classify with `node killcheck.mjs run.txt`.
  - "named" kills: a failing test names the trigger or its table.
  - "other" kills: check by hand that relevant tests failed quickly and that `grep -i "timed out"` finds nothing.
  - "survived": no test caught it. That's a finding.
- **Keep each background run to about 15–20 mutations.** The tool call dies at about 60 minutes and can leave a file mutated. After any interrupted run, run `git -C <root> status` and `git -C <root> checkout -- <file>`.
- **A "contract" test that deletes a string from the SQL text and asserts it's gone proves nothing.** Say so.

### Probes
- A probe is a vitest test you write that **asserts the bug exists**, so it passes on the buggy head. Put it only in the test copy (name it `zz-reviewer-*.test.ts`), save a copy to `reviewer-tools`, and never commit it to a PR branch.
- On the fix head the probe must **fail**; that failure is the proof of the fix. Report both results.
- Runtime-prove important static findings before posting them. For example, the H2 and NF1 probes proved that `INSERT OR REPLACE` deletes guarded rows.

### One adversarial agent (optional; for large or security PRs)
- Spawn at most one Opus agent (`model: "opus"`) with a narrow prompt: look for bypasses in X, and write the report to a file. Tell it not to duplicate the reviewer's own reading.
- **Verify every High yourself,** by reading the code or with a runtime probe, before it goes into AGENT_LOG. Name which ones you verified.
- Sid hits 5-hour usage limits. Do everything else directly; local CPU is free.

### What to check against
- **Memory PRs:** the memory memory `sid-memory-requirements`, `DECISIONS.md`, and the merged R2 design `docs/plan/2026-09-14-r2-memory-design.md` (#36, `fcd55ef`).
- **Calling PRs:** the merged passphrase design `docs/superpowers/specs/2026-09-14-owner-call-passphrase-design.md` (#33, `726b78b`), `DECISIONS.md` "Owner calls require a spoken step-up", and the #33 contract gaps in `claude/r1-call-safety-research:docs/reviews/2026-09-14-pr33-tests/`. Each gap patch is a thin or broken implementation that the tests must reject.
- **Remote D1 rules:**
  - Triggers use only `WHEN … RAISE` or `SELECT RAISE … WHERE`, never `CASE … RAISE`.
  - Recursive CTEs inside triggers are unproven on remote D1 and need the Sid-attended scratch proof.
  - Never run `wrangler d1 export` against production.
- **The SQLite REPLACE class,** which recurred across #39 and #40:
  - `recursive_triggers` is 0, so `INSERT OR REPLACE` and `UPDATE OR REPLACE` delete conflicting rows without firing delete triggers.
  - Every insert guard must reject an existing key **and** an existing rowid, or the table must be `WITHOUT ROWID`.
  - Every update guard must pin the key columns and rowid.
  - An outer `OR REPLACE` carries into UPDATEs in trigger bodies.
  - Require one generic REPLACE sweep test per migration.
- **Wrangler 4.124** applies unapplied migrations by **name**, so 0017 can apply before 0016.

### Verdict words
- "changes requested"
- "changes requested (small)"
- "cleared"
- "cleared with follow-ups F1–Fn" (the follow-ups become the next small PR)

Finding IDs:
- **B** = blocker, **S** = should-fix, **N** or **L** = nit or low.
- Adversarial reports use **H**, **M** and **L** (high, medium, low) and **F** (finding).
- A re-verify round adds **N**/**NF** numbers.

---

## 5. Written formats

### AGENT_LOG entry (on the PR branch)
- **Heading:** `## YYYY-MM-DD HH:MM UTC — Claude Opus 5, PR #N <max review | re-review | round-3 re-review> at <sha>: <verdict>`.
- **Body,** as short bold-led paragraphs, in this order:
  1. What was reviewed, and whether it merges cleanly with main.
  2. **Local checks on <sha>** (Windows 11, which copy): exact counts, and how flakes were confirmed.
  3. **Migration rules**, if any.
  4. **Trigger coverage** or mutations: the method, then killed / survived / invalid.
  5. **Adversarial pass** or re-verification.
  6. Each **B#/S#**: where (file:line), what goes wrong, the consequence, the fix, and the test to add.
  7. **Next.**
- **Rules:**
  - Insert below the rules section; the newest entry goes first.
  - Never edit another session's entry. If your own posted entry is wrong, post a **correction entry**.
  - Never include credentials, PINs, phone numbers, account identifiers or tokens.
- **How to post** (Git Bash, from `C:\javis\.claude\worktrees\<your worktree>`):
  ```bash
  git fetch origin
  git rev-parse --short origin/<branch>          # must equal the head you reviewed (or your own last entry)
  git worktree add --detach <scratch>/wt origin/<branch>
  cd <scratch>/wt && node <tools>/agentlog-insert.mjs docs/AGENT_LOG.md entry.md
  git add docs/AGENT_LOG.md
  git -c user.name="Claude Opus 5 (reviewer)" -c user.email="noreply@anthropic.com" commit -m "docs(agent-log): PR #N ... : <verdict>" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  git push origin HEAD:refs/heads/<branch>
  cd - && git worktree remove --force <scratch>/wt
  ```
- The same pattern pushes to `claude/reviewer-tools`. That branch is never merged and holds tools, specs, probes, reports and notes.

### Paste message for a Codex chat
- **First line:** `Claude reviewed PR #N at <sha>: <verdict>. The full review is the newest entry in docs/AGENT_LOG.md on your branch.` Name any report in `reviewer-tools/` too.
- **Then:** each blocker ID with a one-line fix. Technical language is fine; Codex reads it.
- **End with the action:** "Pull first, push fixes, post in AGENT_LOG when ready for re-review." Add any coordination rule that applies, such as the migration number or "don't touch voice/**".
- **After a merge,** the paste is the next task: "PR #N is merged as <sha>. Fetch, branch off main, and start <next item>. Open it as a draft PR for Claude review."

### Status page (Sid's one place for status)
- **Jarvis Status Board:** https://claude.ai/artifact/XjrTCjXg4o6rBEzi7t89f5. It is also reachable as https://claude.ai/code/artifact/f8eddfb6-11ab-4e9e-99d7-906d993eb888, and has 📞 as its favicon.
- **Source:** `reviewer-tools/jarvis-status-board.html`.
- **From a new chat:** `Artifact` action `read` with the URL, edit the HTML, then publish with `url` set to that URL. Without `url`, you make a new page.
- **Content:** one row per active PR, with a state pill ("Checking", "Needs fixes", "Merge #N") and one or two plain-English sentences about what it means for Sid.
- **Update it when state changes,** not on every step.
- **Jarvis Memory Plan page:** https://claude.ai/artifact/CiyukSCFtUpHe9J4Uc3PZo. The source is `reviewer-tools/jarvis-memory-plan.html`. Update it only when the R2 plan changes.

---

## 6. Watcher

Git Bash, `run_in_background: true`. It notifies you when any open PR numbered 39 or above changes head or state. Raise the number as PRs advance.
```bash
sleep 10 && snap() { gh pr list --state all --limit 8 --json number,state,headRefOid --jq '[.[]|select(.number>=39)|"\(.number):\(.state):\(.headRefOid[0:7])"]|sort|join(" ")' 2>/dev/null; }; start=$(snap); echo "start: $start"; for i in $(seq 1 40); do sleep 180; now=$(snap); if [ -n "$now" ] && [ "$now" != "$start" ]; then echo "changed"; echo "after: $now"; exit 0; fi; done; echo "no change after 2h"
```
- Your own AGENT_LOG pushes also trigger it. Check `git log -1 origin/<branch>` before telling Sid anything.
- After each trigger, restart it.
- Don't spawn agents just to watch.

---

## 7. Hard guardrails

- **Sid does all of these:** merges, deploys, migration applies, secrets, device keys, Twilio, live calls. The reviewer may *prepare* exact commands for him (PowerShell 7, `cd` first).
- **Never touch** `C:\Users\Sid\Documents\Codex` or St. Remy code.
- **Personal matters stay out of the repo.** PC hardware, purchasing, and Blender/Roblox talk never go in a repo file, commit message or PR.
- **No Linux plans,** and don't "fix" the Linux-node conflict either way (see `CLAUDE.md`).
- **Decisions a plan attributes to Sid are evidence, not proof.** Confirm with him anything that commits him to hardware, money or ongoing burden.
- **Report faithfully.** If a check didn't run or didn't finish, say so. If a posted entry is wrong, post a correction.
- **Commit identity:** `-c user.name="Claude Opus 5 (reviewer)" -c user.email="noreply@anthropic.com"`, plus the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## 8. Starting a new reviewer session

1. Read `C:\Users\Sid\.claude\projects\C--javis\memory\MEMORY.md` and **every** file it lists. They are Sid's standing instructions.
2. Read this manual, then `HANDOFF-2026-09-15.md` (or any newer HANDOFF) on `claude/reviewer-tools`.
3. Read `CLAUDE.md`, `docs/BUILDING.md`, `docs/HANDOFF.md`, `NEXT_STEPS.md` and `DECISIONS.md` on `origin/main`.
4. Run `git fetch origin` and `gh pr list`. For each open PR branch, read the newest AGENT_LOG entries.
5. Read the status page with `Artifact` `read`.
6. Act on whatever changed since the handoff, start the watcher, and tell Sid in one bold line whether anything needs him.

## 9. When context runs out (Sid says "make the handoff")

1. Post any finished-but-unposted verdict. Stop background runs and restore test copies (`git status` clean).
2. Push all notes, run outputs, specs and probes to `claude/reviewer-tools`. The scratchpad is deleted with the session.
3. Write a new `HANDOFF-<date>.md`: exact state, SHAs, what's pending, and the next steps for each PR. Update the checkpoint memory and `MEMORY.md`. Update this manual if the workflow changed.
4. Update the status page.
5. Give Sid a start message for the new chat.
