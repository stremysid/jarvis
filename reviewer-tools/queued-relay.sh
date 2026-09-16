#!/usr/bin/env bash
# Launch builder prompts one at a time, never letting more than MAX codex sessions run at once.
# Four concurrent sessions made Windows refuse process creation with 0xC0000142 and killed two
# builders mid-run on 2026-09-16, so this serializes the queue behind the running ones.
ME="${RELAY_SCRATCH:?set RELAY_SCRATCH to your session scratchpad}"
MAX=3   # the desktop Codex app-server is always one of these, so this allows two real builders
running() { tasklist 2>/dev/null | grep -c -i "^codex\.exe"; }
for name in "$@"; do
  waited=0
  while [ "$(running)" -ge "$MAX" ] && [ "$waited" -lt 7200 ]; do sleep 60; waited=$((waited+60)); done
  : > "$ME/relay/$name.log"
  # A single-instance lock: never let two runs of the same prompt share a worktree.
  LOCK="$ME/relay/$name.lock"
  if ! (set -o noclobber; echo "$$ $(date -u +%H:%M)" > "$LOCK") 2>/dev/null; then
    echo "$name already running (lock $LOCK), skipping" >> "$ME/relay/$name.log"; continue
  fi
  trap 'rm -f "$LOCK"' EXIT
  for attempt in 1 2 3; do
    [ $attempt -gt 1 ] && sleep $((attempt*90))
    # Re-check the cap before every attempt, not just the first.
    while [ "$(running)" -ge "$MAX" ]; do sleep 60; done
    echo "=== attempt $attempt start $(date -u +%H:%M) (codex running: $(running))" >> "$ME/relay/$name.log"
    (cd "/c/Users/Sid/OneDrive/Documents/ChatGPT/jarvis" && codex exec ${CODEX_ARGS:-} - < "$ME/relay/$name-prompt.txt") > "$ME/relay/$name-attempt$attempt.log" 2>&1
    echo "=== attempt $attempt exit $? at $(date -u +%H:%M)" >> "$ME/relay/$name.log"
    grep -q -E "at capacity|0xC0000142" "$ME/relay/$name-attempt$attempt.log" || break
  done
  echo "=== $name finished $(date -u +%H:%M)" >> "$ME/relay/$name.log"
  rm -f "$LOCK"; trap - EXIT
done
echo "queue done $(date -u +%H:%M)"
