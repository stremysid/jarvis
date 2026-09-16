#!/usr/bin/env bash
# 1) verify main after the #54 and #53 merges, 2) PR #56 round-2 max re-review evidence.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
REPO="/c/javis/.claude/worktrees/jarvis-reviewer-handoff-621ea3"
R="C:/Users/Sid/jarvis-pr39"
B=codex/r2-archive-literal-history
SQL=apps/cloud-gateway/src/persistence/migrations/0025_archive_literal_history.sql
OUT="$ME/pr56/round2"
mkdir -p "$OUT"
cd "$R" || exit 1
[ -z "$(git status --porcelain)" ] || { git checkout -- . ; git clean -fdq apps tests packages scripts; echo "restored dirty tree"; }
git fetch -q origin
echo "=== main verification after the #54 and #53 merges ==="
git checkout --detach origin/main >/dev/null 2>&1
echo "main $(git rev-parse --short HEAD)"
for step in lint typecheck test; do pnpm.cmd $step > "$ME/main-after-53-$step.txt" 2>&1; echo "main $step exit $?"; done
grep -a -E "Test Files|Tests +[0-9]" "$ME/main-after-53-test.txt" | tail -2
echo "main timeouts: $(grep -a -ci 'timed out' "$ME/main-after-53-test.txt")"
grep -a -E '^\s*(×|FAIL )' "$ME/main-after-53-test.txt" | head -8

echo "=== PR #56 round 2 ==="
cd "$REPO" || exit 1
H=$(git rev-parse origin/$B)
echo "reviewing ${H:0:7}; main $(git rev-parse --short origin/main); merge-base $(git merge-base origin/main $H | cut -c1-7)"
cd "$R" || exit 1
git checkout --detach "$H" >/dev/null 2>&1
echo "pr39 head $(git rev-parse --short HEAD)"
git diff --quiet origin/main "$H" -- pnpm-lock.yaml && echo "lockfile same as main" || { pnpm.cmd install --frozen-lockfile > "$OUT/install.txt" 2>&1; echo "install exit $?"; }
for step in lint typecheck test; do pnpm.cmd $step > "$OUT/56b-$step.txt" 2>&1; echo "$step exit $?"; done
grep -a -E "Test Files|Tests +[0-9]" "$OUT/56b-test.txt" | tail -2; echo "timeouts: $(grep -a -ci 'timed out' "$OUT/56b-test.txt")"
grep -a -E '^\s*(×|FAIL )' "$OUT/56b-test.txt" | head -10
echo "=== remote-D1 syntax: CASE count in 0025: $(grep -c -i 'CASE' "$SQL")"
TESTS="apps/cloud-gateway/test/persistence/archive-literal-history-migration.test.ts,apps/cloud-gateway/test/memory/literal-history.test.ts,apps/cloud-gateway/test/memory/memory-repository.test.ts,apps/cloud-gateway/test/memory/memory-owner-controls.test.ts,apps/cloud-gateway/test/persistence/remote-d1-migration-syntax.test.ts"
node "$ME/tools/gen-trig.mjs" "$R/$SQL" "$OUT/mut56b-triggers.json" "$H" "$R" "$SQL" "$TESTS"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("trigger mutations:",s.mutations.length-1)' "$OUT/mut56b-triggers.json"
echo "clean before triggers=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
cd "$ME/tools" && node mutrun.mjs "$OUT/mut56b-triggers.json" > "$OUT/run56btrig.txt" 2>&1
sed -n '/=== summary/,$p' "$OUT/run56btrig.txt" | grep -v DEP0190 | grep -v trace-deprecation
echo "trigger timeouts: $(grep -a -ci 'timed out' "$OUT/run56btrig.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,70)"] "} END{print id" | "n" failed | "b}' "$OUT/run56btrig.txt"
grep -a -E "MATCHED|no test summary" "$OUT/run56btrig.txt" | head
git -C "$R" status --short | head -3
echo "done $(date -u +%H:%M)"
