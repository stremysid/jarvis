#!/usr/bin/env bash
# Usage: merge-cleared.sh <pr> <branch> <reviewed-sha> <entry.md>
# Posts the clearance entry, merges origin/main (AGENT_LOG-only conflicts resolved by prepending),
# verifies the non-log tree equals the reviewed sha plus main, pushes, merges at the exact head, verifies main.
set -euo pipefail
SP="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-handoff-documentation-c01991/1b142017-0838-4dd9-9f2b-b76bb0eba596/scratchpad"
PR=$1; BR=$2; REVIEWED=$3; ENTRY=$4
WT="$SP/work/wt$PR"
cd "C:/javis/.claude/worktrees/handoff-documentation-c01991"
git fetch -q origin
[ -d "$WT" ] && git worktree remove --force "$WT"
git worktree add -q "$WT" "origin/$BR"
cd "$WT"
git checkout -q -B "$BR" "origin/$BR"
BRANCH_LOG=$(mktemp); cp docs/AGENT_LOG.md "$BRANCH_LOG"
if ! git merge -q --no-edit origin/main >/dev/null 2>&1; then
  CONFLICTS=$(git diff --name-only --diff-filter=U)
  [ "$CONFLICTS" = "docs/AGENT_LOG.md" ] || { echo "NON-LOG CONFLICT: $CONFLICTS"; git merge --abort; exit 2; }
  git show origin/main:docs/AGENT_LOG.md > /dev/null
  git show "origin/$BR:docs/AGENT_LOG.md" | tr -d '\r' > "$BRANCH_LOG"
  git show origin/main:docs/AGENT_LOG.md | tr -d '\r' > "$BRANCH_LOG.main"
  node "$SP/agentlog-merge.mjs" "$BRANCH_LOG" "$BRANCH_LOG.main" docs/AGENT_LOG.md
  git add docs/AGENT_LOG.md
  git commit -q -m "Merge origin/main into $BR

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
fi
node "$SP/agentlog-top.mjs" docs/AGENT_LOG.md "$ENTRY"
git add docs/AGENT_LOG.md
git commit -q -m "docs(agent-log): PR #$PR cleared at ${REVIEWED:0:7}

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
# Non-log content must equal reviewed head with main's non-log changes applied.
EXPECT=$(git diff "$(git merge-base "$REVIEWED" origin/main)" "$REVIEWED" -- . ':!docs/AGENT_LOG.md' | git patch-id --stable | cut -d' ' -f1 || true)
ACTUAL=$(git diff origin/main HEAD -- . ':!docs/AGENT_LOG.md' | git patch-id --stable | cut -d' ' -f1 || true)
echo "reviewed patch-id ${EXPECT:-none} | merged patch-id ${ACTUAL:-none}"
[ "$EXPECT" = "$ACTUAL" ] || { echo "TREE MISMATCH - not merging"; exit 3; }
git rev-parse HEAD >> "$SP/own-posts.txt"
git push -q origin "$BR"
H=$(git rev-parse HEAD)
gh pr ready "$PR" >/dev/null 2>&1 || true
for i in 1 2 3 4 5 6; do M=$(gh pr view "$PR" --json mergeable --jq .mergeable); [ "$M" != "UNKNOWN" ] && break; sleep 5; done
echo "mergeable: $M"
gh pr merge "$PR" --merge --match-head-commit "$H"
cd "C:/javis/.claude/worktrees/handoff-documentation-c01991"; git fetch -q origin
echo "main now $(git rev-parse --short origin/main)"
git diff --quiet "$H" origin/main && echo "main tree == merged head tree" || { echo "MAIN TREE DIFFERS"; exit 4; }
git worktree remove --force "$WT"
