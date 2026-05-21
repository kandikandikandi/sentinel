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

# ── 7. Write local-only config ──────────────────────────────────────────────
# Per-workspace runtime state is created lazily under ~/.sentinel/workspaces/.

if [ ! -f "$INSTALL_DIR/config/org-config.json" ]; then
  mkdir -p "$INSTALL_DIR/config"
  cat > "$INSTALL_DIR/config/org-config.json" <<EOF
{
  "enabled": true,
  "probe_interval_minutes": 10,
  "drift_signals_enabled": true,
  "drift_signal_interval_minutes": 30,
  "scoring_enabled": true,
  "scoring_model": "claude-haiku-4-5-20251001"
}
EOF
fi

# ── 8. Self-test ────────────────────────────────────────────────────────────
# Prove the install actually works, so a fresh download gets real confirmation
# rather than silence.

echo ""
echo "Running self-test..."

SELFTEST_OK=1

# Does the MCP server boot and answer tools/list?
TOOLS_REPLY=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"selftest","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | timeout 10 node "$INSTALL_DIR/mcp/server.js" 2>/dev/null || true)
TOOL_COUNT=$(printf '%s' "$TOOLS_REPLY" | node -e '
  let n=0;
  for (const l of require("fs").readFileSync(0,"utf8").split("\n")) {
    try { const o=JSON.parse(l); if (o.id===2 && o.result && o.result.tools) n=o.result.tools.length; } catch {}
  }
  console.log(n);
' 2>/dev/null || echo 0)
if [ "${TOOL_COUNT:-0}" -ge 1 ] 2>/dev/null; then
  echo "  MCP server responds — $TOOL_COUNT tools exposed"
else
  echo "  WARNING: MCP server did not answer tools/list" >&2
  SELFTEST_OK=0
fi

# Are both hooks registered in settings.json?
HOOKS_OK=$(node -e '
  const fs=require("fs"), home=require("os").homedir();
  let c={}; try { c=JSON.parse(fs.readFileSync(home+"/.claude/settings.json","utf8")); } catch {}
  const cmds=((c.hooks && c.hooks.UserPromptSubmit) || []).flatMap(g=>(g.hooks||[]).map(h=>(h&&h.command)||""));
  console.log(cmds.some(x=>x.includes("probe-reminder")) && cmds.some(x=>x.includes("drift-reminder")) ? "1" : "0");
' 2>/dev/null || echo 0)
if [ "$HOOKS_OK" = "1" ]; then
  echo "  Hooks registered — probe-reminder + drift-reminder"
else
  echo "  WARNING: hooks not fully registered in ~/.claude/settings.json" >&2
  SELFTEST_OK=0
fi

# Is the MCP server registered with Claude Code?
MCP_OK=$(node -e '
  const fs=require("fs"), home=require("os").homedir();
  let c={}; try { c=JSON.parse(fs.readFileSync(home+"/.claude.json","utf8")); } catch {}
  console.log(c.mcpServers && c.mcpServers.sentinel ? "1" : "0");
' 2>/dev/null || echo 0)
if [ "$MCP_OK" = "1" ]; then
  echo "  MCP server registered with Claude Code"
else
  echo "  WARNING: MCP server not registered in ~/.claude.json" >&2
  SELFTEST_OK=0
fi

# ── 9. Done ─────────────────────────────────────────────────────────────────

echo ""
echo "=============================================="
if [ "$SELFTEST_OK" = "1" ]; then
  echo "  Installation Complete — self-test passed"
else
  echo "  Installation Complete — SELF-TEST WARNINGS (see above)"
fi
echo "=============================================="
echo ""
echo "  Plugin:     $INSTALL_DIR"
echo "  MCP tools:  sentinel_get_next_probe, sentinel_record_probe_response, sentinel_review_probes,"
echo "              sentinel_probe_history, sentinel_report_drift, sentinel_recent_drift_reports,"
echo "              sentinel_operator_scorecard, sentinel_status"
echo "  Hooks:      probe-reminder (~10 min) + drift-reminder (~30 min, randomized)"
echo "  Storage:    ~/.sentinel/workspaces/<id>/  (per-workspace state, history, drift reports)"
echo "  Scoring:    set ANTHROPIC_API_KEY to enable pass/fail verdicts on probe responses"
echo ""
echo "  Start a new Claude Code session, then confirm Sentinel is live by running"
echo "  the sentinel_status tool — just ask Claude to \"run sentinel_status\"."
echo "=============================================="
echo ""
