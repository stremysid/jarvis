#!/usr/bin/env bash
# PR #49 fix-round mutation pass at f5292c7 in jarvis-pr39. Waits for the gates+probes run to finish.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
R="C:/Users/Sid/jarvis-pr39"
until [ -s "$ME/pr49/probe49b-strict.txt" ] && ! ls "$R"/apps/cloud-gateway/test/deadlines/zz-reviewer-* >/dev/null 2>&1; do sleep 20; done
sleep 30
echo "gates+probes finished $(date -u +%H:%M); tree clean=$([ -z "$(git -C $R status --porcelain)" ] && echo yes || echo NO)"
cd "$ME/tools" && node mutrun.mjs "$ME/pr49/mut49b.json" > "$ME/pr49/run49bmut.txt" 2>&1
sed -n '/=== summary/,$p' "$ME/pr49/run49bmut.txt" | grep -v DEP0190 | grep -v trace-deprecation; echo "timeouts: $(grep -a -ci 'timed out' "$ME/pr49/run49bmut.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,60)"] "} END{print id" | "n" failed | "b}' "$ME/pr49/run49bmut.txt"
grep -a -E "MATCHED|no test summary" "$ME/pr49/run49bmut.txt" | head
git -C "$R" status --short | head -3
echo "done $(date -u +%H:%M)"
