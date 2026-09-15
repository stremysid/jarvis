#!/usr/bin/env bash
# PR #52 round-3 max re-review evidence (migration 0024), serialized in jarvis-pr39.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
REPO="/c/javis/.claude/worktrees/jarvis-reviewer-handoff-621ea3"
R="C:/Users/Sid/jarvis-pr39"
B=codex/r5-application-track-slice1
SQL=apps/cloud-gateway/src/persistence/migrations/0024_university_application_workflow.sql
OUT="$ME/pr52/round3"
mkdir -p "$OUT"
cd "$REPO" || exit 1
git fetch -q origin
H=$(git rev-parse origin/$B)
echo "reviewing ${H:0:7}; main $(git rev-parse --short origin/main); merge-base $(git merge-base origin/main $H | cut -c1-7)"
echo "migrations added:"; git diff --name-only origin/main...$H | grep migrations
cd "$R" || exit 1
[ -z "$(git status --porcelain)" ] || { git checkout -- . ; git clean -fdq apps tests packages; echo "restored dirty tree"; }
git fetch -q origin && git checkout --detach "$H" >/dev/null 2>&1
echo "pr39 head $(git rev-parse --short HEAD)"
git diff --quiet origin/main "$H" -- pnpm-lock.yaml && echo "lockfile same as main" || { pnpm.cmd install --frozen-lockfile > "$OUT/install.txt" 2>&1; echo "install exit $?"; }
for step in lint typecheck test; do pnpm.cmd $step > "$OUT/52-$step.txt" 2>&1; echo "$step exit $?"; done
grep -a -E "Test Files|Tests +[0-9]" "$OUT/52-test.txt" | tail -2; echo "timeouts: $(grep -a -ci 'timed out' "$OUT/52-test.txt")"
grep -a -E '^\s*(×|FAIL )' "$OUT/52-test.txt" | head -12
echo "=== remote-D1 syntax: CASE count in 0024: $(grep -c -i 'CASE' "$SQL")"
TESTS="apps/cloud-gateway/test/persistence/university-application-workflow-migration.test.ts,apps/cloud-gateway/test/university/university-application-workflow-repository.test.ts,apps/cloud-gateway/test/university/university-application-workflow-model.test.ts,apps/cloud-gateway/test/persistence/university-tracker-migration.test.ts,apps/cloud-gateway/test/persistence/remote-d1-migration-syntax.test.ts"
node "$ME/tools/gen-trig.mjs" "$R/$SQL" "$OUT/mut52c-triggers.json" "$H" "$R" "$SQL" "$TESTS"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("trigger mutations:",s.mutations.length-1)' "$OUT/mut52c-triggers.json"
echo "clean before triggers=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
cd "$ME/tools" && node mutrun.mjs "$OUT/mut52c-triggers.json" > "$OUT/run52ctrig.txt" 2>&1
sed -n '/=== summary/,$p' "$OUT/run52ctrig.txt" | grep -v DEP0190 | grep -v trace-deprecation
echo "trigger timeouts: $(grep -a -ci 'timed out' "$OUT/run52ctrig.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,60)"] "} END{print id" | "n" failed | "b}' "$OUT/run52ctrig.txt"
grep -a -E "MATCHED|no test summary" "$OUT/run52ctrig.txt" | head
echo "=== probes (all four must FAIL) ==="
cd "$R" || exit 1
cp "$ME/pr52/zz-reviewer-pr52-probes.test.ts" apps/cloud-gateway/test/university/zz-reviewer-pr52-probes.test.ts
npm.cmd run npx -- vitest --config vitest.workspace.ts run apps/cloud-gateway/test/university/zz-reviewer-pr52-probes.test.ts > "$OUT/probes-run.txt" 2>&1
grep -a -E "Test Files|Tests +[0-9]|^\s+(×|✓)" "$OUT/probes-run.txt" | head -12
rm -f apps/cloud-gateway/test/university/zz-reviewer-pr52-probes.test.ts
git -C "$R" status --short | head -3
echo "done $(date -u +%H:%M)"
