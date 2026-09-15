#!/usr/bin/env bash
# Usage: run-gap.sh <gap-id> <test files...>
# Applies one ported gap (and its probe, if any), saves the diff, runs one vitest process,
# then restores the throwaway copy and proves it clean.
set -u
GAP="$1"; shift
OUT="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/94258c1b-4724-43a5-acec-ad80dad58bf4/scratchpad/prep/pr40-contract-gaps"
REPO="C:/Users/Sid/jarvis-pr33-tests"
LOG="$OUT/run337-gap$GAP.txt"
PROBE_SRC="$OUT/probes/pr40-probe-gap$GAP.test.ts"
PROBE_DST="$REPO/tests/acceptance/fake/pr40-probe-gap$GAP.test.ts"
cd "$REPO" || exit 90
if [ -n "$(git status --short)" ]; then echo "tree not clean before gap $GAP" | tee "$LOG"; git status --short; exit 91; fi
{
  echo "gap $GAP at $(git rev-parse --short HEAD), started $(date -Is)"
  node "$OUT/port337.mjs" "$GAP" || { echo "PORT FAILED"; exit 92; }
} > "$LOG" 2>&1 || { cat "$LOG"; git checkout -- .; exit 92; }
git diff > "$OUT/port337-gap$GAP.diff"
FILES=("$@")
if [ -f "$PROBE_SRC" ]; then
  cp "$PROBE_SRC" "$PROBE_DST"
  FILES+=("tests/acceptance/fake/pr40-probe-gap$GAP.test.ts")
  echo "probe: $PROBE_DST" >> "$LOG"
fi
echo "files: ${FILES[*]}" >> "$LOG"
timeout 1800 node node_modules/vitest/vitest.mjs --config vitest.workspace.ts run "${FILES[@]}" --reporter=verbose >> "$LOG" 2>&1
echo "VITEST EXIT $?" >> "$LOG"
git checkout -- .
rm -f "$PROBE_DST"
echo "restore status: [$(git status --short)]" >> "$LOG"
echo "finished $(date -Is)" >> "$LOG"
grep -E "^ +(✓|×|↓)|Test Files|Tests  |VITEST EXIT|restore status|Timed out|timed out" "$LOG" | grep -vE "^ +✓" | tail -60
