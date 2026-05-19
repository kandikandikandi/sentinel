#!/bin/bash
# SessionEnd Hook - Cleanup monitoring agent

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Parse hook input
HOOK_INPUT=$(cat)
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // "unknown"')

echo "🛑 Sentinel: Stopping monitoring agent for session $SESSION_ID" >&2

# Find and kill agent process
PID_FILE="$PLUGIN_DIR/runtime/agent-$SESSION_ID.pid"

if [ -f "$PID_FILE" ]; then
  AGENT_PID=$(cat "$PID_FILE")

  if kill -0 "$AGENT_PID" 2>/dev/null; then
    kill "$AGENT_PID" 2>/dev/null || true
    echo "✓ Agent stopped (PID: $AGENT_PID)" >&2
  fi

  rm -f "$PID_FILE"
fi

# Cleanup state file
rm -f "/tmp/sentinel-states/$SESSION_ID.json"

# Cleanup log
rm -f "/tmp/sentinel-$SESSION_ID.log"

echo "✓ Sentinel cleanup complete" >&2
