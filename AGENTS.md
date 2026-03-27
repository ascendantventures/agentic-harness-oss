# AGENTS.md — agentic-harness-oss

## ⚠️ BEFORE ANY CODE CHANGE — MANDATORY

Read `.foundary/SKILL.md`. Then run:

```bash
foundary run --task '{"description": "...", "taskId": "issue-N", "allowedFiles": ["src/**"]}'
```

**NO direct `git commit`. NO exceptions.** The pre-commit hook will hard-block you. If you committed outside Foundary, stop and redo it through the pipeline.

Emergency human override only: `FOUNDARY_ADMIN=1 git commit` (logged to audit trail).



Read `CLAUDE.md` first — it contains the full project spec, stack, and architecture.

---

## Mandatory Tools — Non-Negotiable

Every session on this project MUST use all three tools below. They are pre-installed in `.agents/skills/` and `.mcp.json`.

### 1. Superpowers (`obra/superpowers`)

**Session start:** invoke `using-superpowers` via the `Skill` tool before anything else.

| When | Skill to use |
|------|-------------|
| Before writing any code | `writing-plans` → save to `.superpowers/plans/` |
| During implementation | `executing-plans` |
| Feature touches 3+ files | `subagent-driven-development` |
| Approach unclear | `brainstorming` |
| Finishing a branch | `finishing-a-development-branch` |
| Before requesting review | `requesting-code-review` |

**Invocation (Claude Code):** `Skill` tool only. Never read SKILL.md files directly.

### 2. Impeccable (`pbakaus/impeccable`)

Run after **every** UI/design change — no exceptions.

| When | Skill to use |
|------|-------------|
| After any UI change | `audit` + `critique` |
| Before any UI commit | `polish` |
| Typography issues | `typeset` |
| Color/palette issues | `colorize` |
| Visual weight issues | `bolder` |
| Layout/spacing issues | `arrange` |
| Hero/signature moments | `overdrive` (use sparingly) |

**First session only:** run `/teach-impeccable` to generate `.impeccable.md` with project-specific design context.

**Invocation (Claude Code):** `Skill` tool with skill name (e.g., `audit`, `polish`).

### 3. Context7 (MCP — `.mcp.json`)

Auto-starts from `.mcp.json`. No setup required.

Always append `use context7` when looking up any framework API. Never rely on training-data knowledge for library APIs — always fetch live docs.

---

## Canonical Workflow

```
using-superpowers (session start)
  → writing-plans (before code)
    → Context7 (API lookups)
      → executing-plans (step by step)
        → audit + critique (after every UI change)
          → tests (unit/integration for new logic)
            → polish / typeset / colorize (UI refinement)
              → verification-before-completion
                → commit + PR
```

---

## Issue-Driven SDLC

- One issue = one branch = one PR
- Create/update GitHub issue before starting work
- Implement on branch, open PR, merge, close issue, delete branch
- Use git worktrees for parallel work

---

## Testing Requirements

> ⚠️ Required on every project. See `engineering/testing-strategy-sop` in the Obsidian vault for full details.

### Rules

- **New lib/ logic → unit test required.** No exceptions for decision logic (auth, compliance, financial, state machines).
- **New webhook/API route → integration test or explicit TODO with linked issue.**
- **Before launch → UAT milestone must be closed** (or deferred with written rationale).
- **CI must run tests on every PR.** Failing tests block merge.

### What to build (in priority order)

1. Unit tests for highest-risk modules (whatever involves money, compliance, auth, or state)
2. Integration tests for webhooks and async pipeline entry points
3. GitHub milestone `UAT Checklist` — one issue per success metric from the project spec
4. Playwright E2E for the 3 core user journeys
5. Non-functional (load, security, audit trail)

### Identifying highest-risk modules

Ask: "If this logic is wrong, what breaks?"
- User can't access their data → **auth/RLS**
- Wrong money charged → **billing/Stripe handlers**
- PHI leaks publicly → **compliance scanner**
- Posts never publish → **state machine / publisher**
- Audit trail incomplete → **logging**

These get unit tests before anything else.

---

## Obsidian Project Notes (Mandatory)

Every project must have a corresponding Obsidian note. This is the strategic source of truth.

**Vault repo:** `ajrrac/obsidian-vault` — clone to `/tmp/obsidian-vault`

**On first session / project onboarding:**
1. Create or update `projects/<project-slug>/overview.md` with: what it is, status, repo, tech stack, strategic position, key decisions
2. Push to vault: `cd /tmp/obsidian-vault && git add -A && git commit -m "..." && git push`

**On significant research:** save to `projects/<project-slug>/market-research.md`, push to vault.

**On key decisions:** document in `overview.md` under "Key Decisions" with date and rationale.

See `projects/sirena/overview.md` in the vault as a reference template.

---

## [Add project-specific rules below]

<!-- Stack, design system, key files, messaging rules, etc. -->

---

## Testing Rules

Full standard: engineering/testing-strategy-sop in Obsidian vault.

- New core logic -> unit test required (auth, billing, state machines - no exceptions)
- New webhook/API route -> integration test or explicit TODO with linked issue
- Before launch -> UAT milestone must be closed (or deferred with written rationale)
- CI must run tests on every PR - failing tests block merge

Identifying highest-risk modules: ask "if this is wrong, what breaks?"
- Wrong money charged -> billing/Stripe handlers
- User cant access data -> auth/RLS/permissions
- Core feature silently fails -> state machine / pipeline
- Data loss or corruption -> DB write paths

These get unit tests before anything else ships.