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
  readonly label = 'station:build';
  readonly nextLabel = 'station:qa';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 1; // Rate limit safety — max 1 concurrent QA
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
**Goal: Smoke test the live app in under 15 minutes. Fast pass/fail. No gold-plating.**

═══ STEP 1: GET LIVE URL ═══

\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments | grep -E "https://[a-z0-9-]+\\.vercel\\.app" | head -3
\`\`\`

Set LIVE_URL to the Vercel URL from the BUILD COMPLETE comment.

For internal issues (no LIVE_URL), use: ${ctx.env.factoryAppUrl}

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

═══ STEP 4: SMOKE TEST ═══

\`\`\`bash
for route in / /dashboard /api/health; do
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$LIVE_URL$route" 2>/dev/null || echo "ERR")
  echo "$route → $STATUS"
done
\`\`\`

═══ STEP 4b: VISUAL QA CHECKS (AC-003.1/2) ═══

\`\`\`bash
mkdir -p /tmp/qa-${issue.number}/screenshots
BUILD_DIR=$(ls -d /tmp/*build* 2>/dev/null | head -1)

if [ -n "$BUILD_DIR" ]; then
  EMOJI_COUNT=$(grep -rP "[\\x{1F300}-\\x{1F9FF}\\x{2600}-\\x{26FF}]" "$BUILD_DIR/app/" --include="*.tsx" 2>/dev/null | grep -v "//\|test\|spec" | wc -l)
  echo "Emoji in JSX: $EMOJI_COUNT (must be 0)"
  HEX_IN_CLASS=$(grep -r 'className.*#[0-9a-fA-F]' "$BUILD_DIR/app/" --include="*.tsx" 2>/dev/null | grep -v test | wc -l)
  echo "Hardcoded hex in className: $HEX_IN_CLASS (should be 0)"
  MOTION_USAGE=$(grep -r "motion\\." "$BUILD_DIR/app/" --include="*.tsx" 2>/dev/null | wc -l)
  echo "framer-motion usages: $MOTION_USAGE (should be > 5)"
fi
\`\`\`

\`\`\`bash
npx playwright install chromium --with-deps 2>/dev/null | tail -3

node -e "
const { chromium } = require('playwright');
(async () => {
  const LIVE = process.env.LIVE_URL || '$LIVE_URL';
  const ISSUE = '${issue.number}';
  const fs = require('fs');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  let pageErrors = [];
  let consoleErrors = [];
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', err => pageErrors.push(err.message || String(err)));
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('Download the React DevTools') && !text.includes('DevTools')) {
          consoleErrors.push(text);
        }
      }
    });
    try {
      await page.goto(LIVE, { timeout: 20000, waitUntil: 'networkidle' });
      const bodyText = await page.textContent('body').catch(() => '');
      const hasAppError = bodyText.includes('Application error') || bodyText.includes('application error');
      const hasHydrationError = bodyText.includes('Hydration failed') || bodyText.includes('did not match');
      const hasMissingEnv = pageErrors.some(e => e.includes('NEXT_PUBLIC_') || e.includes('expected string, received undefined') || e.includes('ZodError'));
      const criticalErrors = pageErrors.length + consoleErrors.length;
      if (hasAppError || hasHydrationError || hasMissingEnv || criticalErrors > 0) {
        const result = 'CLIENT_SIDE_ERRORS_DETECTED\\n' +
          (pageErrors.length ? 'PAGE_ERRORS: ' + JSON.stringify(pageErrors.slice(0,3)) + '\\n' : '') +
          (consoleErrors.length ? 'CONSOLE_ERRORS: ' + JSON.stringify(consoleErrors.slice(0,3)) + '\\n' : '') +
          (hasAppError ? 'HAS_APP_ERROR_OVERLAY: true\\n' : '') +
          (hasHydrationError ? 'HAS_HYDRATION_ERROR: true\\n' : '') +
          (hasMissingEnv ? 'MISSING_ENV_VARS: true — check NEXT_PUBLIC_* in Vercel\\n' : '');
        fs.writeFileSync('/tmp/qa-\${ISSUE}-client-errors.txt', result);
        console.log(result);
      } else {
        fs.writeFileSync('/tmp/qa-\${ISSUE}-client-errors.txt', 'CLIENT_SIDE_CHECK_PASS');
        console.log('CLIENT_SIDE_CHECK_PASS');
      }
    } catch(e) {
      console.log('CLIENT_SIDE_CHECK_FAILED: ' + e.message);
      fs.writeFileSync('/tmp/qa-\${ISSUE}-client-errors.txt', 'CLIENT_SIDE_CHECK_FAILED: ' + e.message);
    }
    await ctx.close();
  }

  for (const [name, w, h] of [['mobile', 375, 812], ['desktop', 1280, 800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    try {
      await page.goto(LIVE, { timeout: 15000, waitUntil: 'networkidle' });
      await page.screenshot({ path: \`/tmp/qa-\${ISSUE}/screenshots/\${name}-home.png\` });
      console.log(\`\${name} screenshot saved\`);
    } catch(e) { console.log(\`\${name} screenshot failed: \${e.message}\`); }
    await ctx.close();
  }
  await browser.close();
})();
" 2>/dev/null || echo "Playwright check failed — manual check required"

if grep -q "CLIENT_SIDE_ERRORS_DETECTED" /tmp/qa-${issue.number}-client-errors.txt 2>/dev/null; then
  echo "❌ CRITICAL: Client-side JavaScript errors detected"
  cat /tmp/qa-${issue.number}-client-errors.txt 2>/dev/null
  CLIENT_SIDE_FAIL=1
else
  echo "✅ Client-side check passed"
  CLIENT_SIDE_FAIL=0
fi
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
gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:qa" --remove-label "station:build" --add-label "station:done"

curl -s -X PATCH \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"station":"done"}'
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
  --label "type:bug"

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:qa" --remove-label "station:build" --add-label "station:bugfix"
\`\`\`

**Time limit: 15 minutes total. Stop after 15 min regardless of completion status.**`,
    };
  }
}
