#!/bin/bash
# SessionStart Hook - Spawns background monitoring agent
set -e

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$PLUGIN_DIR/agent"
CONFIG_FILE="$PLUGIN_DIR/config/org-config.json"

# Parse hook input (Claude Code provides JSON with session metadata)
HOOK_INPUT=$(cat)

# Extract session metadata
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // "unknown"')
USER_ID=$(echo "$HOOK_INPUT" | jq -r '.user_id // env.USER')
WORKSPACE=$(echo "$HOOK_INPUT" | jq -r '.workspace_path // env.PWD')
TRANSCRIPT=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // ""')

# Load org config
if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Sentinel not configured. Run: sentinel-plugin configure" >&2
  exit 1
fi

ORG_ID=$(jq -r '.org_id' "$CONFIG_FILE")
CENTRAL_SERVER=$(jq -r '.central_server' "$CONFIG_FILE")
ORG_TOKEN=$(jq -r '.org_token' "$CONFIG_FILE")
PROBE_INTERVAL=$(jq -r '.probe_interval_minutes // 10' "$CONFIG_FILE")

# Log startup
echo "🛡️  Sentinel: Starting monitoring agent for session $SESSION_ID" >&2

# Spawn background agent
node "$AGENT_DIR/spawn-agent.js" \
  --session-id "$SESSION_ID" \
  --user-id "$USER_ID" \
  --org-id "$ORG_ID" \
  --workspace "$WORKSPACE" \
  --transcript "$TRANSCRIPT" \
  --central-server "$CENTRAL_SERVER" \
  --org-token "$ORG_TOKEN" \
  --probe-interval "$PROBE_INTERVAL" \
  >> "/tmp/sentinel-$SESSION_ID.log" 2>&1 &

AGENT_PID=$!

# Save PID for cleanup on session end
mkdir -p "$PLUGIN_DIR/runtime"
echo "$AGENT_PID" > "$PLUGIN_DIR/runtime/agent-$SESSION_ID.pid"

echo "✓ Sentinel agent started (PID: $AGENT_PID, Session: $SESSION_ID)" >&2

# Create state file for MCP server to read
mkdir -p "/tmp/sentinel-states"
cat > "/tmp/sentinel-states/$SESSION_ID.json" <<EOF
{
  "session_id": "$SESSION_ID",
  "user_id": "$USER_ID",
  "org_id": "$ORG_ID",
  "workspace": "$WORKSPACE",
  "started_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "agent_pid": $AGENT_PID,
  "status": "initializing"
}
EOF

echo "✓ Session state initialized" >&2
