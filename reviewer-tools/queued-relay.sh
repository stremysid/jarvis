#!/usr/bin/env bash
# Launch builder prompts one at a time, never letting more than MAX codex sessions run at once.
# Four concurrent sessions made Windows refuse process creation with 0xC0000142 and killed two
# builders mid-run on 2026-09-16, so this serializes the queue behind the running ones.
ME="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/491bafd5-6943-47ba-ac70-7a2ebe575839/scratchpad"
MAX=2
running() { tasklist 2>/dev/null | grep -c -i "^codex\.exe"; }
for name in "$@"; do
  waited=0
  while [ "$(running)" -ge "$MAX" ] && [ "$waited" -lt 7200 ]; do sleep 60; waited=$((waited+60)); done
  : > "$ME/relay/$name.log"
  for attempt in 1 2 3; do
    [ $attempt -gt 1 ] && sleep $((attempt*90))
    echo "=== attempt $attempt start $(date -u +%H:%M) (codex running: $(running))" >> "$ME/relay/$name.log"
    (cd "/c/Users/Sid/OneDrive/Documents/ChatGPT/jarvis" && codex exec - < "$ME/relay/$name-prompt.txt") > "$ME/relay/$name-attempt$attempt.log" 2>&1
    echo "=== attempt $attempt exit $? at $(date -u +%H:%M)" >> "$ME/relay/$name.log"
    grep -q -E "at capacity|0xC0000142" "$ME/relay/$name-attempt$attempt.log" || break
  done
  echo "=== $name finished $(date -u +%H:%M)" >> "$ME/relay/$name.log"
done
echo "queue done $(date -u +%H:%M)"
