#!/bin/bash
# Sentinel Plugin Configure Script
# Connects this developer's laptop to a Sentinel server

set -e

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$PLUGIN_DIR/config"
CONFIG_FILE="$CONFIG_DIR/org-config.json"

echo ""
echo "🛡️  Sentinel Plugin Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Collect inputs ──────────────────────────────────────────────────────────

if [ -n "$SENTINEL_SERVER" ]; then
  SERVER_URL="$SENTINEL_SERVER"
else
  printf "  Server URL (e.g. https://sentinel.company.com): "
  read -r SERVER_URL
fi

# Strip trailing slash
SERVER_URL="${SERVER_URL%/}"

if [ -z "$SERVER_URL" ]; then
  echo "  ❌ Server URL is required." >&2
  exit 1
fi

if [ -n "$SENTINEL_TOKEN" ]; then
  ORG_TOKEN="$SENTINEL_TOKEN"
else
  printf "  API Token: "
  read -r -s ORG_TOKEN
  echo ""
fi

if [ -z "$ORG_TOKEN" ]; then
  echo "  ❌ API token is required." >&2
  exit 1
fi

# ── Validate the token against the server ───────────────────────────────────

echo ""
echo "  Validating token…"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $ORG_TOKEN" \
  "$SERVER_URL/api/stats" 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" = "200" ]; then
  echo "  ✓ Token validated successfully"
else
  # Check if the server itself is reachable
  HEALTH=$(curl -s --max-time 5 "$SERVER_URL/health" 2>/dev/null || echo "")
  if echo "$HEALTH" | grep -q '"status":"healthy"'; then
    echo "  ⚠️  Server reachable but token rejected (HTTP $HTTP_STATUS)."
    echo "     Check that the token is correct and hasn't been revoked."
    printf "  Continue anyway? [y/N] "
    read -r CONTINUE
    if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
      echo "  Aborted." >&2
      exit 1
    fi
  else
    echo "  ❌ Cannot reach server at: $SERVER_URL" >&2
    echo "     Ensure the Sentinel server is running and network-accessible." >&2
    exit 1
  fi
fi

# ── Write config ─────────────────────────────────────────────────────────────

mkdir -p "$CONFIG_DIR"

# Reuse existing org_id if present
EXISTING_ORG_ID=""
if [ -f "$CONFIG_FILE" ] && command -v jq &>/dev/null; then
  EXISTING_ORG_ID=$(jq -r '.org_id // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
fi

if [ -z "$EXISTING_ORG_ID" ]; then
  EXISTING_ORG_ID=$(node -e "console.log(require('crypto').randomUUID())" 2>/dev/null \
    || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null \
    || echo "local-$(date +%s)")
fi

cat > "$CONFIG_FILE" <<EOF
{
  "org_id": "$EXISTING_ORG_ID",
  "org_token": "$ORG_TOKEN",
  "central_server": "$SERVER_URL",
  "probe_interval_minutes": 10,
  "enabled": true,
  "log_level": "info",
  "local_backup": true
}
EOF

chmod 600 "$CONFIG_FILE"

# ── Initialize runtime state ─────────────────────────────────────────────────

mkdir -p "$PLUGIN_DIR/runtime"
if [ ! -f "$PLUGIN_DIR/runtime/last-probe-time" ]; then
  echo "0" > "$PLUGIN_DIR/runtime/last-probe-time"
fi

# ── Verify MCP registration ─────────────────────────────────────────────────

MCP_REGISTERED=$(node -e "
  try {
    const cfg = JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude.json', 'utf8'));
    console.log(cfg.mcpServers && cfg.mcpServers.sentinel ? 'yes' : 'no');
  } catch(e) { console.log('no'); }
" 2>/dev/null)

MCP_MSG=""
if [ "$MCP_REGISTERED" != "yes" ]; then
  MCP_MSG="  NOTE: MCP server not registered. Run scripts/install.sh for full setup."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Sentinel configured!"
echo ""
echo "  Server:  $SERVER_URL"
echo "  Config:  $CONFIG_FILE"
if [ -n "$MCP_MSG" ]; then
  echo ""
  echo "$MCP_MSG"
fi
echo ""
echo "  Start a Claude Code session to begin monitoring."
echo "  Findings appear in the dashboard at: $SERVER_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
