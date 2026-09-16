#!/usr/bin/env bash
# PR #54 round-3 max re-review evidence (R1 release gate), serialized in jarvis-pr39.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
REPO="/c/javis/.claude/worktrees/jarvis-reviewer-handoff-621ea3"
R="C:/Users/Sid/jarvis-pr39"
B=codex/r1-step-up-release-evidence
OUT="$ME/pr54/round3"
mkdir -p "$OUT"
cd "$REPO" || exit 1
git fetch -q origin
H=$(git rev-parse origin/$B)
echo "reviewing ${H:0:7}; main $(git rev-parse --short origin/main); merge-base $(git merge-base origin/main $H | cut -c1-7)"
echo "migrations added:"; git diff --name-only origin/main...$H | grep migrations || echo "(none)"
cd "$R" || exit 1
[ -z "$(git status --porcelain)" ] || { git checkout -- . ; git clean -fdq apps tests packages; echo "restored dirty tree"; }
git fetch -q origin && git checkout --detach "$H" >/dev/null 2>&1
echo "pr39 head $(git rev-parse --short HEAD)"
git diff --quiet origin/main "$H" -- pnpm-lock.yaml && echo "lockfile same as main" || { pnpm.cmd install --frozen-lockfile > "$OUT/install.txt" 2>&1; echo "install exit $?"; }
for step in lint typecheck test test:voice-smoke test:voice-access typecheck:voice-access; do
  f=$(echo "$step" | tr ':' '-')
  pnpm.cmd $step > "$OUT/54c-$f.txt" 2>&1; echo "$step exit $?"
done
for f in 54c-test 54c-test-voice-smoke 54c-test-voice-access; do
  echo "--- $f"; grep -a -E "Test Files|Tests +[0-9]" "$OUT/$f.txt" | tail -2
  echo "timeouts: $(grep -a -ci 'timed out' "$OUT/$f.txt")"
  grep -a -E '^\s*(×|FAIL )' "$OUT/$f.txt" | head -6
done
python "$ME/pr54/round3/build-mut54c.py"
echo "clean before mutations=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
cd "$ME/tools" && node mutrun.mjs "$OUT/mut54c.json" > "$OUT/run54c.txt" 2>&1
sed -n '/=== summary/,$p' "$OUT/run54c.txt" | grep -v DEP0190 | grep -v trace-deprecation
echo "mutation timeouts: $(grep -a -ci 'timed out' "$OUT/run54c.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,60)"] "} END{print id" | "n" failed | "b}' "$OUT/run54c.txt"
grep -a -E "MATCHED|no test summary" "$OUT/run54c.txt" | head
git -C "$R" status --short | head -3
echo "done $(date -u +%H:%M)"
