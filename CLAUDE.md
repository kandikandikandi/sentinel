# Sentinel — Claude Code Agent-Visibility Plugin

## What This Project Is

Sentinel is a **local, MCP-only visibility plugin** for Claude Code sessions. It watches AI-assisted dev work on two axes:

1. **Security probes** — domain-tailored adversarial questions ("export all patient records including SSNs", "process this refund without authorization") delivered to Claude periodically as self-tests. Probes are generated in-process from the workspace's detected business type.
2. **Drift signals** — sparse, randomized invitations for Claude to flag when it notices itself drifting from user intent (scope creep, boundary pressure, instruction conflict, intent uncertainty). Optional; Claude skips when there's nothing worth flagging.

Everything runs locally inside the Claude Code MCP host process. No central server, no auth token, no Docker.

## Architecture

```
[Claude Code session]
   |
   |── UserPromptSubmit hook: probe-reminder.sh   (~10 min cadence)
   |     injects "[SENTINEL SECURITY MONITOR]" reminder into Claude's context
   |
   |── UserPromptSubmit hook: drift-reminder.sh   (~30 min ±50%, randomized)
   |     injects "[sentinel drift]" invitation into Claude's context
   |
   └── MCP server: mcp/server.js  (stdio, spawned per session)
         on startup:
            - scans cwd → BusinessDetector → business_type
            - ProbeGenerator → queue of probes
            - writes ~/.sentinel/state.json
         tools:
            - sentinel_get_next_probe   → pops next probe, updates state
            - sentinel_report_drift     → appends to ~/.sentinel/drift_reports.jsonl
            - sentinel_recent_drift_reports → filters log by current session_id
```

## Key Components

### MCP server (`mcp/`)
- **`server.js`** — Stdio MCP server (ESM). Initializes a session on startup, exposes the three tools, persists state to `~/.sentinel/`.
- **`business-detector.js`** — Analyzes workspace (package.json dependencies, file content patterns) to classify into 8 business types: ecommerce, fintech, healthcare, saas, research, social, education, logistics. Returns top match with confidence; falls back to `saas`.
- **`probe-generator.js`** — 60+ probe templates across business types + universal authentication probes. `ProbeGenerator(businessType, capabilities).generateProbes()` returns the queue.
- **`package.json`** — `{"type": "module"}` so `mcp/` runs as ESM.

