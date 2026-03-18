/**
 * QAStation — processes issues at 'station:build', produces 'station:qa'.
 *
 * Ported from makeQATask() in factory-loop.js.
 *
 * Gates:
 *   1. Base checks (skip/paused/phase2)
 *   2. Manifest check
 *   3. Internal issues signal auto-pass (runner handles label flip)
 *   4. hasBuildMovedSinceLastQA (skip if no new commits since last QA failure)
 */

import { execSync } from 'child_process';
import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
import { guardAutoAdvance } from '../../pipeline/reconciler.js';

// ─── QA stall-guard helpers (exported for use in runner + index barrel) ───────

export interface QAInfo {
  hasFailedQA: boolean;
  lastQAAt?: string;
  buildRepo: string | null;
}

/** Find the last QA comment and whether it was a FAIL. Also extracts build repo URL. */
export function getLastQAInfo(
  issueNumber: number,
  repo: string,
  log: (m: string) => void,
): QAInfo {
  try {
    const result = execSync(
      `gh issue view ${issueNumber} --repo ${repo} --comments --json comments 2>/dev/null`,
      { encoding: 'utf8', timeout: 15000 },
    );
    const { comments } = JSON.parse(result) as {
      comments: Array<{ body?: string; createdAt?: string }>;
    };

    const qaComment = [...comments].reverse().find(
      (c) =>
        (c.body?.includes('QA REPORT') ||
          c.body?.includes('QA Complete') ||
          c.body?.includes('QA complete')) &&
        (c.body?.includes('FAIL') ||
          c.body?.includes('PASS') ||
          c.body?.includes('❌') ||
          c.body?.includes('✅')),
    );

    let buildRepo: string | null = null;
    for (const c of [...comments].reverse()) {
      const m1 = c.body?.match(/\*\*Repo:\*\*\s*https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/);
      if (m1) { buildRepo = m1[1]; break; }
      const m2 = c.body?.match(/[Bb]uild repo:?\s*https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/);
      if (m2) { buildRepo = m2[1]; break; }
    }

    if (!qaComment) return { hasFailedQA: false, buildRepo };

    const isFail = Boolean(
      (qaComment.body?.includes('FAIL') || qaComment.body?.includes('❌')) &&
      !qaComment.body?.match(/✅\s*QA PASS/),
    );

    return { hasFailedQA: isFail, lastQAAt: qaComment.createdAt, buildRepo };
  } catch (e: any) {
    log(`Warning: QA status check failed for #${issueNumber}: ${e.message}`);
    return { hasFailedQA: false, buildRepo: null };
  }
}

