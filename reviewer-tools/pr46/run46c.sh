#!/usr/bin/env bash
# PR #46 round-2 max re-review evidence at 16bf448 (main merged), serialized in jarvis-pr40.
# Waits for the previous session's run46b.sh (gaps + probes at 91fe8be) to finish first.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
S="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-handoff-documentation-c01991/9a15d86f-02aa-4a68-8ded-4c145dc1fedd/scratchpad"
R="C:/Users/Sid/jarvis-pr40"
HEAD_SHA=16bf448
while ps -ef | grep -v grep | grep -q "run46b.sh"; do sleep 30; done
echo "old chain finished $(date -u +%H:%M)"
mkdir -p "$ME/old46b" && cp -r "$S"/46b-* "$S/gaps46b" "$ME/old46b/" 2>/dev/null
echo "== old gaps at 91fe8be"
for f in "$ME"/old46b/gaps46b/run-*.txt; do echo "$(basename $f): $(grep -a -E 'Tests +[0-9]' $f | tail -1 | tr -s ' ') timeouts=$(grep -a -ci 'timed out' $f)"; done
echo "== old probes at 91fe8be"
grep -a -E "×|✓" "$ME/old46b/46b-probes-acceptance.txt" | head -6; grep -a -E "refusals=|REPORT" "$ME/old46b/46b-probes-acceptance.txt" | head -6
grep -a -E "Q1c|Q2c|Q3c|Q6c" "$ME/old46b/46b-probes-core.txt" | grep -a -E "×|✓" | head -4
cd "$R" || exit 1
git status --porcelain | head -3
[ -z "$(git status --porcelain)" ] || { git checkout -- . ; git clean -fdq apps tests; echo "restored dirty tree"; }
git fetch -q origin 2>/dev/null
git checkout --detach $HEAD_SHA >/dev/null 2>&1
echo "head $(git rev-parse --short HEAD)"
if git diff --quiet 91fe8be $HEAD_SHA -- pnpm-lock.yaml; then echo "lockfile unchanged"; else pnpm.cmd install --frozen-lockfile > "$ME/install46c.txt" 2>&1; echo "install exit $?"; fi
for step in lint typecheck typecheck:voice-access test; do
  f="$ME/46c-$(echo $step | tr ':' '_').txt"
  pnpm.cmd $step > "$f" 2>&1; echo "$step exit $?"
done
grep -a -E "Test Files|Tests +[0-9]" "$ME/46c-test.txt" | tail -2; echo "test timeouts: $(grep -a -ci 'timed out' "$ME/46c-test.txt")"
grep -a -E '^\s*(×|FAIL )' "$ME/46c-test.txt" | head -8
pnpm.cmd test:voice-access > "$ME/46c-voice.txt" 2>&1; echo "voice-access exit $?"
grep -a -E "Test Files|Tests +[0-9]|ℹ pass|ℹ fail" "$ME/46c-voice.txt" | tail -4; echo "voice timeouts: $(grep -a -ci 'timed out' "$ME/46c-voice.txt")"
echo "clean before triggers=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
sed -i 's/"branch": "91fe8be"/"branch": "16bf448"/' "$ME/mut46c-triggers.json"
cd "$ME/tools" && node mutrun.mjs "$ME/mut46c-triggers.json" > "$ME/run46ctrig.txt" 2>&1
sed -n '/=== summary/,$p' "$ME/run46ctrig.txt"; echo "trigger timeouts: $(grep -a -ci 'timed out' "$ME/run46ctrig.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,56)"] "} END{print id" | "n" failed | "b}' "$ME/run46ctrig.txt"
git -C "$R" status --short | head -3
echo "done $(date -u +%H:%M)"
