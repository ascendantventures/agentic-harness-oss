# Foundary — Governed SDLC Pipeline

## What Is This

Foundary is a deterministic governance layer for your development workflow. It wraps your normal coding process with **stations** — executable scripts that validate your output at each SDLC phase. You work freely inside each station using whatever tools you need. The stations enforce hard constraints that cannot be bypassed via prompts or instructions.

## When to Use

Use Foundary for **any coding task** — implementing features, fixing bugs, refactoring. Run the pipeline at the start and let it guide you through governed stations.

## Mandatory Tool Requirements (Enforced by Gates)

These are not suggestions — the pipeline gates will BLOCK if artifacts are missing.

### Station 01: Superpowers plan required
Before running the pipeline, write a plan:
```bash
# In your Claude Code session, invoke the writing-plans skill
# Save output to .superpowers/plans/<task-name>.md
```
The gate checks for a valid `.superpowers/plans/*.md` file (>200 chars, recent).
Skip for infra/config-only tasks: set `skipSuperpowers: true` in task spec or `FOUNDARY_SKIP_SUPERPOWERS=1`.

### Station 02: Context7 required for framework imports
If your code imports Next.js, Supabase, Tailwind, Framer Motion, Anthropic SDK, or Vercel:
1. Use Context7 MCP to fetch live docs: `use context7` in your prompt
2. Create the artifact: `.context7-session.json` in the project root
3. The gate validates the file exists and is <24h old

Create the artifact manually when Context7 runs (or via the Context7 wrapper):
```bash
echo '{"fetchedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","libs":["next","supabase"]}' > .context7-session.json
```
Skip: `FOUNDARY_SKIP_CONTEXT7=1`

### Station 02: ui-ux-pro-max required for UI changes
If your diff touches UI files, also invoke the `ui-ux-pro-max` skill and save output to `.uiux-pro-max-review.md`.
Skip: `FOUNDARY_SKIP_UIUX=1`

### Station 02: Impeccable required for UI changes
If your diff touches `.tsx`, `.jsx`, `.css`, `app/`, `components/`, or `pages/`:
1. Run Impeccable audit skill: `audit` in Claude Code
2. Run Impeccable polish skill: `polish` in Claude Code
3. Save output to `.impeccable-audit.md` in project root

The artifact must exist and be <24h old.
Skip: `FOUNDARY_SKIP_IMPECCABLE=1`

---

## Quick Start

```bash
# Start a pipeline for a task
foundary run --task '{"description": "Add rate limiting to API", "taskId": "issue-42", "allowedFiles": ["src/api/**", "src/middleware/**"], "maxFilesChanged": 10}'

# Or with a spec file
foundary run --task task-spec.json

# Check pipeline status
foundary status

# View audit trail
foundary audit --task issue-42
```

## The Station Flow

```
PLAN → IMPLEMENT → VERIFY → REVIEW → DEPLOY
```

1. **Plan** — Your task spec is validated. Scope boundaries are set.
2. **Implement** — You write code freely. Gate checks: files in scope, no secrets, builds.
3. **Verify** — Tests, lint, security audit run. Gate checks: all pass.
4. **Review** — Deterministic diff checks. Gate checks: no debug code, no scope creep.
5. **Deploy** — PR created with full audit trail. Gate checks: all prior stations passed.

## How You Work With It

- Use **all your normal tools** — superpowers, context7, impeccable, playwright, agent-browser
- Code naturally — the pipeline doesn't restrict HOW you work
- When you finish implementing, the station gates validate your OUTPUT
- If a gate blocks you, fix the issue and the station re-runs
- You cannot skip stations — each requires artifacts from the previous one

## Task Spec Format

```json
{
  "description": "What you're building",
  "taskId": "issue-42",
  "allowedFiles": ["src/**", "test/**"],
  "allowedDeps": ["express", "lodash"],
  "maxFilesChanged": 15
}
```

- `allowedFiles` — glob patterns for files you can modify (optional, defaults to all)
- `allowedDeps` — new dependencies you're allowed to add (optional)
- `maxFilesChanged` — cap on number of files (default: 20, >50 requires human approval)

## What Gets Enforced (You Cannot Override These)

- **No secrets in commits** — API keys, passwords, tokens are blocked at git hook level
- **No protected file modifications** — CI/CD, Dockerfiles, .env, .foundary/ configs
- **No skipping stations** — deploy gate requires artifacts from all prior stations
- **Build must pass** — broken code doesn't advance past implement
- **Tests must pass** — failing tests don't advance past verify
- **No debug code in production** — console.log, debugger, etc. blocked at review
- **Tamper-evident audit** — every gate decision is hash-chained and logged


## Team Mode (--team)

For complex tasks that benefit from parallel agent work, use `--team` to spawn a Claude Code Agent Team governed by Foundary:

```bash
foundary run --task '{"description": "Add rate limiting to API", "taskId": "issue-42"}' --team
```

### How It Works

1. **Setup** — Foundary writes `.claude/settings.json` with hooks wired to gate scripts
2. **Team lead spawns agents** — A Planner and a Builder work in parallel
3. **Gates fire automatically** — When a task is marked complete, the `TaskCompleted` hook runs the matching Foundary station gate
4. **Blocked = task not done** — Exit 2 from the gate sends feedback to the teammate to fix before completion
5. **Deterministic tail** — After the team finishes 01-plan and 02-implement, stations 03-verify, 04-review, 05-deploy run normally

### Hook Architecture

| Hook | Purpose |
|------|---------|
| `TaskCompleted` | Maps task title → station, runs gate script. Blocks on exit 2. |
| `TeammateIdle` | Logs idle events to `.foundary/audit/<taskId>.jsonl` |
| `PreToolUse` | Blocks dangerous bash (push to main, rm -rf on critical paths) |

### Task Title → Station Mapping

| Task title contains | Station |
|---------------------|---------|
| "plan" | `01-plan` |
| "implement" or "build" | `02-implement` |
| "verify" or "test" | `03-verify` |
| "review" | `04-review` |

### Team Structure

The team lead receives a prompt directing it to:
1. Spawn a **Planner** to write `.superpowers/plans/<taskId>.md`
2. Spawn a **Builder** to implement (reads `.foundary/scope-constraint.md`, creates tool artifacts)
3. Gate scripts enforce all the same requirements as normal pipeline mode

### When to Use Team Mode vs Dispatch Mode

- **`--team`** — Multi-agent parallel work with task-level gating. Best for large features.
- **`--dispatch`** — Single-agent sequential stations. Best for focused tasks.

## If Something Goes Wrong

If a station blocks you:
1. Read the BLOCKED reason
2. Fix the issue in your code
3. Re-run the pipeline (it will re-check from the blocked station)

The pipeline is here to help, not slow you down. It catches real problems before they reach production.