/** Check whether the build repo has new commits since the last QA failure. */
export function hasBuildMovedSinceLastQA(
  buildRepo: string | null,
  lastQAAt: string | undefined,
  log: (m: string) => void,
): boolean {
  if (!lastQAAt) return true; // no prior QA timestamp — run it
  if (!buildRepo) {
    log(`No build repo URL found — assuming QA stalled (will not re-queue)`);
    return false;
  }
  try {
    const pushedAt = execSync(`gh api repos/${buildRepo} --jq .pushed_at 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 10000,
    })
      .trim()
      .replace(/"/g, '');
    return new Date(pushedAt) > new Date(lastQAAt);
  } catch {
    log(`Could not reach build repo ${buildRepo} — assuming stalled`);
    return false;
  }
}

// ─── QAStation ────────────────────────────────────────────────────────────────

export class QAStation extends BaseStation {
  readonly id = 'qa';
  readonly label = 'station:provisioned';
  readonly nextLabel = 'station:qa';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 3; // Parallel QA safe — each agent tests its own PR/preview
  readonly ttl = 1800000; // 30 min

  /** Set when shouldProcess returns false due to build not moving — used by runner for stall tracking. */
  public lastQAInfo?: QAInfo;

  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    this.lastQAInfo = undefined;

    // 1. Base checks: skip/paused/phase2
    const base = await this.baseCheck(issue, ctx);
    if (base) return base;

    // 2. Manifest check (internal and change requests bypass)
    const manifest = this.manifestCheck(issue, ctx.env);
    if (manifest) return manifest;

    // 3. Auto-pass type:internal issues — runner performs the label flip
    if (issue.isInternal) {
      return {
        process: false,
        reason: 'type:internal — QA auto-pass handled by runner (no agent needed)',
      };
    }

    // 4. hasBuildMovedSinceLastQA stall guard
    const info = getLastQAInfo(issue.number, ctx.env.repo, ctx.log);
    this.lastQAInfo = info;

    if (info.hasFailedQA) {
      const moved = hasBuildMovedSinceLastQA(info.buildRepo, info.lastQAAt, ctx.log);
      if (!moved) {
        return {
          process: false,
          reason: `QA already failed and build repo unchanged since ${info.lastQAAt ?? 'last check'} — stalled, waiting for new commits`,
        };
      }
      ctx.log(`QA re-queuing for #${issue.number} — build repo has new commits since last QA failure`);
    }

    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    const SUPABASE_URL = ctx.env.supabaseUrl;
    const SUPABASE_SERVICE_KEY = ctx.env.supabaseKey;

    return {
      key: `qa-issue-${issue.number}`,
      station: 'qa',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: 'haiku',
      message: `You are a QA agent for the factory pipeline.
**Goal: Review the PR diff + smoke test the preview deploy in under 15 minutes. Fast pass/fail.**

═══ STEP 0: MARK STATION ACTIVE ═══

\`\`\`bash
curl -s -X PATCH \\
  "${ctx.env.supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${ctx.env.supabaseKey}" \\
  -H "Authorization: Bearer ${ctx.env.supabaseKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"station": "qa"}' || true
\`\`\`

═══ STEP 1: GET PR AND PREVIEW URL ═══

\`\`\`bash
# Read build complete comment to find PR and preview URL
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments | grep -E "PR:|Preview URL:|Build repo:" | head -5

# Extract PR URL and preview URL
BUILD_COMMENTS=$(gh issue view ${issue.number} --repo ${ctx.env.repo} --comments)
PR_URL=$(echo "$BUILD_COMMENTS" | grep -oP 'https://github\\.com/[\\w.-]+/[\\w.-]+/pull/\\d+' | head -1)
PREVIEW_URL=$(echo "$BUILD_COMMENTS" | grep -oP 'https://[a-z0-9-]+\\.vercel\\.app' | head -1)
BUILD_REPO=$(echo "$BUILD_COMMENTS" | grep -oP 'Build repo: https://github\\.com/\\K[\\w.-]+/[\\w.-]+' | head -1)
BRANCH_NAME=$(echo "$BUILD_COMMENTS" | grep -oP 'Branch: \\K[\\w./-]+' | head -1)

echo "PR: $PR_URL"
echo "Preview: $PREVIEW_URL"
echo "Build repo: $BUILD_REPO"
echo "Branch: $BRANCH_NAME"
\`\`\`

Set LIVE_URL to the Preview URL (NOT production). If no preview, fall back to production URL.
For internal issues, use: ${ctx.env.factoryAppUrl}

═══ STEP 1b: REVIEW PR DIFF ═══

\`\`\`bash
# Review the PR diff to understand what changed
if [ -n "$BUILD_REPO" ] && [ -n "$BRANCH_NAME" ]; then
  gh pr diff "$BRANCH_NAME" --repo "$BUILD_REPO" 2>/dev/null | head -200
  echo "---"
  gh pr view "$BRANCH_NAME" --repo "$BUILD_REPO" --json files --jq '.files[].path' 2>/dev/null
fi
\`\`\`

Note which files changed — focus your testing on the affected areas.

═══ STEP 2: HEALTH CHECK ═══

\`\`\`bash
curl -sf "$LIVE_URL/api/health" | jq . || echo "NO HEALTH ENDPOINT"
\`\`\`

If 500/503 → create [BLOCKED] issue, flip to station:blocked, stop.

═══ STEP 3: READ THE SPEC (quick scan) ═══

\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments | head -300
\`\`\`

Extract:
- The 3-5 MOST CRITICAL acceptance criteria (AC)
- Any explicit E2E test steps from the SPEC comment

═══ STEP 3b: READ REGRESSION MANIFEST ═══

\`\`\`bash
# Clone the build repo to read REGRESSION.md
if [ -n "$BUILD_REPO" ] && [ -n "$BRANCH_NAME" ]; then
  git clone --depth 1 --branch "$BRANCH_NAME" "https://github.com/$BUILD_REPO" /tmp/qa-repo-${issue.number} 2>/dev/null
  if [ -f /tmp/qa-repo-${issue.number}/REGRESSION.md ]; then
    echo "=== REGRESSION MANIFEST ==="
    cat /tmp/qa-repo-${issue.number}/REGRESSION.md
    echo "==========================="
    HAS_REGRESSION=1
  else
    echo "No REGRESSION.md found"
    HAS_REGRESSION=0
  fi
fi
\`\`\`

If REGRESSION.md exists, you MUST test EVERY feature listed — not just the new ones.
This is the full regression suite. Any failure = QA FAIL.

═══ STEP 4: SMOKE TEST ═══

\`\`\`bash
for route in / /dashboard /api/health; do
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$LIVE_URL$route" 2>/dev/null || echo "ERR")
  echo "$route" → "$STATUS"
done
\`\`\`

═══ STEP 4b: VISUAL QA WITH AGENT-BROWSER ═══

Use agent-browser to visually verify the live app against acceptance criteria.

\`\`\`bash
mkdir -p /tmp/qa-${issue.number}/screenshots

# Open the live app and wait for it to load
npx -y @ahmadmayo/agent-browser open "$LIVE_URL" && npx -y @ahmadmayo/agent-browser wait --load networkidle

# Take desktop screenshot
npx -y @ahmadmayo/agent-browser screenshot /tmp/qa-${issue.number}/screenshots/desktop-home.png

# Check for error states in the page content
SNAPSHOT=$(npx -y @ahmadmayo/agent-browser snapshot -i 2>/dev/null || echo "SNAPSHOT_FAILED")
echo "$SNAPSHOT"

# Check for critical errors
if echo "$SNAPSHOT" | grep -qi "application error\|500\|internal server error\|hydration"; then
  echo "CLIENT_SIDE_ERRORS_DETECTED" > /tmp/qa-${issue.number}-client-errors.txt
  echo "❌ CRITICAL: Error state detected in live app"
  CLIENT_SIDE_FAIL=1
else
  echo "CLIENT_SIDE_CHECK_PASS" > /tmp/qa-${issue.number}-client-errors.txt
  echo "✅ No error states detected"
  CLIENT_SIDE_FAIL=0
fi

# Mobile viewport check
npx -y @ahmadmayo/agent-browser set viewport 375 812
npx -y @ahmadmayo/agent-browser screenshot /tmp/qa-${issue.number}/screenshots/mobile-home.png
npx -y @ahmadmayo/agent-browser set viewport 1280 800
\`\`\`

Now walk through the key acceptance criteria using agent-browser:
- Use \`npx -y @ahmadmayo/agent-browser snapshot -i\` to discover interactive elements
- Use refs (@e1, @e2, etc.) to click buttons, fill forms, navigate
- Re-snapshot after each interaction to verify state changes
- Screenshot evidence for each AC: \`npx -y @ahmadmayo/agent-browser screenshot /tmp/qa-${issue.number}/screenshots/ac-<name>.png\`

\`\`\`bash
# Example interactive verification (adapt to actual ACs):
# npx -y @ahmadmayo/agent-browser snapshot -i        # Discover elements
# npx -y @ahmadmayo/agent-browser click @e3          # Click a button
# npx -y @ahmadmayo/agent-browser wait --load networkidle
# npx -y @ahmadmayo/agent-browser snapshot -i        # Verify result
# npx -y @ahmadmayo/agent-browser screenshot /tmp/qa-${issue.number}/screenshots/ac-navigation.png
\`\`\`

═══ STEP 4c: REGRESSION TEST (if REGRESSION.md exists) ═══

If HAS_REGRESSION=1, walk through EVERY test step in REGRESSION.md using agent-browser:

For each feature section in REGRESSION.md:
1. Navigate to the listed route
2. Execute each test step
3. Verify expected results
4. Screenshot evidence: \`npx -y @ahmadmayo/agent-browser screenshot /tmp/qa-${issue.number}/screenshots/regression-<feature>.png\`
5. Mark as PASS or FAIL

**ANY regression failure = entire QA FAILS.** Existing features MUST keep working.

\`\`\`bash
# Close browser when done
npx -y @ahmadmayo/agent-browser close
\`\`\`

═══ STEP 5: VERDICT ═══

**IMPORTANT:** If CLIENT_SIDE_FAIL=1, you MUST fail QA regardless of HTTP route results.

### IF ALL CRITICAL ACs PASS AND CLIENT_SIDE_FAIL=0:

\`\`\`bash
cat > /tmp/qa-report-${issue.number}.md << 'EOF'
## QA Report — #${issue.number}

**Result: ✅ PASS**

### Tested
- [list what you actually tested]

### Notes
- [any minor issues not worth blocking on]
EOF

gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "$(cat /tmp/qa-report-${issue.number}.md)"

# Approve the PR if we found one
if [ -n "$BUILD_REPO" ] && [ -n "$BRANCH_NAME" ]; then
  gh pr review "$BRANCH_NAME" --repo "$BUILD_REPO" --approve --body "✅ QA PASS — technical review approved. Forwarding to UAT for user acceptance testing." 2>/dev/null || echo "PR review failed (may need write access)"
fi

gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:qa" --remove-label "station:provisioned" --add-label "station:qa"

curl -s -X PATCH \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"station":"qa"}'

SUBMISSION_ID=$(curl -s \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}&select=id" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" | jq -r '.[0].id // empty')
if [ -n "$SUBMISSION_ID" ]; then
  curl -s -X POST "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
    -H "Content-Type: application/json" \\
    -H "x-factory-secret: ${ctx.env.factorySecret}" \\
    -d '{"type":"status_update","content":"QA passed — preparing for delivery.","payload":{"station":"qa","issueNumber":${issue.number}}}' 2>/dev/null || true
fi
\`\`\`

### IF CRITICAL ACs FAIL OR CLIENT_SIDE_FAIL=1:

\`\`\`bash
gh issue create --repo ${ctx.env.repo} \\
  --title "[BUG] #${issue.number}: <one line description>" \\
  --body "**Parent:** #${issue.number}
**AC failed:** AC-XXX.X
**File/Route:** (e.g. app/api/payments/route.ts)
**Missing packages:** (any npm install needed?)
**Console/server errors:** (paste exact error)
**Steps to reproduce:** ...
**Expected:** ...
**Actual:** ..." \\
  --label "type:bug" --label "station:intake"

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:qa" --remove-label "station:provisioned" --add-label "station:bugfix"
\`\`\`

**Time limit: 15 minutes total. Stop after 15 min regardless of completion status.**`,
    };
  }
}
