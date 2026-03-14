# agentic-harness 🏭

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![Built with Claude](https://img.shields.io/badge/built%20with-Claude-orange)](https://anthropic.com)

> Autonomous multi-station agent pipeline for shipping production software — with governance.

**SPEC → DESIGN → BUILD → QA → UAT → DONE**

agentic-harness is a Node.js orchestrator that turns GitHub issues into deployed, tested software. Each issue flows through a pipeline of specialized Claude agents — writing the spec, designing the UI, building the code, running technical QA, and performing user acceptance testing — all governed by feature branches, PR reviews, regression testing, and auto-merge on approval.

---

## What it does

```
┌──────────────────────────────────────────────────────────────┐
│                  agentic-harness pipeline                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  GitHub Issue (station:intake)                               │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────┐    ┌──────────┐    ┌──────────┐                │
│  │  SPEC   │───▶│  DESIGN  │───▶│  BUILD   │                │
│  │ Opus    │    │ Opus     │    │ Sonnet   │                │
│  │ ~5 min  │    │ ~30 min  │    │ ~25 min  │                │
│  └─────────┘    └──────────┘    └──────────┘                │
│                                      │                       │
│                      feature branch + PR                     │
│                      Vercel preview deploy                   │
│                 ┌────────────────────┘                       │
│                 ▼                                            │
│  ┌──────────┐       ┌──────────┐       ┌──────────┐        │
│  │  BUGFIX  │◀──────│    QA    │──────▶│   UAT    │        │
│  │ Sonnet   │ FAIL  │ Sonnet   │ PASS  │ Sonnet   │        │
│  │ ~15 min  │       │ ~15 min  │       │ ~25 min  │        │
│  └──────────┘       └──────────┘       └──────────┘        │
│        │                                     │               │
│        └──────────────────┐     ┌────────────┘               │
│                           ▼     ▼                            │
│                     PR auto-merge                            │
│                     Deploy to production                     │
│                     station:done ✅                           │
└──────────────────────────────────────────────────────────────┘
```

### The stations

| Station | Trigger | Output | What it does |
|---------|---------|--------|--------------|
| **SPEC** | `station:intake` | `station:spec` | Writes a technical specification with requirements, architecture, and acceptance criteria |
| **DESIGN** | `station:spec` | `station:design` | Produces a complete visual design system using [Impeccable](https://github.com/pbakaus/impeccable) methodology. Deduplication check against existing components |
| **BUILD** | `station:design` | `station:build` | Implements the full app, pushes to feature branch, opens PR, deploys Vercel preview. Updates CLAUDE.md + REGRESSION.md |
| **QA** | `station:build` | `station:qa` | Reviews PR diff + smoke tests the preview deploy via agent-browser. Runs full regression manifest. Approves PR on pass |
| **UAT** | `station:qa` | `station:done` | Simulates a non-technical business user testing the live preview. Auto-merges PR to production on pass |
| **BUGFIX** | `station:bugfix` | `station:build` | Fixes QA/UAT failures on the feature branch, pushes fixes, redeploys preview |

### What makes this different

- **Feature branch governance**: Every build gets its own branch and PR. No code reaches `main` without QA + UAT approval.
- **UAT (User Acceptance Testing)**: An agent with a non-technical persona actually uses the app via a real browser. Catches UX issues that code review misses.
- **Regression testing**: `REGRESSION.md` is a living test manifest. Every feature adds test steps. Every QA/UAT run tests *everything* — not just new code.
- **Project memory**: `CLAUDE.md` captures architecture decisions, gotchas, and key files. Future agents read it before making changes.
- **Deduplication checks**: Design and Build stations audit existing components before creating new ones. No more duplicate "New Issue" buttons.
- **Impeccable design**: All UI work uses the [Impeccable](https://github.com/pbakaus/impeccable) design methodology — bold aesthetics, distinctive typography, OKLCH color, purposeful motion.

---

## Architecture

The pipeline is **GitHub-label-driven**. Labels are the source of truth for where an issue is in the pipeline:

- **Resilient**: Kill the factory, restart — it picks up exactly where it left off
- **Transparent**: Look at any issue's labels to see its current state
- **Overridable**: Manually move an issue to any station by editing its labels

The factory loop polls every 1–5 minutes. Each tick it:

1. Fetches issues by label from GitHub
2. Checks locks (one agent per issue per station)
3. Checks crash backoff (exponential cooldown after fast failures)
4. Spawns `claude -p` with the station's task prompt
5. Monitors agent health (hung detection + auto-kill)
6. On agent exit, reconciles labels if the agent didn't flip them

### PR-based deployment flow

```
Build agent → feature/issue-{N} branch → PR against main → Vercel preview
    ↓
QA agent → reviews PR diff → tests preview → approves PR
    ↓
UAT agent → tests preview as business user → auto-merges PR → production deploy
```

### Key files in build repos

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project memory — architecture, env vars, key files, known gotchas |
| `REGRESSION.md` | Feature test manifest — every testable feature with steps and expected results |

### Multi-pipeline support

Defined in `factory/pipelines.json`:

- **Software pipeline**: spec → design → build → QA → UAT → done
- **Content pipeline**: research → draft → review → publish → done

Custom pipelines are JSON config + TypeScript station class.

### Dynamic skill detection

The harness detects tech stack from issue content and auto-installs relevant skills:

| Stack | Skills installed |
|-------|-----------------|
| React | react-expert, vercel-react-best-practices |
| Next.js | nextjs-app-router-fundamentals |
| Supabase | supabase-postgres-best-practices |
| Vercel | deploy-to-vercel |
| UI/Frontend | [Impeccable](https://github.com/pbakaus/impeccable) frontend-design |

Agents can self-discover additional skills mid-task via `find-skills`.

---

## Quick Start

### Prerequisites

- Node.js 18+
- [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
- [`gh` CLI](https://cli.github.com/) — authenticated
- [`agent-browser`](https://github.com/AhmadMayo/agent-browser) — for QA/UAT browser testing
- Anthropic API key or OAuth token

### 1. Clone and install

```bash
git clone https://github.com/ascendantventures/agentic-harness-oss
cd agentic-harness-oss
```

### 2. Configure (Interactive)

The easiest way to get started is by using the interactive setup script!

```bash
npm run setup
```



This will launch a beautiful interactive terminal UI that will walk you through the entire process:
1. Install essential project dependencies.
2. Check that you have `node`, `claude`, and `gh` installed.
3. Ask for your Anthropic API Key and target GitHub repository.
4. Auto-configure your `.env` and `factory/config.json`.
5. Offer to automatically create all the required GitHub labels (`station:spec`, `station:design`, etc.) in your repository.
6. Offer to queue your first test issue (a "Todo App") automatically.
7. Offer to start the factory loop (`npm run dev`) immediately.

### 3. Manual Execution (Optional)

If you chose not to start the loop or queue the issue during the interactive setup, you can do so manually:

**Start the factory:**
```bash
# Run once
npm start

# Run with file watching
npm run dev

# Or crontab (every minute)
* * * * * cd /path/to/agentic-harness-oss && npm start >> /tmp/factory.log 2>&1
```

**Queue an issue manually:**
```bash
gh issue create --repo owner/repo \
  --title "Build a simple todo app with auth" \
  --body "A task management app. Users can sign up, create todos, mark them done. Deploy to Vercel." \
  --label "station:intake"
```

Watch the pipeline: `tail -f /tmp/factory-loop.log`

---

## Configuration

### `.env`

```bash
# Required (one of these)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # OAuth token
# ANTHROPIC_API_KEY=sk-ant-api03-...       # OR API key

# Required
GITHUB_REPO=owner/your-repo

# Optional
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
VERCEL_TOKEN=your-vercel-token
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
FACTORY_APP_URL=https://your-dashboard.vercel.app
```

### `factory/config.json`

```json
{
  "stations": {
    "spec":   { "model": "claude-sonnet-4-6", "concurrency": 3 },
    "design": { "model": "claude-opus-4-6",   "concurrency": 2 },
    "build":  { "model": "claude-sonnet-4-6", "concurrency": 1 },
    "qa":     { "model": "claude-sonnet-4-6", "concurrency": 1 },
    "uat":    { "model": "claude-sonnet-4-6", "concurrency": 1 },
    "bugfix": { "model": "claude-sonnet-4-6", "concurrency": 1 }
  },
  "concurrency": { "maxTasksPerRun": 2 }
}
```

---

## Resilience

### Lock system

One agent per issue per station. Locks with TTLs in `/tmp/factory-loop.lock`:

| Station | Normal TTL | Simple TTL |
|---------|-----------|------------|
| spec/qa/uat | 30 min | 15 min |
| design/build/bugfix | 2 hours | 1 hour |

### 3-layer label reconciliation

1. **Post-exit**: When an agent exits, checks if work artifact exists → auto-advances label
2. **Guard auto-advance**: `shouldProcess()` detects completed work → flips label instead of skipping
3. **Periodic sweep**: Every 10 ticks, scans all open issues for stuck labels

### Crash backoff

Fast failures (< 2 min) trigger exponential backoff: 5m, 10m, 15m… max 30m.

### Hung agent detection

Agents silent beyond threshold are killed (spec: 3m, qa: 5m, build/design: 15m).

---

## Adding a Station

1. Create `factory/src/stations/<name>/index.ts` extending `BaseStation`
2. Implement `shouldProcess()` and `buildTask()`
3. Register in `StationRegistry.createDefault()`
4. Add to `factory/pipelines.json`

---

## In Production

[Ascendant Ventures](https://ascendantventures.net) runs a governed version of this harness as the execution layer of **Foundary** — its agentic delivery control plane with approval gates, cost tracking, operator dashboards, and runtime policy enforcement.

This open-source release is the core execution engine. The governance layer is the commercial product.

**agentic-harness is the engine. [Foundary](https://ascendantventures.net) is the governed control plane.**

---

## License

MIT
