#!/bin/bash
# Sentinel Plugin Setup Script

set -e

echo "🛡️  Sentinel Plugin Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Make hooks executable
chmod +x "$PLUGIN_DIR/hooks/"*.sh
chmod +x "$PLUGIN_DIR/agent/spawn-agent.js"
chmod +x "$PLUGIN_DIR/mcp/server.js"

echo "✓ Made scripts executable"

# Create config directory
mkdir -p "$PLUGIN_DIR/config"
mkdir -p "$PLUGIN_DIR/runtime"

# Create .gitignore
cat > "$PLUGIN_DIR/.gitignore" <<EOF
# Runtime files
runtime/
*.pid
*.log

# Config (contains secrets)
config/org-config.json

# Dependencies
node_modules/

# OS
.DS_Store
EOF

echo "✓ Created directories"

# Check if already configured
if [ -f "$PLUGIN_DIR/config/org-config.json" ]; then
  echo "✓ Already configured"
  echo ""
  echo "To reconfigure, run: bash scripts/configure.sh"
else
  echo ""
  echo "⚠️  Configuration needed!"
  echo ""
  echo "Next steps:"
  echo "1. Get your organization credentials from Sentinel admin"
  echo "2. Run: bash scripts/configure.sh"
  echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ Setup complete"
