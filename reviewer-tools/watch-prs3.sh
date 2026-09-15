#!/usr/bin/env bash
# Poll PRs numbered >= 50 every 3 minutes; exit only on a change the reviewer did not cause.
# SHAs the reviewer pushed or merged at are listed one per line in own-posts.txt; a PR entry
# (open or merged) whose head is one of them is ignored.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
OWN="$ME/own-posts.txt"
cd /c/javis/.claude/worktrees/jarvis-code-review-0b1695 || exit 1
snap() {
  gh pr list --state all --limit 20 --json number,state,headRefOid \
    --jq '[.[] | select(.number >= 50)] | sort_by(.number) | map("\(.number):\(.state):\(.headRefOid[0:7])") | join(" ")' 2>/dev/null
}
START=$(snap)
echo "start: $START"
while true; do
  sleep 180
  NOW=$(snap)
  [ -z "$NOW" ] && continue
  [ "$NOW" = "$START" ] && continue
  external=0
  for entry in $NOW; do
    case " $START " in *" $entry "*) continue ;; esac
    sha=${entry##*:}
    if grep -qx "$sha" "$OWN" 2>/dev/null; then continue; fi
    external=1
  done
  if [ $external = 1 ]; then
    echo "changed"; echo "after: $NOW"; exit 0
  fi
  START=$NOW
done
