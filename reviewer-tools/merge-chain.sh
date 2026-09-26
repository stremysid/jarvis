#!/usr/bin/env bash
# Sequential merge chain for reviewer-cleared PRs. Stops at the first problem.
# Args: triples of <pr> <reviewed-or-merge-only-head> <branch> ; first may already be merge-updated.
set -uo pipefail
R="$(dirname "$0")"
wait_ci() { local pr=$1 sha=$2; sleep 30
  while :; do s=$(gh pr checks $pr --json bucket --jq '[.[].bucket]|unique|join(",")' 2>/dev/null); h=$(gh pr view $pr --json headRefOid --jq .headRefOid 2>/dev/null)
    [ "$h" = "$sha" ] || { echo "STOP #$pr: head moved to $h"; return 1; }
    [ -n "$s" ] && ! echo "$s" | grep -q pending && break; sleep 45; done
  [ "$s" = "pass" ] || { echo "STOP #$pr: CI $s"; return 1; }; }
while [ $# -ge 3 ]; do pr=$1; head=$2; br=$3; shift 3
  cd /c/javis; git fetch -q origin
  if ! git merge-base --is-ancestor origin/main "$head"; then
    out=$(bash "$R/merge-main-into.sh" "$head" "$br" 2>&1 | tail -3); echo "#$pr merge-main: $out"
    echo "$out" | grep -q '^PUSHED' || { echo "STOP #$pr: merge-main failed"; exit 1; }
    head=$(echo "$out" | grep '^PUSHED' | awk '{print $2}')
  fi
  wait_ci $pr $head || exit 1
  gh pr merge $pr --squash --match-head-commit $head >/dev/null 2>&1
  st=$(gh pr view $pr --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid[0:8])"'); echo "#$pr $st at $(date '+%I:%M %p')"
  echo "$st" | grep -q MERGED || { echo "STOP #$pr: merge failed"; exit 1; }
done
echo "CHAIN DONE; main $(git -C /c/javis fetch -q origin && git -C /c/javis rev-parse --short origin/main)"
