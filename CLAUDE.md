# CLAUDE.md — agentic-harness-oss

## What Is This?
[One paragraph description]

## Tech Stack
- **Framework:** 
- **Styling:** 
- **Hosting:** 
- **Database:** 

## Architecture
```
[Directory tree + notes]
```

## Commands
```bash
npm run dev      # local dev server
npm run build    # production build (must pass with zero errors)
npm test         # run all tests
npm run test:e2e # run Playwright E2E tests
```

## Mandatory Skills & Tools

> ⚠️ These are required for every session. Do not skip them.

### Superpowers (`obra/superpowers`)
- **First action every session:** invoke the `using-superpowers` skill via the `Skill` tool
- Use `writing-plans` before writing any code — save plan to `.superpowers/plans/`
- Use `executing-plans` to implement step by step
- Use `subagent-driven-development` for features touching 3+ files or components
- Skills live in `.agents/skills/` — always invoke via `Skill` tool, never read SKILL.md directly

### Impeccable (`pbakaus/impeccable`)
- After **every** design/UI change: invoke `audit` and `critique` skills via `Skill` tool
- Use `polish` for micro-refinements, `typeset` for typography, `colorize` for palette, `bolder` for visual weight
- Run `/teach-impeccable` once on first session to generate `.impeccable.md`
- Skills live in `.agents/skills/` — invoke via `Skill` tool

### Context7 (MCP)
- Configured in `.mcp.json` — auto-starts with the session
- Always append `use context7` when looking up framework APIs
- Never rely on training data for library APIs — always fetch live docs via Context7

---

## Testing Requirements

> ⚠️ Non-negotiable. See `engineering/testing-strategy-sop` in the Obsidian vault for the full standard.

### What must exist in this repo

- `__tests__/` directory with unit tests for all `lib/` modules containing decision logic
- Jest configured (`jest.config.ts` or in `package.json`)
- Playwright configured for E2E (`playwright.config.ts`)
- GitHub Actions CI: run tests on every PR, E2E on merge to main

### Priority order (build in this order)

1. **Q1 Unit tests** — highest-risk lib/ modules first (auth, financial, compliance, state machines)
2. **Q2 Integration tests** — webhook handlers, DB interactions, async pipelines
3. **UAT milestone** — GitHub milestone with one issue per success metric from the spec
4. **Q3 E2E** — top 3 user journeys in Playwright
5. **Q4 Non-functional** — load, security, audit trail completeness

### Before any PR is merged

- New logic in `lib/` → must have a unit test
- New API route → must have an integration test or explicit TODO with issue linked
- UI changes → Impeccable audit + Playwright journey still passes

### Before launch

- UAT milestone must be 100% closed (or items explicitly deferred with written rationale)
- All Q1 and Q2 tests passing in CI
- At least 3 Playwright journeys green

---

## [Add project-specific sections below]

<!-- Key messaging, design direction, environment variables, etc. -->
