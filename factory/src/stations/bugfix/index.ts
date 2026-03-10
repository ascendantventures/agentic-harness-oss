/**
 * BugfixStation — processes issues at 'station:bugfix', sends back to 'station:build'.
 *
 * Ported from makeBugfixTask() in factory-loop.js.
 *
 * Note: Change requests at station:bugfix use the BUILD prompt instead.
 * The runner handles this routing decision; BugfixStation provides the default prompt.
 */

import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';

export class BugfixStation extends BaseStation {
  readonly id = 'bugfix';
  readonly label = 'station:bugfix';
  readonly nextLabel = 'station:build';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 1;
  readonly ttl = 7200000; // 2 hours

  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    // 1. Base checks: skip/paused/phase2
    const base = await this.baseCheck(issue, ctx);
    if (base) return base;

    // 2. Manifest check
    const manifest = this.manifestCheck(issue, ctx.env);
    if (manifest) return manifest;

    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    const buildRepo = issue.buildRepo;

    return {
      key: `bugfix-issue-${issue.number}`,
      station: 'bugfix',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: 'sonnet',
      message: `You are a BUGFIX agent for the factory pipeline.

## Your Task

Fix the QA failures for issue #${issue.number}.

### 1. Read the issue + QA failure report
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

Find the most recent QA RESULTS comment. Note every FAIL criterion.

### 2. Clone the build repo
\`\`\`bash
git clone https://github.com/${buildRepo ?? 'BUILD_REPO_HERE'} /tmp/bugfix-work
cd /tmp/bugfix-work
\`\`\`

### 3. Fix each failing acceptance criterion

For each FAIL:
- Diagnose the root cause
- Implement the fix
- Note the change made

### 4. TypeScript check (HARD STOP on errors)
\`\`\`bash
npm install
TSC_OUT=$(npx tsc --noEmit --skipLibCheck 2>&1)
TSC_EXIT=$?
echo "$TSC_OUT" | head -20
if [ $TSC_EXIT -ne 0 ]; then
  echo "❌ TypeScript errors — fix before pushing"
  exit 1
fi
echo "✅ TypeScript OK"
\`\`\`

### 5. Push fixes + redeploy
\`\`\`bash
cd /tmp/bugfix-work
git add -A
git commit -m "bugfix(#${issue.number}): fix QA failures"
git push origin main

# Redeploy
vercel --prod --yes --token $VERCEL_TOKEN 2>&1 | tail -5
LIVE_URL=$(vercel list --token $VERCEL_TOKEN 2>/dev/null | head -3 | grep -oP 'https://[\\S]+\\.vercel\\.app' | head -1)
echo "Redeployed: $LIVE_URL"
\`\`\`

### 6. Post BUGFIX COMPLETE comment + flip label
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "## BUGFIX COMPLETE

Fixed the following QA failures:
- [List each fix with brief explanation]

Live URL: $LIVE_URL
Ready for re-QA."

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:bugfix" --add-label "station:build"
\`\`\`

Confirm: BUGFIX complete for #${issue.number}`,
    };
  }
}
