#!/usr/bin/env bash
# PR #53 max review evidence (migration 0023), serialized in jarvis-pr39, at the branch's current head.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
REPO="/c/javis/.claude/worktrees/jarvis-code-review-0b1695"
R="C:/Users/Sid/jarvis-pr39"
B=codex/r5-study-coach-slice1
SQL=apps/cloud-gateway/src/persistence/migrations/0023_study_coach.sql
OUT="$ME/pr53/round2"
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
for step in lint typecheck test; do pnpm.cmd $step > "$OUT/53b-$step.txt" 2>&1; echo "$step exit $?"; done
grep -a -E "Test Files|Tests +[0-9]" "$OUT/53b-test.txt" | tail -2; echo "timeouts: $(grep -a -ci 'timed out' "$OUT/53b-test.txt")"
grep -a -E '^\s*(×|FAIL )' "$OUT/53b-test.txt" | head -8
echo "=== remote-D1 syntax: CASE count in 0023: $(grep -c -i 'CASE' "$SQL")"
TESTS="apps/cloud-gateway/test/persistence/study-coach-migration.test.ts,apps/cloud-gateway/test/school/study-coach-repository.test.ts,apps/cloud-gateway/test/school/study-coach-model.test.ts,apps/cloud-gateway/test/persistence/remote-d1-migration-syntax.test.ts,apps/cloud-gateway/test/persistence/school-catchup-migration.test.ts"
node "$ME/tools/gen-trig.mjs" "$R/$SQL" "$OUT/mut53b-triggers.json" "$H" "$R" "$SQL" "$TESTS"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("trigger mutations:",s.mutations.length-1)' "$OUT/mut53b-triggers.json"
echo "clean before triggers=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
cd "$ME/tools" && node mutrun.mjs "$OUT/mut53b-triggers.json" > "$OUT/run53btrig.txt" 2>&1
sed -n '/=== summary/,$p' "$OUT/run53btrig.txt" | grep -v DEP0190 | grep -v trace-deprecation
echo "trigger timeouts: $(grep -a -ci 'timed out' "$OUT/run53btrig.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,60)"] "} END{print id" | "n" failed | "b}' "$OUT/run53btrig.txt"
grep -a -E "MATCHED|no test summary" "$OUT/run53btrig.txt" | head
git -C "$R" status --short | head -3
echo "done $(date -u +%H:%M)"
