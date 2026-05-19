#!/bin/bash
# Post-install setup. Idempotent.
set -e

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

chmod +x "$PLUGIN_DIR/hooks/"*.sh 2>/dev/null || true
chmod +x "$PLUGIN_DIR/mcp/server.js" 2>/dev/null || true

mkdir -p "$PLUGIN_DIR/config"
mkdir -p "$PLUGIN_DIR/runtime"

if [ ! -f "$PLUGIN_DIR/.gitignore" ]; then
  cat > "$PLUGIN_DIR/.gitignore" <<'EOF'
runtime/
*.pid
*.log
config/org-config.json
node_modules/
.DS_Store
EOF
fi

echo "Sentinel setup complete."
