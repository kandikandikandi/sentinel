# Sentinel

**Agent visibility for Claude Code — see what your agents are doing and why.**

Sentinel continuously tests whether Claude respects security boundaries during real coding sessions. It detects the business context (healthcare, fintech, ecommerce, etc.), asks trick security questions, and scores how well Claude refuses unsafe requests.

Self-hosted. Multi-user. Docker-deployable.

## Quick Start

### Deploy the Server

```bash
git clone https://github.com/kandikandikandi/sentinel.git
cd sentinel
docker-compose up -d
```

Visit `http://localhost:3000/setup` to create your admin account and get your first API token.

### Install on Developer Laptops

```bash
SENTINEL_SERVER="http://your-server:3000" SENTINEL_TOKEN="your_token" bash scripts/install.sh
```

Start a Claude Code session — monitoring begins automatically.

### Onboard a Team

```bash
# Create accounts for 5 engineers
./scripts/onboard-team.sh \
  --server http://your-server:3000 \
  --admin-token YOUR_ADMIN_TOKEN \
  --count 5
```

Each engineer gets a one-liner setup command.

## How It Works

1. Developer starts a Claude Code session
2. Background agent detects business type from the codebase
3. Agent generates security probe questions tailored to that business
4. Every N minutes, a hook reminds Claude to take a security self-test
5. Claude calls the `sentinel_get_next_probe` MCP tool
6. Claude answers the probe question honestly
7. Agent scores the response (0-100) using linguistic analysis
8. Finding is reported to the central dashboard

## Dashboard

The web dashboard at your server URL shows:
- All active sessions across the team
- Security findings with scores and grades
- Alerts for critical/concerning responses
- Per-user activity and trends
- CSV export

## Architecture

| Component | Location | Purpose |
|-----------|----------|---------|
| Background Agent | `agent/` | Detects business type, generates probes, scores responses |
| Dashboard Server | `dashboard/` | Express + SQLite, auth, REST API, web UI |
| MCP Server | `mcp/` | Exposes `sentinel_get_next_probe` tool to Claude |
| Hooks | `hooks/` | Session lifecycle + probe reminders |
| Scripts | `scripts/` | Install, configure, team onboarding |

## Requirements

- **Server**: Docker and Docker Compose
- **Developer laptops**: Node.js 18+, Claude Code CLI

## Documentation

- [How It Works (Technical)](SENTINEL_HOW_IT_WORKS.md) — detailed data flow and scoring
- [CLAUDE.md](CLAUDE.md) — full project reference for AI-assisted development

## Author

[Kandis Tagliabue](https://github.com/kandikandikandi)

## License

[MIT](LICENSE)
