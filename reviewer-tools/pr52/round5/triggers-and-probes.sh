#!/usr/bin/env bash
# PR #52 round 5: trigger removal and the four reviewer probes, serialized in jarvis-pr39.
# The first attempt was invalid — BASE was killed and the 0024 file went missing mid-run because
# another mutrun checked the tree back to main underneath it. This one verifies BASE survives.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
R="C:/Users/Sid/jarvis-pr39"
H=762e54b
SQL=apps/cloud-gateway/src/persistence/migrations/0024_university_application_workflow.sql
OUT="$ME/pr52/round5"
cd "$R" || exit 1
git checkout -- . 2>/dev/null; git clean -fdq apps tests packages 2>/dev/null
git checkout --detach "$H" >/dev/null 2>&1
echo "head $(git rev-parse --short HEAD); clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
[ -f "$R/$SQL" ] || { echo "0024 missing, abort"; exit 1; }
echo "CASE count in 0024: $(grep -c -i 'CASE' "$SQL")"
TESTS="apps/cloud-gateway/test/persistence/university-application-workflow-migration.test.ts,apps/cloud-gateway/test/university/university-application-workflow-repository.test.ts,apps/cloud-gateway/test/university/university-application-workflow-model.test.ts,apps/cloud-gateway/test/persistence/university-tracker-migration.test.ts,apps/cloud-gateway/test/persistence/remote-d1-migration-syntax.test.ts"
node "$ME/tools/gen-trig.mjs" "$R/$SQL" "$OUT/mut52e-triggers.json" "$H" "$R" "$SQL" "$TESTS"
cd "$ME/tools" && node mutrun.mjs "$OUT/mut52e-triggers.json" > "$OUT/run52etrig.txt" 2>&1
echo "=== trigger removal ==="
sed -n '/=== summary/,$p' "$OUT/run52etrig.txt" | grep -v DEP0190 | grep -v trace-deprecation
echo "timeouts: $(grep -a -ci 'timed out' "$OUT/run52etrig.txt"), ENOENT: $(grep -a -c 'ENOENT' "$OUT/run52etrig.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,58)"] "} END{print id" | "n" failed | "b}' "$OUT/run52etrig.txt"
echo "=== probes (all four must FAIL) ==="
cd "$R" || exit 1
git checkout --detach "$H" >/dev/null 2>&1
cp "$ME/pr52/zz-reviewer-pr52-probes.test.ts" apps/cloud-gateway/test/university/zz-reviewer-pr52-probes.test.ts
npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/university/zz-reviewer-pr52-probes.test.ts > "$OUT/probes-run.txt" 2>&1
grep -a -E "Test Files|Tests +[0-9]|^\s+(×|✓)" "$OUT/probes-run.txt" | head -10
rm -f apps/cloud-gateway/test/university/zz-reviewer-pr52-probes.test.ts
echo "tree clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
echo "done $(date -u +%H:%M)"
