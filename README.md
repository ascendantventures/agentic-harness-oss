# agentic-harness 🏭

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![Built with Claude](https://img.shields.io/badge/built%20with-Claude-orange)](https://anthropic.com)

> Autonomous multi-station agent pipeline for shipping production software.

**SPEC → DESIGN → BUILD → QA → BUGFIX → DONE**

agentic-harness is a Node.js orchestrator that turns GitHub issues into deployed software. Each issue flows through a pipeline of specialized Claude agents — writing the spec, designing the UI, building the code, testing it, and fixing bugs — with no human in the loop.

---

## What it does

```
┌──────────────────────────────────────────────────────────┐
│                agentic-harness pipeline                     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  GitHub Issue                                            │
│  (station:intake)                                        │
│       │                                                  │
│       ▼                                                  │
│  ┌─────────┐    ┌──────────┐    ┌──────────┐            │
│  │  SPEC   │───▶│  DESIGN  │───▶│  BUILD   │            │
│  │ ~5 min  │    │ ~30 min  │    │ ~25 min  │            │
│  └─────────┘    └──────────┘    └──────────┘            │
│                                      │                   │
│                 ┌────────────────────┘                   │
│                 ▼                                        │
│  ┌──────────┐       ┌──────────┐                        │
│  │  BUGFIX  │◀──────│    QA    │                        │
│  │ ~15 min  │ FAIL  │ ~15 min  │                        │
│  └──────────┘       └──────────┘                        │
│        │                 │ PASS                          │
│        └────────────────▶│                              │
│                          ▼                               │
│                    station:done ✅                        │
│                   (app deployed)                         │
└──────────────────────────────────────────────────────────┘
```

Each station is an independent `claude -p` subprocess. The factory loop polls GitHub issues by label, spawns the right agent, and monitors it. No persistent threads — each agent runs, completes, and exits. The next station picks up where the last left off.

### The stations

| Station | Input label | Output label | What it does |
|---------|-------------|--------------|--------------|
| **SPEC** | `station:intake` | `station:spec` | Writes a technical specification from the issue brief |
| **DESIGN** | `station:spec` | `station:design` | Produces a complete visual design system |
| **BUILD** | `station:design` | `station:build` | Implements the full application and deploys it |
| **QA** | `station:build` | `station:done` or `station:bugfix` | Smoke-tests the live app, passes or files bugs |
| **BUGFIX** | `station:bugfix` | `station:build` | Fixes all open bug issues, redeploys, hands back to QA |

---

## Architecture

The pipeline is GitHub-label-driven. Labels are the source of truth for where an issue is in the pipeline. This means:

- **Resilient**: kill the factory, restart it — it picks up exactly where it left off
- **Transparent**: look at any issue's labels to see its current state
- **Overridable**: manually move an issue to any station by editing its labels

The factory runs as a cron job (every 1–5 minutes). Each tick it:

1. Fetches issues by label from GitHub
2. Checks locks (one agent per issue per station at a time)
3. Checks crash backoff (exponential cooldown after fast failures)
4. Spawns `claude -p` with the station's task as stdin
5. Monitors agent health (hung agent detection + killer)
6. The agent does its work, flips the label, exits

### Claude CLI as the agent runtime

Each agent is a stateless `claude -p` invocation:

```bash
claude -p --model claude-sonnet-4-6 \
  --output-format json \
  --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' \
  --dangerously-skip-permissions \
  < task-prompt.txt
```

No session files, no lock contention, fully concurrent. The agent reads the task, does the work, posts a GitHub comment, flips the label, and exits.

### Multi-pipeline support

agentic-harness supports multiple pipelines defined in `pipelines.json`. Out of the box:

- **Software pipeline**: spec → design → build → QA (for apps)
- **Content pipeline**: research → draft → review → publish (for articles/blogs)

Custom pipelines are just a JSON config + TypeScript station class. See [docs/custom-pipelines.md](docs/custom-pipelines.md).

---

## Quick Start

### Prerequisites

- Node.js 18+
- [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
- [`gh` CLI](https://cli.github.com/) — authenticated with your GitHub account
- Anthropic API key or OAuth token

### 1. Clone and install

```bash
git clone https://github.com/your-org/agentic-harness
cd agentic-harness
npm install
```

### 2. Configure

```bash
cp .env.example .env
cp factory/config.example.json factory/config.json
# Edit both files with your values
```

### 3. Create GitHub labels

The factory uses labels to track pipeline state. Create them in your repo:

```bash
gh label create "station:intake"  --repo owner/repo --color "0075ca" --description "Queued for SPEC"
gh label create "station:spec"    --repo owner/repo --color "e4e669" --description "SPEC complete"
gh label create "station:design"  --repo owner/repo --color "d93f0b" --description "DESIGN complete"
gh label create "station:build"   --repo owner/repo --color "0e8a16" --description "BUILD complete"
gh label create "station:qa"      --repo owner/repo --color "1d76db" --description "In QA"
gh label create "station:bugfix"  --repo owner/repo --color "e11d48" --description "Needs bugfix"
gh label create "station:done"    --repo owner/repo --color "6f42c1" --description "Done"
gh label create "station:skip"    --repo owner/repo --color "ffffff" --description "Skip all processing"
gh label create "status:paused"   --repo owner/repo --color "cccccc" --description "Paused"
gh label create "complexity:simple"  --repo owner/repo --color "c2e0c6" --description "Simple"
gh label create "complexity:medium"  --repo owner/repo --color "fef2c0" --description "Medium"
gh label create "complexity:complex" --repo owner/repo --color "fad8c7" --description "Complex"
```

### 4. Run

```bash
# Run once manually to test
npm start

# Or run with file watching (auto-restart on changes)
npm run dev

# Or add to crontab (runs every minute)
* * * * * cd /path/to/agentic-harness && npm start >> /tmp/factory.log 2>&1
```

### 5. Queue your first issue

Create a GitHub issue in your repo, add the label `station:intake`, and watch the factory pick it up.

```bash
gh issue create --repo owner/repo \
  --title "Build a simple todo app with auth" \
  --body "A task management app. Users can sign up, create todos, mark them done. Deploy to Vercel." \
  --label "station:intake"
```

See [examples/simple-todo-app/](examples/simple-todo-app/) for a full walkthrough of what happens next.

---

## Configuration

### `.env`

```bash
# Required: Anthropic auth (one of these)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # OAuth token (from: claude setup-token)
# ANTHROPIC_API_KEY=sk-ant-api03-...       # OR API key

# Required: GitHub repo where issues live
GITHUB_REPO=owner/your-repo

# Optional: Discord webhook for pipeline notifications
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Optional: Vercel token for deployment
VERCEL_TOKEN=your-vercel-token

# Optional: Supabase (enables submission tracking + spec approval flow)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### `factory/config.json`

```json
{
  "stations": {
    "spec":   { "model": "claude-sonnet-4-6", "concurrency": 2 },
    "design": { "model": "claude-opus-4-5",   "concurrency": 1 },
    "build":  { "model": "claude-sonnet-4-6", "concurrency": 1 },
    "qa":     { "model": "claude-sonnet-4-6", "concurrency": 1 },
    "bugfix": { "model": "claude-sonnet-4-6", "concurrency": 1 }
  },
  "github": { "repo": "owner/your-repo" },
  "concurrency": { "maxTasksPerRun": 2 }
}
```

### Environment variable reference

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes* | Claude CLI OAuth token (`sk-ant-oat01-*`) |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key (alternative to OAuth) |
| `GITHUB_REPO` | Yes | `owner/repo` — where issues live |
| `DISCORD_WEBHOOK_URL` | No | Discord notifications (optional) |
| `VERCEL_TOKEN` | No | Vercel deploy token (used by BUILD agent prompts) |
| `SUPABASE_URL` | No | Supabase URL (enables submission tracking) |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Supabase service role key |
| `FACTORY_SECRET` | No | Shared secret for authenticated API calls |
| `FACTORY_APP_URL` | No | URL of your factory web app (for internal issue references) |
| `FACTORY_LOG` | No | Path to log file (default: `/tmp/factory-loop.log`) |
| `FACTORY_USE_CLAUDE` | No | Set to `1` to force `claude -p` mode (vs openclaw) |
| `CLAUDE_BIN` | No | Path to `claude` binary (default: `claude` from PATH) |
| `OPENCLAW_BIN` | No | Path to `openclaw` binary (default: `openclaw` from PATH) |

*One of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is required.

> **Important:** OAuth tokens (`sk-ant-oat01-*`) and API keys (`sk-ant-api03-*`) use different auth mechanisms. The factory detects the key type automatically. Do not set both.

---

## Resilience Features

agentic-harness was designed for unattended operation. These features keep it running reliably:

### Lock system

One agent per issue per station. Locks are stored in `/tmp/factory-loop.lock` with TTLs:

| Station | Normal TTL | Simple TTL |
|---------|-----------|------------|
| spec | 30 min | 15 min |
| design | 2 hours | 1 hour |
| build | 2 hours | 1 hour |
| qa | 30 min | 15 min |
| bugfix | 2 hours | 1 hour |

### Crash backoff

When an agent fails fast (dies in < 2 minutes), it enters exponential backoff: 5m, 10m, 15m… up to 30m. This prevents tight respawn loops on broken configs.

### Hung agent detection

Agents that are alive but silent for too long are killed. Silence thresholds by station:

| Station | Silent threshold |
|---------|----------------|
| spec | 3 min |
| qa | 5 min |
| design/build/bugfix | 15 min |

### QA stall guard

If QA fails 3+ times with no new commits in the build repo, the issue is automatically escalated to `station:blocked` for manual investigation.

---

## Adding a Station

See [docs/adding-a-station.md](docs/adding-a-station.md) for a complete guide with a full working example.

Short version: extend `BaseStation`, implement `shouldProcess()` and `buildTask()`, register in `StationRegistry`, add to `pipelines.json`.

---

## Custom Pipelines

See [docs/custom-pipelines.md](docs/custom-pipelines.md) for the full guide.

Short version: edit `pipelines.json` to add a new pipeline, create station classes for each step, register them. No core code changes needed.

---

## How it works in production

[Ascendant Ventures](https://ascendantventures.net) runs a governed version of this harness in production as the execution layer of its agentic delivery control plane — with approval gates, artifact capture, runtime policy, and operator dashboards on top.

This open-source release is the core execution engine — the poll + spawn + label-flip pipeline that drives agentic delivery. The governance layer is the commercial product.

**agentic-harness is the open-source engine. [Ascendant Ventures](https://ascendantventures.net) is the governed control plane.**

---

## Examples

- [examples/simple-todo-app/](examples/simple-todo-app/) — complete walkthrough of a real pipeline run

---

## License

MIT
