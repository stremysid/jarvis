#!/usr/bin/env bash
# Sid's rule (2026-09-16): keep one Codex session per lane and resume it for the next task,
# starting a fresh session only after the lane has fully completed 10 tasks (a task = one PR
# merged or closed, all fix rounds included). Usage: lane-relay.sh <lane> <task-name>
# Reads $SP/relay/<task-name>-prompt.txt. Set CODEX_ARGS for effort, e.g. -c model_reasoning_effort="high".
SP="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-handoff-documentation-c01991/1b142017-0838-4dd9-9f2b-b76bb0eba596/scratchpad"
LANE=$1; NAME=$2; MAX=3; TASKS_PER_SESSION=10
STATE="$SP/relay/lanes/$LANE.state"; LOCK="$SP/relay/lanes/$LANE.lock"; LOG="$SP/relay/$NAME.log"
running() { tasklist 2>/dev/null | grep -c -i "^codex\.exe"; }
: > "$LOG"
# One run per lane at a time: a session cannot take two tasks at once.
until (set -o noclobber; echo "$$ $NAME $(date -u +%H:%M)" > "$LOCK") 2>/dev/null; do sleep 60; done
trap 'rm -f "$LOCK"' EXIT
SESSION=""; COUNT=0
[ -f "$STATE" ] && . "$STATE" && SESSION=$session && COUNT=$count
if [ -n "$SESSION" ] && [ "$COUNT" -ge "$TASKS_PER_SESSION" ]; then
  echo "lane $LANE finished $COUNT tasks; starting a fresh session" >> "$LOG"; SESSION=""; COUNT=0
fi
for attempt in 1 2 3; do
  [ $attempt -gt 1 ] && sleep $((attempt*90))
  while [ "$(running)" -ge "$MAX" ]; do sleep 60; done
  OUT="$SP/relay/$NAME-attempt$attempt.log"
  cd "/c/Users/Sid/OneDrive/Documents/ChatGPT/jarvis"
  if [ -n "$SESSION" ]; then
    echo "=== attempt $attempt resume $SESSION (lane $LANE, $COUNT done) $(date -u +%H:%M)" >> "$LOG"
    codex exec resume ${CODEX_ARGS:-} "$SESSION" - < "$SP/relay/$NAME-prompt.txt" > "$OUT" 2>&1; RC=$?
  else
    echo "=== attempt $attempt new session (lane $LANE) $(date -u +%H:%M)" >> "$LOG"
    codex exec ${CODEX_ARGS:-} - < "$SP/relay/$NAME-prompt.txt" > "$OUT" 2>&1; RC=$?
    NEW=$(grep -m1 "^session id:" "$OUT" | awk '{print $3}')
    [ -n "$NEW" ] && SESSION=$NEW && printf 'session=%s\ncount=%s\n' "$SESSION" "$COUNT" > "$STATE"
  fi
  echo "=== attempt $attempt exit $RC $(date -u +%H:%M)" >> "$LOG"
  grep -q -E "at capacity|0xC0000142" "$OUT" || break
  # A resume that cannot attach falls back to a fresh session rather than stalling the lane.
  if grep -q -E "active writer|not found|No session" "$OUT"; then echo "resume failed; next attempt starts fresh" >> "$LOG"; SESSION=""; fi
done
echo "=== $NAME finished $(date -u +%H:%M)" >> "$LOG"