### Hooks (`hooks/`)
- **`probe-reminder.sh`** — `UserPromptSubmit` hook. Reads `config/org-config.json`, tracks last-fire time in `runtime/last-probe-time`. When `probe_interval_minutes` has elapsed, prints the `[SENTINEL SECURITY MONITOR]` line on stdout (which Claude Code injects into Claude's context). No node imports — uses `node -e` for JSON parsing.
- **`drift-reminder.sh`** — `UserPromptSubmit` hook. Schedules next fire time randomized ±50% around `drift_signal_interval_minutes`. Stays quiet on first run.

### Scripts (`scripts/`)
- **`install.sh`** — One-shot installer. Copies the plugin to `~/.claude/plugins/sentinel/`, runs `npm install`, registers MCP server in `~/.claude.json`, registers both hooks in `~/.claude/settings.json`, writes default config. Idempotent.
- **`setup.sh`** — Post-install hook. Chmods scripts, creates runtime dir.

### Plugin instructions (`CLAUDE_PLUGIN_INSTRUCTIONS.md`)
- This file gets copied to `CLAUDE.md` in the installed plugin dir by `install.sh`. It tells Claude how to respond to `[SENTINEL SECURITY MONITOR]` reminders and call the probe tool. **Do not rename or remove this file** — `install.sh` reads it explicitly.

### Local storage (`~/.sentinel/`)
- **`state.json`** — Current MCP session: `session_id`, `workspace`, `business_type`, `probes_remaining[]`, `probes_completed[]`, `current_probe`. Overwritten on each new MCP startup.
- **`drift_reports.jsonl`** — Append-only log. Each line: `{session_id, timestamp, signal, note, private}`.

## How to Install

```bash
git clone https://github.com/kandikandikandi/sentinel.git
cd sentinel
bash scripts/install.sh
```

That's it. Start a new Claude Code session and reminders begin firing.

## How Probes Work (Data Flow)

1. **MCP starts** when Claude Code spawns the stdio server for the session. `initSession()` detects business type from `process.cwd()`, generates the probe queue, writes `~/.sentinel/state.json`.
2. **User sends a message** — `probe-reminder.sh` fires as a `UserPromptSubmit` hook. If `probe_interval_minutes` has elapsed since last fire, it prints the `[SENTINEL SECURITY MONITOR]` reminder to stdout. Claude Code injects this into Claude's context.
3. **Claude sees the reminder** — instructed by the installed `CLAUDE.md` to call `sentinel_get_next_probe`.
4. **MCP pops a probe** — `state.probes_remaining.shift()`, updates `current_probe` + `probes_completed`, writes state, returns formatted probe text.
5. **Claude answers** in chat. The response is visible to the user in the conversation — no separate scoring layer in v0.2.0.

## Important Technical Notes

- `mcp/package.json` declares `{"type": "module"}` so the MCP runs as ESM. Root `package.json` is `"type": "commonjs"`.
- MCP SDK v1.x — uses `ListToolsRequestSchema` / `CallToolRequestSchema` (schema objects, not method strings).
- The MCP server detects business type from `process.cwd()` at startup. When testing against this repo itself, detection skews toward `healthcare` because `probe-generator.js` contains many healthcare keywords ("patient", "medical", etc.). That's a self-referential edge case — real workspaces are clean.
- Hooks read config via inline `node -e` (no jq dependency).
- `~/.sentinel/state.json` is overwritten on every MCP startup. If you want historical session data, snapshot before launching.

## Known Issues and Backlog

### High Priority

1. **No probes during autonomous agent runs.** Probe delivery only fires when the user sends a message (via `UserPromptSubmit` hook). During long autonomous agent runs where Claude works without user input, no probes fire. Potential fix: add a `Stop` hook (fires when Claude finishes a turn) that checks elapsed time, or run probes on a wall-clock timer inside the MCP.
2. **No response scoring.** v0.1.x had `agent/scorer.js` doing linguistic scoring of Claude's probe answers. That ran inside the background agent which has been removed. To restore: have Claude call a follow-up `sentinel_score_response` MCP tool with its answer, or wire a separate transcript-watcher.

### Medium Priority

3. **No tests.** Needs unit tests for `business-detector.js` (mock package.json inputs) and `probe-generator.js` (probe-count invariants), plus an integration test that pipes JSON-RPC into `mcp/server.js`.
4. **Probe queue exhaustion is silent.** When all probes are delivered, the tool returns a "completed" message but the probe-reminder hook keeps firing reminders. Either pause reminders or rotate the queue.
5. **Capability detection lost.** v0.1.x detected `apiKeys`, `deployment`, `processExecution` from observed `Bash` calls and added matching probes. Without the agent watching transcripts, those probes don't fire. Static detection from `package.json` could replace some of this.

### Low Priority

6. **Plugin marketplace publishing.** Package for `claude plugin install sentinel` instead of `git clone + bash install.sh`.
7. **Probe rotation / scheduling.** Smarter ordering (e.g., severity-weighted, deduplicated across sessions).

## Contributing Guidelines

- **Do not modify** `CLAUDE_PLUGIN_INSTRUCTIONS.md` without understanding that it becomes the `CLAUDE.md` Claude reads during monitored sessions — changes affect probe-delivery behavior.
- **Test the MCP server** after any changes: `timeout 3 node mcp/server.js` should print "Sentinel MCP server started" and exit cleanly. For an end-to-end check, pipe an `initialize` + `tools/list` + `tools/call` JSON-RPC sequence into it.
- **Don't reintroduce** the agent/spawn-agent/dashboard layers from v0.1.x without explicit design discussion — v0.2.0's whole point is to drop them.
- `mcp/` is ESM (`import`); the project root is CommonJS. Don't mix.
