#!/usr/bin/env bash
# Merge-only update of a reviewer-cleared PR branch with origin/main.
# Resolves ONLY docs/AGENT_LOG.md (keep both: branch entries, then main's) and
# docs/OWNER-ACTIONS.md (keep both rows: main's first, then the branch's).
# Any other conflict aborts and leaves nothing pushed.
# Usage: merge-main-into.sh <reviewed-head-sha> <branch>
set -euo pipefail
head="$1"; branch="$2"; wt="/c/w/merge-$(echo "$branch" | tr '/' '-')"
cd /c/javis && git fetch -q origin
[ "$(git rev-parse "origin/$branch")" = "$(git rev-parse "$head")" ] || { echo "ABORT: origin/$branch is not the reviewed head $head"; exit 2; }
git worktree remove --force "$wt" 2>/dev/null || true
git worktree add -q --detach "$wt" "$head"
cd "$wt"
git -c user.name=Codex -c user.email=ksid1229@gmail.com merge --no-ff --no-commit origin/main >/dev/null 2>&1 || true
conflicts=$(git diff --name-only --diff-filter=U)
for f in $conflicts; do
  case "$f" in docs/AGENT_LOG.md|docs/OWNER-ACTIONS.md) ;; *) echo "ABORT: code conflict in $f"; git merge --abort; exit 3;; esac
done
python - $conflicts <<'EOF'
import re, sys
for p in sys.argv[1:]:
    s = open(p, 'rb').read().decode('utf-8')
    pat = re.compile(r'^<<<<<<< HEAD\r?\n(.*?)^=======\r?\n(.*?)^>>>>>>> origin/main\r?\n', re.S | re.M)
    if p.endswith('OWNER-ACTIONS.md'):
        s = pat.sub(lambda m: m.group(2) + m.group(1), s)
    else:
        s = pat.sub(lambda m: m.group(1) + m.group(2), s)
    open(p, 'wb').write(s.encode('utf-8'))
EOF
for f in docs/AGENT_LOG.md docs/OWNER-ACTIONS.md; do
  grep -q '^<<<<<<<\|^=======$\|^>>>>>>>' "$f" && { echo "ABORT: markers left in $f"; exit 4; }
  for side in origin/main "$head"; do
    # Only lines this side ADDED since the merge base must survive; a base line the other side edited may change.
    d=$(comm -23 <(comm -23 <(git show "$side:$f" | grep -E '^(## |\| )' | sort) <(git show "$(git merge-base origin/main "$head"):$f" 2>/dev/null | grep -E '^(## |\| )' | sort)) <(grep -E '^(## |\| )' "$f" | sort) | wc -l)
    [ "$d" -eq 0 ] || { echo "ABORT: $f dropped $d heading/row lines from $side"; exit 5; }
  done
done
node scripts/check-state.mjs | tail -1
git add -A docs/AGENT_LOG.md docs/OWNER-ACTIONS.md
git commit -q -m "Merge origin/main into $branch

Keeps both sides of the docs conflicts ($(echo $conflicts | tr '\n' ' ')); no code file conflicted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q origin "HEAD:$branch"
echo "PUSHED $(git rev-parse HEAD) conflicts: ${conflicts:-none}"
cd /c/javis && git worktree remove --force "$wt"
