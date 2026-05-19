#!/bin/bash
# install.sh — One-shot Sentinel plugin installer for developer laptops
# Usage:
#   bash install.sh
#   SENTINEL_SERVER=https://sentinel.company.com SENTINEL_TOKEN=tok bash install.sh
set -e

INSTALL_DIR="$HOME/.claude/plugins/sentinel"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "=============================================="
echo "  Sentinel Security Monitor — Installer"
echo "=============================================="
echo ""

# ── 1. Check prerequisites ──────────────────────────────────────────────────

echo "Checking prerequisites..."

# Node.js >= 18
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

# npm
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

# Copy directories
for dir in agent hooks mcp scripts config; do
  if [ -d "$SCRIPT_DIR/$dir" ]; then
    mkdir -p "$INSTALL_DIR/$dir"
    cp -r "$SCRIPT_DIR/$dir/"* "$INSTALL_DIR/$dir/" 2>/dev/null || true
  fi
done

# Copy root files
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

# Restore preserved config
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

# ── 4. Make scripts executable ───────────────────────────────────────────────

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

const hookCmd = home + '/.claude/plugins/sentinel/hooks/probe-reminder.sh';

// Check if already registered
const hasProbe = cfg.hooks.UserPromptSubmit.some(
  g => g.hooks && g.hooks.some(h => h.command && h.command.includes('probe-reminder'))
);

if (!hasProbe) {
  cfg.hooks.UserPromptSubmit.push({
    hooks: [{
      type: 'command',
      command: hookCmd,
      timeout: 5000
    }]
  });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log('  Probe reminder hook registered');
} else {
  console.log('  Probe reminder hook already registered');
}
"

# ── 7. Initialize runtime state ─────────────────────────────────────────────

mkdir -p "$INSTALL_DIR/runtime"
echo "0" > "$INSTALL_DIR/runtime/last-probe-time"

# ── 8. Configure server connection ──────────────────────────────────────────

echo ""

if [ -n "$SENTINEL_SERVER" ] && [ -n "$SENTINEL_TOKEN" ]; then
  # Non-interactive mode
  SENTINEL_SERVER="$SENTINEL_SERVER" SENTINEL_TOKEN="$SENTINEL_TOKEN" \
    bash "$INSTALL_DIR/scripts/configure.sh"
elif [ ! -f "$INSTALL_DIR/config/org-config.json" ] || ! node -e "
  const cfg = JSON.parse(require('fs').readFileSync('$INSTALL_DIR/config/org-config.json', 'utf8'));
  process.exit(cfg.org_token ? 0 : 1);
" 2>/dev/null; then
  # No existing config — run interactive configure
  bash "$INSTALL_DIR/scripts/configure.sh"
else
  echo "  Server already configured (use scripts/configure.sh to reconfigure)"
fi

# ── 9. Verify installation ──────────────────────────────────────────────────

echo ""
echo "=============================================="
echo "  Installation Complete"
echo "=============================================="
echo ""
echo "  Plugin:     $INSTALL_DIR"
echo "  MCP Server: sentinel_get_next_probe tool registered"
echo "  Hook:       Probe reminders on every prompt"
echo ""
echo "  Start a new Claude Code session to begin monitoring."
echo "  Probes will fire automatically based on your configured interval."
echo ""
echo "  Dashboard: Check with your admin for the server URL"
echo "=============================================="
echo ""
