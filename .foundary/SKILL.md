# Foundary — Governed SDLC Pipeline

## What Is This

Foundary is a deterministic governance layer for your development workflow. It wraps your normal coding process with **stations** — executable scripts that validate your output at each SDLC phase. You work freely inside each station using whatever tools you need. The stations enforce hard constraints that cannot be bypassed via prompts or instructions.

## When to Use

Use Foundary for **any coding task** — implementing features, fixing bugs, refactoring. Run the pipeline at the start and let it guide you through governed stations.

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

## If Something Goes Wrong

If a station blocks you:
1. Read the BLOCKED reason
2. Fix the issue in your code
3. Re-run the pipeline (it will re-check from the blocked station)

The pipeline is here to help, not slow you down. It catches real problems before they reach production.
