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
  readonly nextLabel = 'station:provisioned';
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

## Step 0 — Mark station as active (run immediately)

\`\`\`bash
curl -s -X PATCH \\
  "${ctx.env.supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${ctx.env.supabaseKey}" \\
  -H "Authorization: Bearer ${ctx.env.supabaseKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"station": "bugfix"}' || true
\`\`\`

## Your Task

Fix the QA failures for issue #${issue.number}.

### 1. Read the issue + QA failure report
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

Find the most recent QA RESULTS comment. Note every FAIL criterion.

### 2. Clone the build repo + checkout feature branch
\`\`\`bash
git clone https://github.com/${buildRepo ?? 'BUILD_REPO_HERE'} /tmp/bugfix-work
cd /tmp/bugfix-work

# Checkout the existing feature branch (bugs are fixed on the PR branch, not main)
BRANCH_NAME="feature/issue-${issue.number}"
git checkout "$BRANCH_NAME" 2>/dev/null || git checkout -b "$BRANCH_NAME"
\`\`\`

### 3. Fix each failing acceptance criterion

For each FAIL:
- Diagnose the root cause
- Implement the fix
- Note the change made

### 4. TypeScript check + Vercel build (HARD STOP on errors)
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

# Vercel build — generates .vercel/output for --prebuilt deploy (skips remote build step)
vercel pull --yes --environment=production 2>&1 | tail -5
BUILD_OUT=$(vercel build 2>&1)
BUILD_EXIT=$?
echo "$BUILD_OUT" | tail -30
if [ $BUILD_EXIT -ne 0 ]; then
  echo "❌ Vercel build FAILED — fix all errors before pushing"
  exit 1
fi
echo "✅ Vercel build passed — .vercel/output ready"
\`\`\`

### 5. Update REGRESSION.md with bug learnings (⛔ REQUIRED — pipeline will reject without this)
If CLAUDE.md exists, append bugs to the "Known Issues & Gotchas" section.
If REGRESSION.md exists, update any test steps that were incorrect or add new regression test steps for the fixed behavior.
**Your PR WILL be bounced back if REGRESSION.md is not modified.** This is enforced by an automated artifact gate.

### 5b. Append novel findings to build-patterns.md
Bugs often reveal systemic patterns. If you discovered a root cause or workaround that future agents should know — append it to the shared patterns file. Specifics only. Skip if nothing new.
\`\`\`bash
# Only append if genuinely new — no placeholders
BUILD_PATTERNS="/root/.openclaw/workspace/shared/findings/build-patterns.md"
if [ -f "$BUILD_PATTERNS" ]; then
  cat >> "$BUILD_PATTERNS" << 'FINDINGS_EOF'

## PATTERN [auto — $(date +%Y-%m-%d)] — [Short descriptive title]
**Context:** Bugfix for #${issue.number} | ${ctx.env.repo}
**Root cause / finding:** [What caused the bug and how it was fixed]
**Prevention:** [What to do / avoid in future builds]
FINDINGS_EOF
fi
\`\`\`

\`\`\`bash
cd /tmp/bugfix-work
git add -A
git commit -m "bugfix(#${issue.number}): fix QA failures"
git push origin "$BRANCH_NAME"

# Deploy prebuilt artifacts — skips Vercel remote build (already built above)
LIVE_URL=$(vercel deploy --prebuilt --prod 2>&1 | grep -oP 'https://[\\S]+\\.vercel\\.app' | tail -1)
echo "Live redeployed: $LIVE_URL"
\`\`\`

### 6. Post BUGFIX COMPLETE comment + flip label
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "## BUGFIX COMPLETE

Fixed the following QA failures:
- [List each fix with brief explanation]

Live URL: $LIVE_URL
Ready for re-QA."

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:bugfix" --add-label "station:provisioned"
\`\`\`

Confirm: BUGFIX complete for #${issue.number}`,
    };
  }
}
