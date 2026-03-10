# Adding a Custom Station

A station is a single step in the pipeline. Each station receives an issue, does work via a Claude agent, and flips the GitHub label to hand off to the next station.

## 1. Create the station file

```
factory/src/stations/
  my-station/
    index.ts
```

```typescript
// factory/src/stations/my-station/index.ts
import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';

export class MyStation extends BaseStation {
  readonly id = 'my-station';
  readonly label = 'station:my-station';   // GitHub label that triggers this station
  readonly nextLabel = 'station:next';      // Label to flip to when done
  readonly model = 'claude-sonnet-4-6';     // or claude-haiku-4-5 for speed
  readonly concurrency = 1;
  readonly ttl = 1800000; // 30 min lock TTL

  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    const base = await this.baseCheck(issue, ctx);
    if (base) return base;
    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    return {
      key: `my-station-issue-${issue.number}`,
      station: this.id,
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: `You are a ${this.id} agent.

## Your job
[Describe what this station does]

## Step 1 — Read the issue
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.githubRepo} --comments | head -200
\`\`\`

## Step 2 — Do the work
[Your agent instructions here]

## Step 3 — Flip the label when done
\`\`\`bash
gh issue edit ${issue.number} --repo ${ctx.env.githubRepo} \\
  --remove-label "station:my-station" --add-label "station:next"
\`\`\`

Post a comment summarizing what you did. Then exit.`
    };
  }
}
```

## 2. Register the station

```typescript
// factory/src/stations/index.ts
import { StationRegistry } from './registry.js';
import { SpecStation } from './spec/index.js';
import { DesignStation } from './design/index.js';
import { BuildStation } from './build/index.js';
import { QAStation } from './qa/index.js';
import { BugfixStation } from './bugfix/index.js';
import { MyStation } from './my-station/index.js';  // ← add this

export function createDefaultRegistry(): StationRegistry {
  const registry = new StationRegistry();
  registry.register(new SpecStation());
  registry.register(new DesignStation());
  registry.register(new BuildStation());
  registry.register(new QAStation());
  registry.register(new BugfixStation());
  registry.register(new MyStation());  // ← and this
  return registry;
}
```

## 3. Create the GitHub label

```bash
gh label create "station:my-station" --repo owner/repo --color fbca04
```

## 4. Add to your pipeline config (optional)

```json
// factory/pipelines.json
{
  "pipelines": [
    {
      "id": "my-pipeline",
      "name": "Custom Pipeline",
      "triggerLabel": "pipeline:custom",
      "stations": ["spec", "my-station", "build", "qa"]
    }
  ]
}
```

## Real example: ReviewStation

A code review station that runs between BUILD and QA:

```typescript
export class ReviewStation extends BaseStation {
  readonly id = 'review';
  readonly label = 'station:review';
  readonly nextLabel = 'station:qa';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 1;
  readonly ttl = 900000; // 15 min

  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    const base = await this.baseCheck(issue, ctx);
    if (base) return base;
    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    return {
      key: `review-issue-${issue.number}`,
      station: this.id,
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: `You are a code review agent.

## Step 1 — Find the build repo
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.githubRepo} --comments \\
  | grep "Build repo:" | head -1
\`\`\`

## Step 2 — Clone and review
\`\`\`bash
git clone <BUILD_REPO_URL> /tmp/review-${issue.number}
cd /tmp/review-${issue.number}
\`\`\`

Check for:
- TypeScript errors: \`npx tsc --noEmit 2>&1 | head -20\`
- No hardcoded secrets
- No console.log left in production code
- API routes have auth checks

## Step 3 — Post findings and flip label
If issues found: post comment with list, flip to station:bugfix
If clean: flip to station:qa

\`\`\`bash
gh issue edit ${issue.number} --repo ${ctx.env.githubRepo} \\
  --remove-label "station:review" --add-label "station:qa"
\`\`\``
    };
  }
}
```

## Tips

- **Keep stations focused** — one job, one agent, exits when done
- **Always post a comment** — the next station reads it
- **Lock TTL** — set it longer than you think you need (SPEC: 30m, BUILD: 2h)
- **Model choice** — haiku for simple/fast, sonnet for most work, opus for deep research only
