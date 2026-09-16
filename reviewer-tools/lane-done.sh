#!/usr/bin/env bash
# Record one fully completed task (PR merged or closed) for a lane. Usage: lane-done.sh <lane>
SP="C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-handoff-documentation-c01991/1b142017-0838-4dd9-9f2b-b76bb0eba596/scratchpad"
STATE="$SP/relay/lanes/$1.state"; . "$STATE"; printf 'session=%s\ncount=%s\n' "$session" "$((count+1))" > "$STATE"; cat "$STATE"
