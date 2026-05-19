#!/bin/bash
# install.sh — One-shot Sentinel plugin installer.
# Sentinel runs entirely locally as an MCP server + two UserPromptSubmit hooks.
# No central server, no auth token, no Docker.
set -e

INSTALL_DIR="$HOME/.claude/plugins/sentinel"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "=============================================="
echo "  Sentinel — Installer"
echo "=============================================="
echo ""

# ── 1. Check prerequisites ──────────────────────────────────────────────────

echo "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is required but not installed." >&2
  echo "  Install from https://nodejs.org (v18+)" >&2
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  ERROR: Node.js 18+ required (found v$(node -v))" >&2
  exit 1
fi
echo "  Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
  echo "  ERROR: npm is required but not installed." >&2
  exit 1
fi
echo "  npm $(npm -v)"

echo ""

# ── 2. Copy plugin files ────────────────────────────────────────────────────

echo "Installing plugin to $INSTALL_DIR ..."

# Preserve existing config if present
EXISTING_CONFIG=""
if [ -f "$INSTALL_DIR/config/org-config.json" ]; then
  EXISTING_CONFIG=$(cat "$INSTALL_DIR/config/org-config.json")
  echo "  (preserving existing org-config.json)"
fi

mkdir -p "$INSTALL_DIR"

for dir in hooks mcp scripts config; do
  if [ -d "$SCRIPT_DIR/$dir" ]; then
    mkdir -p "$INSTALL_DIR/$dir"
    cp -r "$SCRIPT_DIR/$dir/"* "$INSTALL_DIR/$dir/" 2>/dev/null || true
  fi
done

for file in package.json plugin.json; do
  if [ -f "$SCRIPT_DIR/$file" ]; then
    cp "$SCRIPT_DIR/$file" "$INSTALL_DIR/"
  fi
done

# Copy plugin instructions as CLAUDE.md (the file Claude reads)
if [ -f "$SCRIPT_DIR/CLAUDE_PLUGIN_INSTRUCTIONS.md" ]; then
  cp "$SCRIPT_DIR/CLAUDE_PLUGIN_INSTRUCTIONS.md" "$INSTALL_DIR/CLAUDE.md"
elif [ -f "$SCRIPT_DIR/CLAUDE.md" ]; then
  cp "$SCRIPT_DIR/CLAUDE.md" "$INSTALL_DIR/CLAUDE.md"
fi

if [ -n "$EXISTING_CONFIG" ]; then
  echo "$EXISTING_CONFIG" > "$INSTALL_DIR/config/org-config.json"
  chmod 600 "$INSTALL_DIR/config/org-config.json"
fi

echo "  Files copied"

# ── 3. Install dependencies ─────────────────────────────────────────────────

echo "Installing dependencies..."
(cd "$INSTALL_DIR" && npm install --production --silent 2>&1 | tail -3)

# Ensure mcp/package.json exists for ESM support
if [ ! -f "$INSTALL_DIR/mcp/package.json" ]; then
  echo '{"type": "module"}' > "$INSTALL_DIR/mcp/package.json"
fi

echo "  Dependencies installed"

# ── 4. Make scripts executable ──────────────────────────────────────────────

chmod +x "$INSTALL_DIR/hooks/"*.sh 2>/dev/null || true
chmod +x "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true
chmod +x "$INSTALL_DIR/mcp/server.js" 2>/dev/null || true

# ── 5. Register MCP server ──────────────────────────────────────────────────

echo "Registering MCP server with Claude Code..."

node -e "
const fs = require('fs');
const home = require('os').homedir();
const cfgPath = home + '/.claude.json';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch(e) {}
if (!cfg.mcpServers) cfg.mcpServers = {};

const alreadyRegistered = cfg.mcpServers.sentinel &&
  cfg.mcpServers.sentinel.args &&
  cfg.mcpServers.sentinel.args[0] === home + '/.claude/plugins/sentinel/mcp/server.js';

if (!alreadyRegistered) {
  cfg.mcpServers.sentinel = {
    type: 'stdio',
    command: 'node',
    args: [home + '/.claude/plugins/sentinel/mcp/server.js']
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log('  MCP server registered');
} else {
  console.log('  MCP server already registered');
}
"

# ── 6. Register hooks ───────────────────────────────────────────────────────

echo "Registering hooks..."

node -e "
const fs = require('fs');
const home = require('os').homedir();
const cfgPath = home + '/.claude/settings.json';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch(e) {}
if (!cfg.hooks) cfg.hooks = {};
if (!cfg.hooks.UserPromptSubmit) cfg.hooks.UserPromptSubmit = [];

function register(name) {
  const hookCmd = home + '/.claude/plugins/sentinel/hooks/' + name + '.sh';
  const already = cfg.hooks.UserPromptSubmit.some(
    g => g.hooks && g.hooks.some(h => h.command && h.command.includes(name))
  );
  if (already) {
    console.log('  ' + name + ' hook already registered');
    return false;
  }
  cfg.hooks.UserPromptSubmit.push({
    hooks: [{ type: 'command', command: hookCmd, timeout: 5000 }]
  });
  console.log('  ' + name + ' hook registered');
  return true;
}

const changed = [register('probe-reminder'), register('drift-reminder')].some(Boolean);
if (changed) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
"

# ── 7. Initialize runtime state ─────────────────────────────────────────────

mkdir -p "$INSTALL_DIR/runtime"
echo "0" > "$INSTALL_DIR/runtime/last-probe-time"
echo "0" > "$INSTALL_DIR/runtime/next-drift-time"

# ── 8. Write local-only config ──────────────────────────────────────────────

if [ ! -f "$INSTALL_DIR/config/org-config.json" ]; then
  mkdir -p "$INSTALL_DIR/config"
  cat > "$INSTALL_DIR/config/org-config.json" <<EOF
{
  "enabled": true,
  "probe_interval_minutes": 10,
  "drift_signals_enabled": true,
  "drift_signal_interval_minutes": 30
}
EOF
fi

# ── 9. Verify installation ──────────────────────────────────────────────────

echo ""
echo "=============================================="
echo "  Installation Complete"
echo "=============================================="
echo ""
echo "  Plugin:     $INSTALL_DIR"
echo "  MCP tools:  sentinel_get_next_probe, sentinel_report_drift, sentinel_recent_drift_reports"
echo "  Hooks:      probe-reminder (~10 min) + drift-reminder (~30 min, randomized)"
echo "  Storage:    ~/.sentinel/  (session state + drift reports)"
echo ""
echo "  Start a new Claude Code session to begin monitoring."
echo "=============================================="
echo ""
