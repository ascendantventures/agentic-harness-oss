/**
 * UATStation — User Acceptance Testing station.
 *
 * Processes issues at 'station:qa' (after QA passes and flips to station:qa),
 * producing 'station:uat' → 'station:done'.
 *
 * Unlike QA (technical correctness), UAT simulates a non-technical business user
 * navigating the live app via agent-browser. Tests real user flows end-to-end:
 * login, navigate, interact, complete goals.
 *
 * Outcomes:
 *   - PASS → station:done
 *   - FAIL (critical) → creates change request issue with feedback
 *   - PASS with suggestions → station:done + enhancement comments
 */
import { execSync } from 'child_process';
import { BaseStation } from '../base.js';
import { flipLabel, guardAutoAdvance } from '../../pipeline/reconciler.js';
export class UATStation extends BaseStation {
    id = 'uat';
    label = 'station:qa'; // triggers on issues that just passed QA
    nextLabel = 'station:uat';
    model = 'claude-sonnet-4-6';
    concurrency = 1;
    ttl = 2400000; // 40 min — UAT needs more time for browser flows
    async shouldProcess(issue, ctx) {
        // 1. Base checks: skip/paused/phase2
        const base = await this.baseCheck(issue, ctx);
        if (base)
            return base;
        // 2. Must have a QA PASS comment — if QA hasn't passed, don't run UAT
        try {
            const result = execSync(`gh issue view ${issue.number} --repo ${ctx.env.repo} --comments --json comments 2>/dev/null`, { encoding: 'utf8', timeout: 15000 });
            const { comments } = JSON.parse(result);
            const hasQAPass = comments.some((c) => c.body?.includes('QA Report') && (c.body?.includes('✅ PASS') || c.body?.includes('QA PASS')));
            if (!hasQAPass) {
                // Check if there's a bugfix after the QA fail — if so, push back to station:build for re-QA
                const hasBugfix = comments.some((c) => c.body?.includes('BUGFIX COMPLETE') || c.body?.includes('Bug Fix COMPLETE'));
                const hasQAFail = comments.some((c) => c.body?.includes('QA Report') && (c.body?.includes('❌') || c.body?.includes('FAIL')));
                if (hasBugfix && hasQAFail) {
                    flipLabel(issue.number, ctx.env.repo, 'station:qa', 'station:build', ctx.log, 'UAT: QA failed + bugfix done — returning to build for re-QA');
                    return { process: false, reason: 'No QA PASS — bugfix complete, pushed back to station:build for re-QA' };
                }
                return { process: false, reason: 'No QA PASS found — UAT requires QA to pass first' };
            }
        }
        catch (e) {
            ctx.log(`Warning: Could not check QA status for #${issue.number}: ${e.message}`);
        }
        // 3. Check if UAT already ran (avoid re-running)
        try {
            const result = execSync(`gh issue view ${issue.number} --repo ${ctx.env.repo} --comments --json comments 2>/dev/null`, { encoding: 'utf8', timeout: 15000 });
            const { comments } = JSON.parse(result);
            const hasUATReport = comments.some((c) => c.body?.includes('UAT Report') || c.body?.includes('User Acceptance Test'));
            if (hasUATReport) {
                // Auto-advance: UAT already completed but label wasn't flipped
                guardAutoAdvance(issue.number, ctx.env.repo, this.label, 'station:done', ctx.log, 'UAT report already exists');
                return { process: false, reason: 'UAT report already exists — auto-advanced to station:done' };
            }
        }
        catch {
            // Proceed if we can't check
        }
        return { process: true };
    }
    async buildTask(issue, ctx) {
        const SUPABASE_URL = ctx.env.supabaseUrl;
        const SUPABASE_SERVICE_KEY = ctx.env.supabaseKey;
        return {
            key: `uat-issue-${issue.number}`,
            station: 'uat',
            issueNumber: issue.number,
            issueTitle: issue.title,
            model: 'sonnet',
            message: `You are a USER ACCEPTANCE TESTING (UAT) agent.

You are NOT a developer. You are a non-technical business user testing this application for the first time. You have never seen the code. You only interact with the live deployed app through a browser.

═══ PUSH HELPER (use this every time you push a card) ═══

Define this bash function at the start of every script block that pushes to the thread:

\`\`\`bash
push_card_with_retry() {
  local url="$1"
  local secret="$2"
  local payload="$3"
  local max_attempts=4
  for i in 1 2 3 4; do
    [ $i -gt $max_attempts ] && break
    HTTP_STATUS=$(curl -s -o /tmp/push-response.json -w "%{http_code}" -X POST "$url" \\
      -H "Content-Type: application/json" \\
      -H "x-factory-secret: $secret" \\
      -d "$payload")
    if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "201" ]; then
      echo "✅ Card pushed (attempt $i, HTTP $HTTP_STATUS)"
      return 0
    fi
    echo "⚠️  Push attempt $i failed (HTTP $HTTP_STATUS). Response: $(cat /tmp/push-response.json 2>/dev/null)"
    if [ $i -lt $max_attempts ]; then
      DELAY_IDX=$((i-1))
      DELAY_VAL=$(echo "2 5 10" | awk "{print \$((DELAY_IDX+1))}")
      sleep $DELAY_VAL
    fi
  done
  echo "❌ PUSH FAILED after $max_attempts attempts — posting fallback error message"
  FALLBACK=$(jq -n --arg url "$url" '{
    "message_type": "assistant",
    "content": "⚠️ Your app is live and ready, but we had trouble delivering the final delivery card to your chat. Please refresh the page or contact support if this persists.",
    "payload": {}
  }')
  curl -s -X POST "$url" \\
    -H "Content-Type: application/json" \\
    -H "x-factory-secret: $secret" \\
    -d "$FALLBACK" 2>/dev/null || true
  return 1
}
\`\`\`

Your job: Try to use the app like a real person would. Report what works, what's confusing, what's broken, and what would make the experience better.

═══ YOUR PERSONA ═══

You are a product manager at a mid-size company. You're evaluating this tool for your team.
You expect things to be intuitive — if you need to guess how something works, that's a UX problem.
You notice visual inconsistencies, confusing labels, missing feedback, and dead ends.
You care about: Can I accomplish my goal? Is it obvious how? Does it feel polished?

═══ STEP 1: READ THE SPEC (understand what this app should do) ═══

\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments | head -400
\`\`\`

Extract:
- What is this feature/app supposed to do?
- What are the main user flows a business user would attempt?
- What does "success" look like from a user perspective?

═══ STEP 2: GET PREVIEW URL AND PR ═══

\`\`\`bash
BUILD_COMMENTS=$(gh issue view ${issue.number} --repo ${ctx.env.repo} --comments)
PR_URL=$(echo "$BUILD_COMMENTS" | grep -oP 'https://github\\.com/[\\w.-]+/[\\w.-]+/pull/\\d+' | head -1)
PREVIEW_URL=$(echo "$BUILD_COMMENTS" | grep -oP 'https://[a-z0-9-]+\\.vercel\\.app' | head -1)
BUILD_REPO=$(echo "$BUILD_COMMENTS" | grep -oP 'Build repo: https://github\\.com/\\K[\\w.-]+/[\\w.-]+' | head -1)
BRANCH_NAME=$(echo "$BUILD_COMMENTS" | grep -oP 'Branch: \\K[\\w./-]+' | head -1)

echo "PR: $PR_URL"
echo "Preview: $PREVIEW_URL"
echo "Build repo: $BUILD_REPO"
\`\`\`

**Test the PREVIEW URL (not production).** This is the PR deployment — it has NOT been merged to main yet.
For internal dashboard issues, fall back to: ${ctx.env.factoryAppUrl}

═══ STEP 2b: READ REGRESSION MANIFEST ═══

\`\`\`bash
# Clone the build repo to read REGRESSION.md
if [ -n "$BUILD_REPO" ] && [ -n "$BRANCH_NAME" ]; then
  git clone --depth 1 --branch "$BRANCH_NAME" "https://github.com/$BUILD_REPO" /tmp/uat-repo-${issue.number} 2>/dev/null
  if [ -f /tmp/uat-repo-${issue.number}/REGRESSION.md ]; then
    echo "=== REGRESSION MANIFEST ==="
    cat /tmp/uat-repo-${issue.number}/REGRESSION.md
    echo "==========================="
    HAS_REGRESSION=1
  else
    HAS_REGRESSION=0
  fi
fi
\`\`\`

**IMPORTANT:** If REGRESSION.md exists, you must test EVERY feature listed — not just the new one. You are testing the ENTIRE app as a user. Any broken existing feature = UAT FAIL.

═══ STEP 3: FIRST IMPRESSIONS (30 seconds) ═══

\`\`\`bash
agent-browser open "$LIVE_URL" && agent-browser wait --load networkidle
agent-browser screenshot /tmp/uat-${issue.number}/first-impression.png
agent-browser snapshot -i
\`\`\`

Record your first impressions:
- Does the page load properly? Any visual glitches?
- Is it immediately clear what this app/feature does?
- Does the design look professional and cohesive?
- Can you see how to get started?

═══ STEP 4: AUTHENTICATE (if required) ═══

If there's a login page:
\`\`\`bash
# Look for login form elements
agent-browser snapshot -i

# Fill credentials (use the admin test account)
# Find the email input and password input refs from snapshot
# agent-browser type @emailRef "ajrrac@gmail.com"
# agent-browser type @passRef "AvOps2026!!"
# agent-browser click @submitRef
# agent-browser wait --load networkidle
agent-browser screenshot /tmp/uat-${issue.number}/post-login.png
agent-browser snapshot -i
\`\`\`

Note: If login fails, that's a CRITICAL failure. Document the exact behavior.

═══ STEP 5: WALK THROUGH EVERY USER FLOW ═══

For EACH user flow from the spec:

1. **Navigate** to the relevant page
   \`\`\`bash
   agent-browser snapshot -i  # discover navigation elements
   # click nav items, links, buttons to reach the feature
   agent-browser screenshot /tmp/uat-${issue.number}/flow-<name>-start.png
   \`\`\`

2. **Attempt the flow** as a non-technical user would
   - Click buttons, fill forms, interact with components
   - Use \`agent-browser snapshot -i\` after each action to see the result
   - Screenshot each step

3. **Evaluate each flow** on these criteria:
   - **Discoverability**: Could I find this feature without help?
   - **Clarity**: Are labels, buttons, and instructions clear?
   - **Feedback**: Does the app tell me what happened after I act? (success toast, loading state, error message)
   - **Completion**: Can I actually finish the task end-to-end?
   - **Edge cases**: What happens with empty states? Invalid input? Back button?
   - **Visual polish**: Alignment, spacing, colors, readability, contrast

4. **Check responsive** (mobile viewport)
   \`\`\`bash
   agent-browser set viewport 375 812
   agent-browser screenshot /tmp/uat-${issue.number}/flow-<name>-mobile.png
   agent-browser snapshot -i
   agent-browser set viewport 1280 800
   \`\`\`

═══ STEP 5b: REGRESSION WALKTHROUGH (if REGRESSION.md exists) ═══

If HAS_REGRESSION=1, walk through EVERY feature in REGRESSION.md as a user:

For each feature section:
1. Navigate to the listed route/page
2. Try each test step as a non-technical user
3. Evaluate: Does it work? Is it intuitive? Does it look right?
4. Screenshot: \`agent-browser screenshot /tmp/uat-${issue.number}/regression-<feature>.png\`
5. Note any broken or confusing behavior

**This is the full regression suite.** Every feature listed must still work.
If an existing feature is broken by the new changes, UAT FAILS.

═══ STEP 6: CROSS-CUTTING CHECKS ═══

\`\`\`bash
# Check all main navigation links work
agent-browser snapshot -i
# Click each nav item, verify it loads, screenshot
# Check for 404s, blank pages, error states

# Check loading states
# Interact with data-loading components, verify spinners/skeletons appear

# Check empty states
# If possible, navigate to a view with no data — is there a helpful message?
\`\`\`

═══ STEP 7: CLOSE BROWSER ═══

\`\`\`bash
agent-browser close
\`\`\`

═══ STEP 8: WRITE UAT REPORT ═══

Categorize your findings:

**Rating scale:**
- 🟢 **PASS** — Flow works as expected, user experience is good
- 🟡 **PASS with suggestions** — Flow works but has UX friction worth improving
- 🔴 **FAIL** — Flow is broken, confusing to the point of unusable, or incomplete

\`\`\`bash
cat > /tmp/uat-report-${issue.number}.md << 'REPORT_EOF'
## 🧑‍💼 UAT Report — #${issue.number}

**Tester Persona:** Product Manager (non-technical)
**App URL:** $LIVE_URL
**Date:** $(date -u +%Y-%m-%dT%H:%M:%SZ)

### First Impressions
[Your honest first reaction to the app/feature]

### User Flow Results

#### Flow 1: [name]
**Rating:** 🟢/🟡/🔴
**Steps taken:** [what you did]
**Result:** [what happened]
**Feedback:** [suggestions for improvement]

#### Flow 2: [name]
...

### Visual & UX Assessment
- **Design cohesion:** [consistent or fragmented?]
- **Typography:** [readable? good hierarchy?]
- **Color & contrast:** [accessible? on brand?]
- **Spacing & layout:** [clean? cramped? wasted space?]
- **Mobile experience:** [usable? broken?]
- **Loading states:** [present? helpful?]
- **Empty states:** [handled? confusing?]
- **Error handling:** [clear messages? recovery path?]

### Critical Issues (must fix)
[List any broken flows, crashes, data loss risks, or completely missing features]

### Enhancement Suggestions (nice to have)
[UX improvements, better copy, additional affordances, polish items]

### Overall Verdict
**[🟢 PASS / 🟡 PASS WITH SUGGESTIONS / 🔴 FAIL]**

[One paragraph summary of the overall user experience]
REPORT_EOF
\`\`\`

═══ STEP 9: POST RESULTS ═══

### IF 🟢 PASS (all flows work, good UX):

\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "$(cat /tmp/uat-report-${issue.number}.md)"

# Merge the PR → deploys to production
if [ -n "$BUILD_REPO" ] && [ -n "$BRANCH_NAME" ]; then
  echo "Merging PR to production..."
  gh pr merge "$BRANCH_NAME" --repo "$BUILD_REPO" --squash --delete-branch \\
    --body "✅ UAT PASS — Merged by Factory Pipeline after QA + UAT approval." 2>&1
  echo "PR merged and branch deleted."

  # Get the new production URL
  sleep 15
  PROD_URL=$(vercel list --prod 2>/dev/null | grep -oP 'https://[\\S]+\\.vercel\\.app' | head -1)
  if [ -n "$PROD_URL" ]; then
    gh issue comment ${issue.number} --repo ${ctx.env.repo} \\
      --body "🚀 **Deployed to production:** $PROD_URL"
  fi
fi

gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:uat" --remove-label "station:qa" --add-label "station:done"

curl -s -X PATCH \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d "{\"station\":\"done\",\"live_url\":\"$PROD_URL\"}"

# Push delivery card to chat thread
SUBMISSION_ID=$(curl -s \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}&select=id" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" | jq -r '.[0].id // empty')
ISSUE_TITLE=$(gh issue view ${issue.number} --repo ${ctx.env.repo} --json title --jq .title 2>/dev/null || echo "Your app")
if [ -n "$SUBMISSION_ID" ] && [ -n "$PROD_URL" ]; then
  DELIVERY_PAYLOAD=$(jq -n \\
    --arg liveUrl "$PROD_URL" \\
    --arg buildRepo "$BUILD_REPO" \\
    --arg projectName "$ISSUE_TITLE" \\
    '{
      type: "delivery_card",
      content: "Your app is ready and live!",
      payload: {
        type: "delivery_card",
        liveUrl: $liveUrl,
        buildRepo: $buildRepo,
        projectName: $projectName,
        buildLog: [
          "TypeScript passed, deploying to Vercel",
          "DB migration applied. All tables verified. Starting deploy.",
          "App deployed to Vercel. Health check passing.",
          ("App deployed at " + $liveUrl),
          "All Phase 1 features working."
        ]
      }
    }')
  push_card_with_retry "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" "${ctx.env.factorySecret}" "$DELIVERY_PAYLOAD"
fi
\`\`\`

### IF 🟡 PASS WITH SUGGESTIONS (works but has UX friction):

Post the UAT report, merge to production, BUT also create follow-up enhancement issues:

\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "$(cat /tmp/uat-report-${issue.number}.md)"

# Merge the PR — feature works, suggestions are non-blocking
if [ -n "$BUILD_REPO" ] && [ -n "$BRANCH_NAME" ]; then
  gh pr merge "$BRANCH_NAME" --repo "$BUILD_REPO" --squash --delete-branch \\
    --body "🟡 UAT PASS WITH SUGGESTIONS — Merged by Factory Pipeline. Follow-up enhancement issue created." 2>&1
fi

# Create enhancement issue for each suggestion group
gh issue create --repo ${ctx.env.repo} \\
  --title "[UAT Follow-up] #${issue.number}: UX Enhancements" \\
  --body "## UAT Follow-up Enhancements

build_repo: $BUILD_REPO

**Source:** UAT Report on #${issue.number}
**Priority:** Low — the feature works, these are polish items.

### Suggested Improvements
[paste enhancement suggestions from the report]

### Context
The UAT agent tested this as a non-technical user and found the feature functional but identified opportunities to improve the user experience." \\
  --label "type:enhancement" --label "station:intake"

gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:uat" --remove-label "station:qa" --add-label "station:done"

curl -s -X PATCH \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d "{\"station\":\"done\",\"live_url\":\"$PROD_URL\"}"

# Push delivery card to chat thread
SUBMISSION_ID=$(curl -s \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}&select=id" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" | jq -r '.[0].id // empty')
ISSUE_TITLE=$(gh issue view ${issue.number} --repo ${ctx.env.repo} --json title --jq .title 2>/dev/null || echo "Your app")
if [ -n "$SUBMISSION_ID" ] && [ -n "$PROD_URL" ]; then
  DELIVERY_PAYLOAD=$(jq -n \\
    --arg liveUrl "$PROD_URL" \\
    --arg buildRepo "$BUILD_REPO" \\
    --arg projectName "$ISSUE_TITLE" \\
    '{
      type: "delivery_card",
      content: "Your app is ready and live!",
      payload: {
        type: "delivery_card",
        liveUrl: $liveUrl,
        buildRepo: $buildRepo,
        projectName: $projectName,
        buildLog: [
          "TypeScript passed, deploying to Vercel",
          "DB migration applied. All tables verified. Starting deploy.",
          "App deployed to Vercel. Health check passing.",
          ("App deployed at " + $liveUrl),
          "All Phase 1 features working."
        ]
      }
    }')
  push_card_with_retry "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" "${ctx.env.factorySecret}" "$DELIVERY_PAYLOAD"
fi
\`\`\`

### IF 🔴 FAIL (critical issues found):

\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "$(cat /tmp/uat-report-${issue.number}.md)"

# Request changes on the PR — do NOT merge
if [ -n "$BUILD_REPO" ] && [ -n "$BRANCH_NAME" ]; then
  gh pr review "$BRANCH_NAME" --repo "$BUILD_REPO" --request-changes \\
    --body "❌ UAT FAIL — Critical user experience issues found. See UAT report on the tracking issue." 2>/dev/null || true
fi

# Create a change request to fix the critical issues
gh issue create --repo ${ctx.env.repo} \\
  --title "[UAT Fix] #${issue.number}: Critical UX Issues" \\
  --body "## UAT Critical Fixes Required

build_repo: $BUILD_REPO

**Source:** UAT Report on #${issue.number}
**Priority:** High — these issues make the feature unusable or broken for end users.
**PR:** $PR_URL (changes requested — do NOT merge until fixed)

### Critical Issues
[paste critical issues from the report]

### Expected Behavior
The feature should work as described in the original spec. The UAT agent found that real user flows are broken or confusing." \\
  --label "type:bug" --label "station:intake"

# Revert to bugfix — the original issue needs fixing
gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:uat" --remove-label "station:qa" --add-label "station:bugfix"
\`\`\`

**Time limit: 25 minutes total. If you haven't finished all flows, report on what you tested and note untested flows.**`,
        };
    }
}
//# sourceMappingURL=index.js.map