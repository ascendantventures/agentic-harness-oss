# Angel Factory v2 Architecture

Angel Factory v2 is a modular, TypeScript rewrite of the original 3000-line
`factory-loop.js` monolith. The key innovation is a **station plugin system**
and **configurable pipeline definitions** that let operators run any workflow
without touching core code.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Module Structure](#2-module-structure)
3. [Pipeline System](#3-pipeline-system)
4. [Station Plugin System](#4-station-plugin-system)
5. [Routing Flow](#5-routing-flow)
6. [Module Dependency Graph](#6-module-dependency-graph)
7. [Config System](#7-config-system)
8. [Adding a New Station](#8-adding-a-new-station)
9. [Adding a New Pipeline](#9-adding-a-new-pipeline)
10. [Migration from the Monolith](#10-migration-from-the-monolith)

---

## 1. Overview

The factory is a cron-driven loop that:

1. Reads `config.json` and `pipelines.json` at startup
2. Builds a **StationRegistry** (one instance per station type)
3. Each tick: fetches GitHub issues by label, routes them through station gates, spawns Claude agents
4. Agents do the work (write code, run tests, post comments), then flip the issue's GitHub label to advance it

**Key design decisions:**

| Decision | Rationale |
|----------|-----------|
| Static station registry (not folder-scanning) | TypeScript type safety, explicit dependency graph |
| Config-driven pipelines (`pipelines.json`) | Operators add pipelines without touching core code |
| GitHub labels as source of truth | Visible state, easy to override manually |
| One file = one station | Adding a station = adding one file |
| Full TypeScript | Every interface typed, catch errors at compile time |

---

## 2. Module Structure

```
factory/
├── src/
│   ├── core/
│   │   ├── config.ts        # Load + validate config.json
│   │   ├── locks.ts         # Lock file management (TTL, dead-lock cleanup)
│   │   ├── backoff.ts       # Crash backoff tracking
│   │   └── keys.ts          # API key rotation
│   │
│   ├── github/
│   │   ├── client.ts        # gh() CLI wrappers
│   │   ├── issues.ts        # Fetch + enrich issues, parse manifests
│   │   └── labels.ts        # Label transition helpers
│   │
│   ├── stations/
│   │   ├── base.ts          # BaseStation abstract class + FactoryContext
│   │   ├── registry.ts      # StationRegistry — register + look up stations
│   │   │
│   │   ├── spec/index.ts    # SpecStation     (intake → spec)
│   │   ├── design/index.ts  # DesignStation   (spec → design)
│   │   ├── build/index.ts   # BuildStation    (design → build)
│   │   ├── qa/index.ts      # QAStation       (build → qa)
│   │   ├── bugfix/index.ts  # BugfixStation   (bugfix → build)
│   │   │
│   │   ├── research/index.ts # ResearchStation (pipeline:content → draft)
│   │   ├── draft/index.ts    # DraftStation    (draft → review)
│   │   ├── review/index.ts   # ReviewStation   (review → publish)
│   │   └── publish/index.ts  # PublishStation  (publish → done)
│   │
│   ├── agents/
│   │   ├── spawn.ts         # spawnAgent() — forks Claude CLI or openclaw
│   │   └── monitor.ts       # Agent activity tracking, hung-agent detection
│   │
│   ├── notify/
│   │   ├── discord.ts       # Discord webhook notifications
│   │   └── supabase.ts      # Supabase: thread push, token usage, submissions
│   │
│   ├── pipeline/
│   │   ├── detector.ts      # PipelineDetector — which pipeline owns this issue?
│   │   ├── router.ts        # PipelineRouter  — routes issues to stations
│   │   ├── runner.ts        # tick() (legacy) + tickV2() (Phase 3 multi-pipeline)
│   │   └── scheduler.ts     # Cron / timer wrapper
│   │
│   ├── types/
│   │   ├── index.ts         # All shared domain types (Issue, AgentTask, Lock, etc.)
│   │   └── pipeline.ts      # Pipeline types (PipelineConfig, PipelinesConfig, etc.)
│   │
│   └── loop.ts              # Main entrypoint (bootstrap, wires everything together)
│
├── config.json              # Station config + GitHub + concurrency + pipelinesFile ref
├── pipelines.json           # Pipeline definitions (edit here to add/change pipelines)
└── docs/
    ├── architecture.md      # This file
    └── custom-pipelines.md  # How to create custom pipelines and stations
```

---

## 3. Pipeline System

### What is a Pipeline?

A **pipeline** is a named sequence of stages. Each stage has:
- A `stationId` (which station processes it)
- A `label` (the GitHub label that triggers processing)
- A `nextLabel` (the label applied on completion, or `null` for terminal stages)

```
Pipeline: "software"
┌──────────────────────────────────────────────────────────┐
│  stage 1: stationId=spec     label=station:intake         │
│           nextLabel=station:spec                          │
│  stage 2: stationId=design   label=station:spec           │
│           nextLabel=station:design                        │
│  stage 3: stationId=build    label=station:design         │
│           nextLabel=station:build                         │
│  stage 4: stationId=qa       label=station:build          │
│           nextLabel=station:qa                            │
│  stage 5: stationId=bugfix   label=station:bugfix         │
│           nextLabel=station:build                         │
└──────────────────────────────────────────────────────────┘
```

### pipelines.json

All pipeline definitions live in `factory/pipelines.json`. The factory loads this at
startup — no code changes needed to add a new pipeline.

```json
{
  "default": "software",
  "pipelines": [
    {
      "id": "software",
      "name": "Software Factory",
      "entryLabel": "station:intake",
      "doneLabel": "station:done",
      "detectFn": "default",
      "stages": [ ... ]
    },
    {
      "id": "content",
      "name": "Content Pipeline",
      "entryLabel": "pipeline:content",
      "doneLabel": "station:done",
      "detectFn": "label",
      "detectValue": "pipeline:content",
      "stages": [ ... ]
    }
  ]
}
```

### Pipeline Detection (`detector.ts`)

`PipelineDetector.detect(issue)` determines which pipeline an issue belongs to:

1. **Explicit `pipeline:*` label** — if the issue has `pipeline:content`, use the content pipeline
2. **`detectFn: "label"` pipelines** — check if `detectValue` appears in issue.labels
3. **Default** — fall back to the pipeline whose `id` matches `pipelinesConfig.default`

```typescript
// Result: issue assigned to "content" pipeline
detect({ labels: ['pipeline:content', 'station:review'], ... })
// → PipelineConfig { id: 'content', ... }

// Result: issue assigned to default "software" pipeline
detect({ labels: ['station:intake'], ... })
// → PipelineConfig { id: 'software', ... }
```

### PipelineRouter (`router.ts`)

`PipelineRouter.route()` is the main per-tick routing function:

1. Collect all labels referenced across all pipelines
2. For each label, fetch issues from GitHub
3. For each issue: detect pipeline → find current stage → look up station
4. Check concurrency limits and lock state
5. Call `station.shouldProcess()` for station-specific gates
6. Call `station.buildTask()` to build the agent prompt
7. Apply any per-stage overrides (model, concurrency, ttl)
8. Spawn the agent via `spawnAgent()`

Adding a new pipeline adds labels to the scan set automatically — no router changes needed.

---

## 4. Station Plugin System

### Design Philosophy

**Static registry, not dynamic discovery.**

Stations are TypeScript classes registered at startup. This gives:
- Full type safety at compile time
- Explicit dependency graph
- Easy to test (mock the registry)
- No magic folder scanning or `eval()`

### BaseStation

Every station extends `BaseStation`:

```typescript
export abstract class BaseStation {
  abstract readonly id: string;        // 'spec', 'research', etc.
  abstract readonly label: string;     // GitHub label that triggers this station
  abstract readonly nextLabel: string; // GitHub label applied on completion
  abstract readonly model: string;     // Default Claude model
  abstract readonly concurrency: number; // Max concurrent agents
  abstract readonly ttl: number;       // Lock TTL in ms

  abstract shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult>;
  abstract buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask>;

  // Inherited utilities:
  protected baseCheck()    // skip/paused/phase2 guards
  protected manifestCheck() // manifest validation
  protected log()          // station-prefixed logging
  protected getEffectiveTTL() // simple-issue TTL reduction
}
```

### StationRegistry

The registry holds all stations, indexed by id and label:

```typescript
const registry = StationRegistry.createDefault(config);

registry.get('spec');              // → SpecStation instance
registry.getByLabel('station:intake'); // → SpecStation instance
registry.list();                   // → ['spec', 'design', 'build', 'qa', 'bugfix', 'research', ...]
```

Stations are registered in `StationRegistry.createDefault()`. To add a station:
1. Create the station class
2. Import and register it in `createDefault()`
3. Add a stage to `pipelines.json`

### FactoryContext

Every station method receives a `FactoryContext`:

```typescript
interface FactoryContext {
  config: Config;       // config.json values
  env: FactoryEnv;      // environment variables (repo, supabaseUrl, etc.)
  log: (msg) => void;   // logging function
}
```

This is the dependency injection point — stations don't import services directly,
they receive them through context.

---

## 5. Routing Flow

```
loop.ts (main)
   │
   ├── loadConfig()            → config.json
   ├── loadPipelinesConfig()   → pipelines.json
   ├── StationRegistry.createDefault()
   │
   └── tickV2(depsV2)
          │
          ├── syncDoneStations()   [Supabase sync, Phase 2 auto-queue]
          │
          └── PipelineRouter.route()
                 │
                 ├── getAllActiveLabels()  ← union of all stage labels
                 │
                 └── for each label:
                        GitHub.getIssuesByLabel(label)
                        │
                        └── for each issue:
                               PipelineDetector.detect(issue)    → PipelineConfig
                               PipelineDetector.getCurrentStage() → PipelineStageConfig
                               registry.get(stage.stationId)     → BaseStation
                               │
                               ├── concurrency check
                               ├── lock check
                               ├── crash backoff check
                               ├── station.shouldProcess()
                               ├── station.buildTask()
                               └── spawnAgent()  → Claude agent process
```

---

## 6. Module Dependency Graph

```
loop.ts (entrypoint)
   │
   ├── core/config.ts
   ├── core/locks.ts
   ├── core/backoff.ts
   ├── core/keys.ts
   │
   ├── stations/registry.ts
   │      └── stations/*/index.ts  (each station)
   │             └── stations/base.ts
   │
   ├── pipeline/runner.ts (tickV2)
   │      ├── pipeline/router.ts
   │      │      ├── pipeline/detector.ts
   │      │      └── github/issues.ts
   │      └── notify/supabase.ts
   │
   └── types/index.ts + types/pipeline.ts  (shared interfaces, no deps)

Dependency rules:
  types/*        → zero deps (leaf node)
  core/*         → types/* only
  github/*       → types/*, core/config
  stations/*     → types/*, stations/base, github/*, notify/*
  pipeline/*     → everything above
  loop.ts        → pipeline/runner, core/*, stations/registry, notify/*
```

---

## 7. Config System

### config.json

Controls station-level settings and GitHub configuration:

```json
{
  "pipelinesFile": "./pipelines.json",
  "stations": {
    "spec":     { "model": "claude-sonnet-4-6", "concurrency": 2 },
    "design":   { "model": "claude-opus-4-5",   "concurrency": 1 },
    "research": { "model": "claude-sonnet-4-6", "concurrency": 2 }
  },
  "github": { "repo": "owner/repo" },
  "concurrency": { "maxTasksPerRun": 2 }
}
```

### pipelines.json

Controls which pipelines exist, how they're detected, and which stations run in each stage.
Stage-level overrides (`model`, `concurrency`, `ttl`) take precedence over station defaults.

See `docs/custom-pipelines.md` for the full format.

---

## 8. Adding a New Station

1. **Create** `factory/src/stations/<name>/index.ts`
2. **Implement** `BaseStation` (see template in `custom-pipelines.md`)
3. **Register** in `StationRegistry.createDefault()`:
   ```typescript
   const { MyStation } = require('./mystation/index.js');
   registry.register(new MyStation());
   ```
4. **Add to pipeline** in `pipelines.json`:
   ```json
   { "stationId": "myStation", "label": "station:my-label", "nextLabel": "station:next" }
   ```
5. **Create GitHub labels** for the new stage labels
6. **Write tests** in `tests/unit/stations/mystation.test.ts`

**Total files touched: 4** (station, registry, pipelines.json, tests)

---

## 9. Adding a New Pipeline

1. **Define** the pipeline in `pipelines.json` (add a new entry to `pipelines[]`)
2. **Create** any new station files needed by the pipeline stages
3. **Register** new stations in `StationRegistry.createDefault()`
4. **Create** GitHub labels for all new stage labels
5. **Tag issues** with the pipeline entry label to start processing

No changes needed to `loop.ts`, `runner.ts`, or `router.ts`.

See `docs/custom-pipelines.md` for worked examples.

---

## 10. Module Map

| Concern | Module |
|---------|--------|
| Config loading | `core/config.ts` |
| Lock management | `core/locks.ts` |
| Crash backoff | `core/backoff.ts` |
| API key rotation | `core/keys.ts` |
| GitHub CLI wrappers | `github/client.ts`, `github/issues.ts` |
| Station: SPEC | `stations/spec/index.ts` |
| Station: DESIGN | `stations/design/index.ts` |
| Station: BUILD | `stations/build/index.ts` |
| Station: QA | `stations/qa/index.ts` |
| Station: BUGFIX | `stations/bugfix/index.ts` |
| Discord notify | `notify/discord.ts` |
| Supabase sync | `notify/supabase.ts` |
| Main loop | `pipeline/runner.ts` + `pipeline/router.ts` |
| Station dispatch | `pipeline/detector.ts` + `stations/registry.ts` |
| Entrypoint | `loop.ts` |

Adding a new feature typically requires touching 1–4 files. See Section 8 and 9 for walkthroughs.
