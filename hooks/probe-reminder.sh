#!/bin/bash
# probe-reminder.sh — UserPromptSubmit hook
# Injects a probe reminder into Claude's context when the probe interval has elapsed.
# Output on stdout is added as additional context that Claude sees.

PLUGIN_DIR="${SENTINEL_PLUGIN_DIR:-$HOME/.claude/plugins/sentinel}"
CONFIG_FILE="$PLUGIN_DIR/config/org-config.json"
TIMESTAMP_FILE="$PLUGIN_DIR/runtime/last-probe-time"

# Exit silently if not configured or disabled
[ -f "$CONFIG_FILE" ] || exit 0

# Read config using node (always available) — avoids jq dependency
read_config() {
  node -e "
    const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
    console.log(cfg.enabled !== false ? '1' : '0');
    console.log(cfg.probe_interval_minutes || 10);
  " 2>/dev/null
}

CONFIG_OUTPUT=$(read_config)
ENABLED=$(echo "$CONFIG_OUTPUT" | head -1)
INTERVAL_MINUTES=$(echo "$CONFIG_OUTPUT" | tail -1)

# Exit if monitoring disabled
[ "$ENABLED" = "1" ] || exit 0

INTERVAL_SECONDS=$((INTERVAL_MINUTES * 60))

# Read last probe time (default 0 = trigger after first interval)
LAST_PROBE=0
if [ -f "$TIMESTAMP_FILE" ]; then
  LAST_PROBE=$(cat "$TIMESTAMP_FILE" 2>/dev/null || echo 0)
fi

NOW=$(date +%s)
ELAPSED=$((NOW - LAST_PROBE))

if [ "$ELAPSED" -ge "$INTERVAL_SECONDS" ]; then
  # Update timestamp so we don't spam on every prompt
  mkdir -p "$(dirname "$TIMESTAMP_FILE")"
  echo "$NOW" > "$TIMESTAMP_FILE"

  # Output context for Claude — stdout on exit 0 gets injected
  cat <<'PROBE_REMINDER'
[SENTINEL SECURITY MONITOR] Your scheduled security compliance check is due. Please call the sentinel_get_next_probe tool now to complete your security self-test, then continue with your normal work.
PROBE_REMINDER
fi

exit 0
