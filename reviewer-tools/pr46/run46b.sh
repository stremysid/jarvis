#!/usr/bin/env bash
# PR #46 round-2 max re-review evidence at 91fe8be, serialized in jarvis-pr40.
S="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-handoff-documentation-c01991/9a15d86f-02aa-4a68-8ded-4c145dc1fedd/scratchpad"
OLD="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-handoff-documentation-c01991/f6ee0749-e25d-4c90-830f-7ef6bbf969c9/scratchpad"
R="C:/Users/Sid/jarvis-pr40"
HEAD_SHA=91fe8be
cd "$R" || exit 1
[ -z "$(git status --porcelain)" ] || { echo "pr40 copy dirty"; exit 1; }
git checkout --detach $HEAD_SHA >/dev/null 2>&1
echo "head $(git rev-parse --short HEAD)"
if git diff --quiet 2fdce98 $HEAD_SHA -- pnpm-lock.yaml; then echo "lockfile unchanged"; else pnpm.cmd install --frozen-lockfile > "$S/install46b.txt" 2>&1; echo "install exit $?"; fi
for step in lint typecheck typecheck:voice-access test; do
  f="$S/46b-$(echo $step | tr ':' '_').txt"
  pnpm.cmd $step > "$f" 2>&1; echo "$step exit $?"
done
grep -E "Test Files|Tests +[0-9]" "$S/46b-test.txt" | tail -2; echo "test timeouts: $(grep -ci 'timed out' "$S/46b-test.txt")"
grep -E '^\s*(×|FAIL )' "$S/46b-test.txt" | head -8
pnpm.cmd test:voice-access > "$S/46b-voice.txt" 2>&1; echo "voice-access exit $?"
grep -E "Test Files|Tests +[0-9]|ℹ pass|ℹ fail" "$S/46b-voice.txt" | tail -4; echo "voice timeouts: $(grep -ci 'timed out' "$S/46b-voice.txt")"

# Contract gaps (re-ported to 91fe8be)
TESTS="apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/persistence/owner-call-step-up-migration.test.ts apps/cloud-gateway/test/voice/call-session-do.test.ts tests/acceptance/fake/voice-owner-call-step-up.test.ts tests/acceptance/fake/voice-owner-passphrase-security.test.ts"
for g in base gap0 gap1 gap2b gap3b gap3c gap3d gap3e gap6 gap6b; do
  if [ "$g" != "base" ]; then git apply "$S/gaps46b/port46b-$g.diff" || { echo "== $g: APPLY FAILED"; continue; }; fi
  npx.cmd vitest --config vitest.workspace.ts run $TESTS > "$S/gaps46b/run-$g.txt" 2>&1; code=$?
  git checkout -- . ; git clean -fdq apps tests >/dev/null 2>&1
  echo "== gap $g: exit=$code $(grep -a -E 'Tests +[0-9]' "$S/gaps46b/run-$g.txt" | tail -1 | tr -s ' ') timeouts=$(grep -a -ci 'timed out' "$S/gaps46b/run-$g.txt") clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
done

# PR #40 reverify3 probes
cp "$OLD/gaps/pr40-reverify3-probes.test.ts" tests/acceptance/fake/zz-reviewer-pr40-reverify3.test.ts
npx.cmd vitest --config vitest.workspace.ts run tests/acceptance/fake/zz-reviewer-pr40-reverify3.test.ts -t reverify3 > "$S/46b-probes-acceptance.txt" 2>&1; echo "acceptance probes exit $?"
rm -f tests/acceptance/fake/zz-reviewer-pr40-reverify3.test.ts
grep -a -E "×|✓" "$S/46b-probes-acceptance.txt" | head -4; grep -a -E "refusals=|REPORT" "$S/46b-probes-acceptance.txt" | head -4
cat "$OLD/gaps/pr40-reverify3-core-probes.test.ts" >> apps/cloud-gateway/test/voice/call-session-do.test.ts
npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/call-session-do.test.ts -t reverify3 > "$S/46b-probes-core.txt" 2>&1; echo "core probes exit $?"
git checkout -- apps/cloud-gateway/test/voice/call-session-do.test.ts
grep -a -E "Q1c|Q2c|Q3c|Q6c" "$S/46b-probes-core.txt" | grep -a -E "×|✓" | head -4
echo "clean before triggers=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"

# 0021 whole-trigger removals
cd "$OLD/tools" && node mutrun.mjs "$S/mut46b-triggers.json" > "$S/run46btrig.txt" 2>&1
sed -n '/=== summary/,$p' "$S/run46btrig.txt"; echo "trigger timeouts: $(grep -a -ci 'timed out' "$S/run46btrig.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,56)"] "} END{print id" | "n" failed | "b}' "$S/run46btrig.txt"
git -C "$R" status --short | head -3
