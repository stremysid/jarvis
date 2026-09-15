#!/usr/bin/env bash
# PR #51 mutation pass at a25a5fd in jarvis-pr39. Waits for the gates run (task b0vxn16c3) to finish.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
GATES="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/tasks/b0vxn16c3.output"
R="C:/Users/Sid/jarvis-pr39"
until grep -q '^timeouts:' "$GATES" 2>/dev/null; do sleep 20; done
sleep 20
echo "gates finished $(date -u +%H:%M); tree clean=$([ -z "$(git -C $R status --porcelain)" ] && echo yes || echo NO)"
git -C "$R" checkout --detach a25a5fd >/dev/null 2>&1
echo "== anchor counts (only mismatches listed)"
node -e '
const fs = require("fs");
const spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const m of spec.mutations) {
  const raw = fs.readFileSync(`${spec.root}/${m.file}`, "utf8").replace(/\r\n/g, "\n");
  const n = raw.split(m.from).length - 1;
  if (n !== 1) console.log(`  ${m.id}: ${n}`);
}
' "$ME/pr51/mut51.json"
cd "$ME/tools" && node mutrun.mjs "$ME/pr51/mut51.json" > "$ME/pr51/run51mut.txt" 2>&1
sed -n '/=== summary/,$p' "$ME/pr51/run51mut.txt" | grep -v DEP0190 | grep -v trace-deprecation; echo "timeouts: $(grep -a -ci 'timed out' "$ME/pr51/run51mut.txt")"
awk '/^== /{if(id!="")print id" | "n" failed | "b; id=$2; n=0; b=""} /^ +× /{n++; b=b"["substr($0,index($0,"×")+2,60)"] "} END{print id" | "n" failed | "b}' "$ME/pr51/run51mut.txt"
grep -a -E "MATCHED|no test summary" "$ME/pr51/run51mut.txt" | head
git -C "$R" status --short | head -3
echo "done $(date -u +%H:%M)"
