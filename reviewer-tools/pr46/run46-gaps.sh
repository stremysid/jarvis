#!/usr/bin/env bash
# Applies each ported contract-gap diff to the #46 test copy, runs the step-up contract
# tests, records the result, and restores the tree. A kill counts only on a genuine
# assertion failure; a run with "timed out" or zero executed tests is INVALID.
S="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-handoff-documentation-c01991/f6ee0749-e25d-4c90-830f-7ef6bbf969c9/scratchpad/gaps"
R="C:/Users/Sid/jarvis-pr40"
TESTS="apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/persistence/owner-call-step-up-migration.test.ts apps/cloud-gateway/test/voice/call-session-do.test.ts tests/acceptance/fake/voice-owner-call-step-up.test.ts tests/acceptance/fake/voice-owner-passphrase-security.test.ts"
cd "$R" || exit 1
[ "$(git rev-parse --short HEAD)" = "2fdce98" ] || { echo "wrong head"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "tree dirty"; exit 1; }
for g in base ${GAPS:-gap0 gap1 gap2b gap3b gap3c gap3d gap3e gap6 gap6b}; do
  if [ "$g" != "base" ]; then
    git apply "$S/port46-$g.diff" || { echo "== $g: APPLY FAILED"; continue; }
  fi
  npx.cmd vitest --config vitest.workspace.ts run $TESTS > "$S/run46-$g.txt" 2>&1
  code=$?
  git checkout -- . ; git clean -fdq apps tests >/dev/null 2>&1
  summary=$(grep -E "Tests +[0-9]" "$S/run46-$g.txt" | tail -1 | tr -s ' ')
  timeouts=$(grep -ci "timed out" "$S/run46-$g.txt")
  echo "== $g: exit=$code $summary timeouts=$timeouts clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
  grep -E '^\s*×' "$S/run46-$g.txt" | head -3
done
