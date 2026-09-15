#!/usr/bin/env bash
# PR #53 round-3 re-review evidence, serialized in jarvis-pr39.
# 0023 is byte-identical to the round-2 head, so the 17/17 trigger-removal result stands; no rerun.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
REPO="/c/javis/.claude/worktrees/jarvis-reviewer-handoff-621ea3"
R="C:/Users/Sid/jarvis-pr39"
B=codex/r5-study-coach-slice1
OUT="$ME/pr53/round3"
mkdir -p "$OUT"
cd "$REPO" || exit 1
git fetch -q origin
H=$(git rev-parse origin/$B)
echo "reviewing ${H:0:7}; main $(git rev-parse --short origin/main); merge-base $(git merge-base origin/main $H | cut -c1-7)"
echo "migration unchanged since 2d3bac6: $(git diff --quiet 2d3bac6 $H -- apps/cloud-gateway/src/persistence/migrations/ && echo yes || echo NO)"
cd "$R" || exit 1
[ -z "$(git status --porcelain)" ] || { git checkout -- . ; git clean -fdq apps tests packages; echo "restored dirty tree"; }
git fetch -q origin && git checkout --detach "$H" >/dev/null 2>&1
echo "pr39 head $(git rev-parse --short HEAD)"
git diff --quiet origin/main "$H" -- pnpm-lock.yaml && echo "lockfile same as main" || { pnpm.cmd install --frozen-lockfile > "$OUT/install.txt" 2>&1; echo "install exit $?"; }
for step in lint typecheck test; do pnpm.cmd $step > "$OUT/53c-$step.txt" 2>&1; echo "$step exit $?"; done
grep -a -E "Test Files|Tests +[0-9]" "$OUT/53c-test.txt" | tail -2; echo "timeouts: $(grep -a -ci 'timed out' "$OUT/53c-test.txt")"
grep -a -E '^\s*(×|FAIL )' "$OUT/53c-test.txt" | head -12
echo "=== probes (all five must FAIL) ==="
cp "$ME/pr53/zz-reviewer-pr53-probes.test.ts" apps/cloud-gateway/test/school/zz-reviewer-pr53-probes.test.ts
npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/school/zz-reviewer-pr53-probes.test.ts > "$OUT/probes-run.txt" 2>&1
grep -a -E "Test Files|Tests +[0-9]|^\s+(×|✓)" "$OUT/probes-run.txt" | head -12
rm -f apps/cloud-gateway/test/school/zz-reviewer-pr53-probes.test.ts
echo "tree clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
echo "done $(date -u +%H:%M)"
