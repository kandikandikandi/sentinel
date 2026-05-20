#!/bin/bash
# drift-reminder.sh — UserPromptSubmit hook
# Periodically invites Claude to flag drift from user intent. Soft, opt-in, randomized cadence.
# Output on stdout is injected as additional context for Claude.
#
# State is per-workspace: the schedule file lives under
# ~/.sentinel/workspaces/<hash>/ so concurrent Claude Code sessions in different
# repos don't share a cadence. The workspace is taken from the hook payload's `cwd`.

PLUGIN_DIR="${SENTINEL_PLUGIN_DIR:-$HOME/.claude/plugins/sentinel}"
CONFIG_FILE="$PLUGIN_DIR/config/org-config.json"

[ -f "$CONFIG_FILE" ] || exit 0

# Claude Code passes a JSON payload on stdin (session_id, cwd, prompt, ...).
HOOK_INPUT=$(cat)

# One node call resolves: enabled flag, interval, and the per-workspace dir.
INFO=$(HOOK_INPUT="$HOOK_INPUT" FALLBACK_PWD="$PWD" node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path"), os = require("os");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
  let cwd = "";
  try { const i = JSON.parse(process.env.HOOK_INPUT || "{}"); if (i.cwd) cwd = i.cwd; } catch {}
  if (!cwd) cwd = process.env.CLAUDE_PROJECT_DIR || process.env.FALLBACK_PWD || process.cwd();
  try { cwd = fs.realpathSync(cwd); } catch {}
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  console.log(cfg.drift_signals_enabled !== false ? "1" : "0");
  console.log(cfg.drift_signal_interval_minutes || 30);
  console.log(path.join(os.homedir(), ".sentinel", "workspaces", hash));
' "$CONFIG_FILE" 2>/dev/null)

{ read -r ENABLED; read -r INTERVAL_MINUTES; read -r WORKSPACE_DIR; } <<< "$INFO"

[ "$ENABLED" = "1" ] || exit 0
[ -n "$WORKSPACE_DIR" ] || exit 0

NEXT_FIRE_FILE="$WORKSPACE_DIR/next-drift-time"

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
  mkdir -p "$WORKSPACE_DIR"
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
