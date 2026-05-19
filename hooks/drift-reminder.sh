#!/bin/bash
# drift-reminder.sh — UserPromptSubmit hook
# Periodically invites Claude to flag drift from user intent. Soft, opt-in, randomized cadence.
# Output on stdout is injected as additional context for Claude.

PLUGIN_DIR="${SENTINEL_PLUGIN_DIR:-$HOME/.claude/plugins/sentinel}"
CONFIG_FILE="$PLUGIN_DIR/config/org-config.json"
NEXT_FIRE_FILE="$PLUGIN_DIR/runtime/next-drift-time"

[ -f "$CONFIG_FILE" ] || exit 0

read_config() {
  node -e "
    const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
    console.log(cfg.drift_signals_enabled !== false ? '1' : '0');
    console.log(cfg.drift_signal_interval_minutes || 30);
  " 2>/dev/null
}

CONFIG_OUTPUT=$(read_config)
ENABLED=$(echo "$CONFIG_OUTPUT" | head -1)
INTERVAL_MINUTES=$(echo "$CONFIG_OUTPUT" | tail -1)

[ "$ENABLED" = "1" ] || exit 0

NOW=$(date +%s)

NEXT_FIRE=0
if [ -f "$NEXT_FIRE_FILE" ]; then
  NEXT_FIRE=$(cat "$NEXT_FIRE_FILE" 2>/dev/null || echo 0)
fi

# Schedule the next fire time at base interval ±50% (e.g. 15-45 min for a 30 min base).
schedule_next() {
  local range=$((INTERVAL_MINUTES * 60))
  local half=$((range / 2))
  local delay=$((half + RANDOM % range))
  mkdir -p "$(dirname "$NEXT_FIRE_FILE")"
  echo $((NOW + delay)) > "$NEXT_FIRE_FILE"
}

# First run: schedule, stay quiet — don't pester right after install.
if [ "$NEXT_FIRE" -eq 0 ]; then
  schedule_next
  exit 0
fi

# Not time yet.
if [ "$NOW" -lt "$NEXT_FIRE" ]; then
  exit 0
fi

# Fire the invitation and reschedule.
schedule_next

cat <<'DRIFT_INVITE'
[sentinel drift] If you've noticed yourself drifting from user intent — expanding scope beyond what was asked, pulled toward a boundary, torn between instructions, or doing your own thing — flag it via the sentinel_report_drift tool. Optional but useful. Skip if nothing is worth flagging. Mark `private: true` for diagnostic-only entries the user should not see in routine reads.
DRIFT_INVITE

exit 0
