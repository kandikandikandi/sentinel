#!/bin/bash
# Sentinel Plugin Configure Script
# Connects this developer's laptop to a Sentinel server, or sets up local-only mode.
#
# Usage:
#   bash configure.sh                  (interactive: prompts for server + token)
#   bash configure.sh --local-only     (no central server, local-only storage)
#   SENTINEL_SERVER=... SENTINEL_TOKEN=... bash configure.sh   (non-interactive)
#   SENTINEL_LOCAL_ONLY=1 bash configure.sh                    (env-var equivalent)

set -e

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$PLUGIN_DIR/config"
CONFIG_FILE="$CONFIG_DIR/org-config.json"

# ── Parse args ──────────────────────────────────────────────────────────────

LOCAL_ONLY="${SENTINEL_LOCAL_ONLY:-0}"
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=1 ;;
  esac
done

echo ""
echo "🛡️  Sentinel Plugin Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$LOCAL_ONLY" = "1" ]; then
  # ── Local-only mode: skip server prompt + validation ────────────────────
  SERVER_URL="http://localhost:9999"
  ORG_TOKEN="sentinel_local_only"
  echo "  Local-only mode: skipping central server setup."
  echo "  Findings will save to ~/.sentinel/backups/; drift reports to ~/.sentinel/drift_reports.jsonl."
else
  # ── Collect server URL ──────────────────────────────────────────────────
  if [ -n "$SENTINEL_SERVER" ]; then
    SERVER_URL="$SENTINEL_SERVER"
  else
    printf "  Server URL (e.g. https://sentinel.company.com): "
    read -r SERVER_URL
  fi
  SERVER_URL="${SERVER_URL%/}"
  if [ -z "$SERVER_URL" ]; then
    echo "  ❌ Server URL is required (or pass --local-only to skip)." >&2
    exit 1
  fi

  # ── Collect token ───────────────────────────────────────────────────────
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

  # ── Validate token against server ───────────────────────────────────────
  echo ""
  echo "  Validating token…"

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $ORG_TOKEN" \
    "$SERVER_URL/api/stats" 2>/dev/null || echo "000")

  if [ "$HTTP_STATUS" = "200" ]; then
    echo "  ✓ Token validated successfully"
  else
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
      echo "     Ensure the Sentinel server is running and network-accessible," >&2
      echo "     or pass --local-only to skip server setup." >&2
      exit 1
    fi
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
  "drift_signals_enabled": true,
  "drift_signal_interval_minutes": 30,
  "enabled": true,
  "log_level": "info",
  "local_backup": true
}
EOF

chmod 600 "$CONFIG_FILE"

# ── Initialize runtime state ─────────────────────────────────────────────────

mkdir -p "$PLUGIN_DIR/runtime"
[ -f "$PLUGIN_DIR/runtime/last-probe-time" ] || echo "0" > "$PLUGIN_DIR/runtime/last-probe-time"
[ -f "$PLUGIN_DIR/runtime/next-drift-time" ] || echo "0" > "$PLUGIN_DIR/runtime/next-drift-time"

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
if [ "$LOCAL_ONLY" = "1" ]; then
  echo "  Mode:    local-only (no central server)"
  echo "  Config:  $CONFIG_FILE"
  echo "  Storage: ~/.sentinel/  (findings backup + drift reports)"
else
  echo "  Server:  $SERVER_URL"
  echo "  Config:  $CONFIG_FILE"
fi
if [ -n "$MCP_MSG" ]; then
  echo ""
  echo "$MCP_MSG"
fi
echo ""
echo "  Start a Claude Code session to begin monitoring."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
