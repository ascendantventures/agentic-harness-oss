/**
 * BuildStation — processes issues at 'station:design', produces 'station:build'.
 *
 * Gates:
 *  1. Base checks (skip/paused/phase2)
 *  2. Manifest check
 *  3. spec_approved gate
 *  4. hasDesignComment (if not, re-spawn design)
 *  5. checkDesignQuality (if fails, reject design back to spec)
 */

import type { Issue, AgentTask, TemplateConfig } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
import { hasDesignComment, checkDesignQuality, extractBuildRepo, extractSubmissionId } from '../../github/issues.js';
import { isSpecApproved, getSubmissionForIssue } from '../../notify/supabase.js';
import { guardAutoAdvance } from '../../pipeline/reconciler.js';

// ─── Default template registry (overridable via config.templates) ────────────

export const DEFAULT_TEMPLATE_REGISTRY: Record<string, TemplateConfig> = {
  'nextjs-supabase-vercel': {
    repo: 'your-org/template-nextjs-supabase-vercel',
    deployTarget: 'vercel',
    matchStacks: ['next.js', 'nextjs', 'react', 'vue', 'nuxt', 'react.js'],
    matchTypes: ['landing_page', 'saas', 'web_app', 'portfolio', 'dashboard', 'ecommerce'],
  },
  'expo-supabase-eas': {
    repo: 'your-org/template-expo-supabase-eas',
    deployTarget: 'eas',
    matchStacks: ['expo', 'react native', 'react-native', 'mobile'],
    matchTypes: ['mobile_app', 'mobile'],
  },
  'fastapi-supabase-railway': {
    repo: 'your-org/template-fastapi-supabase-railway',
    deployTarget: 'railway',
    matchStacks: ['fastapi', 'python', 'django', 'flask', 'rails', 'go'],
    matchTypes: ['api', 'backend', 'ml_api'],
  },
};

/**
 * Build the effective template registry by merging config overrides with defaults.
 * If config.templates.entries is set, those repos are used; otherwise defaults apply.
 */
export function getTemplateRegistry(ctx: FactoryContext): Record<string, TemplateConfig> {
  const configTemplates = ctx.config.templates?.entries;
  if (!configTemplates) return DEFAULT_TEMPLATE_REGISTRY;

  // Merge: config entries override defaults by key
  const merged = { ...DEFAULT_TEMPLATE_REGISTRY };
  for (const [key, val] of Object.entries(configTemplates)) {
    merged[key] = val;
  }
  return merged;
}

/** Get the configured GitHub owner for repos (from config.templates.owner or GITHUB_REPO) */
function getRepoOwner(ctx: FactoryContext): string {
  if (ctx.config.templates?.owner) return ctx.config.templates.owner;
  // Fall back to the owner portion of GITHUB_REPO
  return ctx.env.repo.split('/')[0] ?? 'your-org';
}

export function resolveTemplate(
  techStack: string | string[] | undefined,
  projectType: string | undefined,
  registry: Record<string, TemplateConfig> = DEFAULT_TEMPLATE_REGISTRY,
): string {
  const stacks = (Array.isArray(techStack) ? techStack : [techStack ?? '']).map((s) =>
    s.toLowerCase().trim(),
  );
  const type = (projectType ?? '').toLowerCase();

  if (
    stacks.some((s) => registry['expo-supabase-eas']?.matchStacks.includes(s)) ||
    registry['expo-supabase-eas']?.matchTypes.includes(type)
  )
    return 'expo-supabase-eas';

  if (
    stacks.some((s) => registry['fastapi-supabase-railway']?.matchStacks.includes(s)) ||
    registry['fastapi-supabase-railway']?.matchTypes.includes(type)
  )
    return 'fastapi-supabase-railway';

  return 'nextjs-supabase-vercel'; // default
}

// ─── BuildStation ─────────────────────────────────────────────────────────────

export class BuildStation extends BaseStation {
  readonly id = 'build';
  readonly label = 'station:design';
  readonly nextLabel = 'station:build';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 3; // Feature branches enable safe parallel builds
  readonly ttl = 7200000; // 2 hours

  /**
   * Returned when design quality fails or design is missing.
   * Caller (runner.ts) must handle these side-effects.
   */
  public designAction?: {
    action: 'respawn-design' | 'reject-design' | 'pause-design';
    issueNumber: number;
    reason?: string;
  };

  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    // Reset side-effect state
    this.designAction = undefined;

    // 1. Base checks: skip/paused/phase2
    const base = await this.baseCheck(issue, ctx);
    if (base) return base;

    // 2. Manifest check
    const manifest = this.manifestCheck(issue, ctx.env);
    if (manifest) return manifest;

    // 3. spec_approved gate
    const standaloneMode = !ctx.env.supabaseUrl;
    if (!issue.isInternal && !issue.isChangeRequest && !standaloneMode) {
      const approved = await isSpecApproved(issue.number, ctx.env.supabaseUrl, ctx.env.supabaseKey, ctx.log);
      if (!approved) {
        return { process: false, reason: `spec not approved by client yet` };
      }
    }

    // 4. Design comment check — if missing, skip (design station will handle it)
    //    Do NOT revert the label here — that creates a race with the design station
    //    which also processes station:design issues. The periodic sweep (Layer 3) will
    //    catch genuinely stuck issues.
    const designDone = hasDesignComment(issue.number, ctx.env.repo);
    if (!designDone) {
      return { process: false, reason: 'DESIGN.md not yet posted — waiting for design agent' };
    }

    // 5. Design quality gate — if incomplete, push back to station:spec for re-design
    const qualityCheck = checkDesignQuality(issue.number, ctx.env.repo, ctx.log);
    if (!qualityCheck.ok) {
      this.designAction = {
        action: 'reject-design',
        issueNumber: issue.number,
        reason: qualityCheck.reason,
      };
      // Self-heal: push back to station:spec so Design agent re-runs with full output
      guardAutoAdvance(
        issue.number, ctx.env.repo, 'station:design', 'station:spec', ctx.log,
        `Design quality gate failed — reverting to station:spec (${qualityCheck.reason})`,
      );
      return {
        process: false,
        reason: `Design quality gate failed — reverted to station:spec: ${qualityCheck.reason}`,
      };
    }

    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    const templateRegistry = getTemplateRegistry(ctx);
    const owner = getRepoOwner(ctx);

    // ─── Change Request: skip template, clone existing build repo ────────────
    if (issue.isChangeRequest) {
      return this.buildChangeRequestTask(issue, ctx, owner);
    }

    // ─── Internal feature build: clone main repo, open PR ───────────────────
    if (issue.isInternal) {
      return this.buildInternalTask(issue, ctx, owner);
    }

    // ─── Standard new-project build ──────────────────────────────────────────
    return this.buildStandardTask(issue, ctx, templateRegistry, owner);
  }

  private async buildChangeRequestTask(issue: Issue, ctx: FactoryContext, owner: string): Promise<AgentTask> {
    const buildRepo = issue.buildRepo ?? extractBuildRepo(issue.body);
    const submissionId = issue.submissionId ?? extractSubmissionId(issue.body);

    if (!buildRepo) {
      throw new Error(
        `Change request issue #${issue.number} is missing build_repo in body — cannot create BUILD task`,
      );
    }

    const repoName = buildRepo.split('/')[1];
    const SUPABASE_URL = ctx.env.supabaseUrl;
    const SUPABASE_SERVICE_KEY = ctx.env.supabaseKey;

    return {
      key: `build-issue-${issue.number}`,
      station: 'build',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: 'sonnet',
      message: `You are a BUILD agent for the factory pipeline.

This is a CHANGE REQUEST on an existing live project. Do NOT scaffold from a template.
Clone the existing build repo and apply the requested changes.

## Step 0 — Mark station as active (run immediately)

\`\`\`bash
curl -s -X PATCH \\
  "${ctx.env.supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${ctx.env.supabaseKey}" \\
  -H "Authorization: Bearer ${ctx.env.supabaseKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"station": "build"}' || true
\`\`\`

## Steps

### 1. Read the change request spec
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

Extract:
- Summary of what the client wants changed
- Change type (design / bugfix / feature)
- Any details or context provided

### 2. Clone EXISTING build repo + create feature branch
\`\`\`bash
CLONE_URL=$(curl -s -X POST ${ctx.env.factoryAppUrl}/api/github/clone-token \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: $FACTORY_SECRET" \\
  -d '{"owner": "${owner}", "repo": "${repoName}"}' | jq -r .clone_url)

git clone "$CLONE_URL" /tmp/build-work
cd /tmp/build-work
git remote set-url origin "$CLONE_URL"
BRANCH_NAME="feature/issue-${issue.number}"
git checkout -b "$BRANCH_NAME"
\`\`\`

### 2b. Read CLAUDE.md (project memory — CRITICAL)
\`\`\`bash
if [ -f CLAUDE.md ]; then
  echo "=== PROJECT CONTEXT ==="
  cat CLAUDE.md
  echo "======================="
fi
\`\`\`
**If CLAUDE.md exists, READ IT FIRST.** It contains architecture decisions, known gotchas, env vars, and key file locations from the original build. Follow its guidance.

### 3. Extract DESIGN.md from the issue (change-focused spec)
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments \\
  | grep -A 2000 "Design Philosophy" | head -500 > /tmp/design-issue-${issue.number}.md
cat /tmp/design-issue-${issue.number}.md
\`\`\`

If no DESIGN.md comment exists, derive the change from the issue title and details.

### 3b. Check for existing overlapping features (DEDUPLICATION)
\`\`\`bash
cd /tmp/build-work
# List existing components and pages
find src/components -name "*.tsx" 2>/dev/null | sort
find src/app -name "page.tsx" 2>/dev/null | sort
# Search for features that might overlap with this change
grep -rl "$(echo '${issue.title}' | tr ' ' '\\n' | grep -E '^[A-Z]' | head -3 | tr '\\n' '\\|' | sed 's/|$//')" src/ --include="*.tsx" 2>/dev/null | head -10
\`\`\`
**If an existing component already does what you're building, ENHANCE it — do not create a duplicate.**

### 4. Implement the requested changes
- Make ONLY the changes requested — preserve everything else
- Follow the DESIGN.md spec if available
- REUSE existing components where possible — check before creating new ones

### 4b. TypeScript gate (HARD STOP)
\`\`\`bash
npm install
TSC_OUT=$(npx tsc --noEmit --skipLibCheck 2>&1)
TSC_EXIT=$?
echo "$TSC_OUT" | head -20
if [ $TSC_EXIT -ne 0 ]; then
  echo "TypeScript errors — fix all errors before proceeding to deploy"
  exit 1
fi
echo "TypeScript check passed"
\`\`\`

### 5. Update CLAUDE.md with changes (⛔ REQUIRED — pipeline will reject your PR without this)
If CLAUDE.md exists, update the "Known Issues & Gotchas" and "Change Request Notes" sections with anything you learned during this change. If it doesn't exist, create one (follow the template from new builds).
**Your PR WILL be bounced back if CLAUDE.md is not modified.** This is enforced by an automated artifact gate.

### 6. Update REGRESSION.md (⛔ REQUIRED — pipeline will reject your PR without this)
\`\`\`bash
cd /tmp/build-work

# Read existing regression manifest
if [ -f REGRESSION.md ]; then
  cat REGRESSION.md
fi

# Append test steps for the changes you just made
cat >> REGRESSION.md << 'REG_EOF'

## [CHANGE_NAME] (Issue #${issue.number})
_Added: $(date -u +%Y-%m-%d)_

### Test Steps
- [ ] [Step 1 — what to do and expected result]
- [ ] [Step 2 — next verification]

### Routes/Endpoints
- [Affected routes]

REG_EOF
\`\`\`
**Replace placeholders with ACTUAL test steps.** QA and UAT will execute every test in this file.

### 7. Commit + push feature branch + open PR
\`\`\`bash
cd /tmp/build-work
git add -A
git commit -m "feat(#${issue.number}): ${issue.title}"
git push origin "$BRANCH_NAME"

# Open PR against main
PR_URL=$(gh pr create \\
  --repo ${buildRepo} \\
  --base main \\
  --head "$BRANCH_NAME" \\
  --title "feat(#${issue.number}): ${issue.title}" \\
  --body "## Change Request — Issue #${issue.number}

**Source:** ${ctx.env.repo}#${issue.number}
**Type:** Change Request

### Changes
- [List key changes made]

### Testing
- TypeScript: ✅ passes
- Vercel preview: deployed automatically

---
*Automated PR from Factory Pipeline. QA and UAT will review before merge.*" 2>&1)
echo "PR created: $PR_URL"
PR_NUMBER=$(echo "$PR_URL" | grep -oP '\\d+$')
\`\`\`

### 7. Wait for Vercel preview deployment
Vercel auto-deploys PRs with preview URLs. Wait for it:
\`\`\`bash
echo "Waiting for Vercel preview deployment..."
sleep 30
# Get preview URL from PR deployments or Vercel
PREVIEW_URL=$(gh pr view "$PR_NUMBER" --repo ${buildRepo} --json comments --jq '.comments[-1].body' 2>/dev/null | grep -oP 'https://[\\S]+\\.vercel\\.app' | head -1)
if [ -z "$PREVIEW_URL" ]; then
  # Fallback: check Vercel deployments for the branch
  PREVIEW_URL=$(vercel list 2>/dev/null | grep "$BRANCH_NAME\\|issue-${issue.number}" | grep -oP 'https://[\\S]+\\.vercel\\.app' | head -1)
fi
if [ -z "$PREVIEW_URL" ]; then
  # Last fallback: deploy preview manually
  PREVIEW_URL=$(vercel --yes 2>&1 | grep -oP 'https://[\\S]+\\.vercel\\.app' | head -1)
fi
echo "Preview URL: $PREVIEW_URL"

# Health check the preview
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PREVIEW_URL" --max-time 20)
echo "Preview HTTP status: $HTTP_STATUS"
\`\`\`

### 8. Post BUILD COMPLETE comment + flip label
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "## BUILD COMPLETE (Change Request)

**PR:** $PR_URL
**Preview URL:** $PREVIEW_URL
**Build repo:** https://github.com/${buildRepo}
**Branch:** $BRANCH_NAME
**Changes:** ${issue.title}

_PR will be auto-merged after QA and UAT approval._"
gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:design" --add-label "station:build"
curl -s -X PATCH \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d \'{"station":"build"}\'
curl -s -X POST "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: ${ctx.env.factorySecret}" \\
  -d \'{"type":"status_update","content":"Build complete — PR ready for QA review.","payload":{"station":"build","issueNumber":${issue.number}}}\' 2>/dev/null || true
\`\`\`

## Critical rules
- **Push to feature branch, NEVER to main directly**
- **Open a PR — do NOT merge it** (QA/UAT will handle approval and merge)
- Screenshots go in /tmp/ only (never repo root)
- This is a CHANGE REQUEST — modify existing code, do not rearchitect
- Confirm: BUILD complete for change request issue #${issue.number}`,
    };
  }

  private buildInternalTask(issue: Issue, ctx: FactoryContext, owner: string): AgentTask {
    const internalRepo = ctx.config.templates?.internalRepo ?? `${owner}/${ctx.env.repo.split('/')[1] ?? 'app'}`;
    const slug = issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const branchName = `feature/issue-${issue.number}-${slug}`;

    return {
      key: `build-issue-${issue.number}`,
      station: 'build',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: 'sonnet',
      message: `You are a BUILD agent for the factory pipeline.

This is an INTERNAL feature issue. Do NOT use a template. Clone the main repo, create a feature branch, implement, open a PR.

## Step 0 — Mark station as active (run immediately)

\`\`\`bash
curl -s -X PATCH \\
  "${ctx.env.supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${ctx.env.supabaseKey}" \\
  -H "Authorization: Bearer ${ctx.env.supabaseKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"station": "build"}' || true
\`\`\`

## Steps

### 1. Read the spec
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

### 2. Clone the main repo
\`\`\`bash
CLONE_URL=$(curl -s -X POST ${ctx.env.factoryAppUrl}/api/github/clone-token \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: $FACTORY_SECRET" \\
  -d '{"owner": "${owner}", "repo": "${internalRepo.split('/')[1]}"}' | jq -r .clone_url)

git clone "$CLONE_URL" /tmp/build-work
cd /tmp/build-work
git remote set-url origin "$CLONE_URL"
git checkout -b ${branchName}
\`\`\`

### 3. Extract DESIGN.md from the issue
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments \\
  | grep -A 2000 "Design Philosophy" | head -500 > /tmp/design-issue-${issue.number}.md
cat /tmp/design-issue-${issue.number}.md
\`\`\`

### 4. Implement the feature
- Follow the SPEC and DESIGN.md exactly
- Read the existing codebase to understand patterns before writing code
- Run \`npm install && npx tsc --noEmit --skipLibCheck 2>&1 | head -20\` — fix type errors before deploying

### 5. Push feature branch + open PR
\`\`\`bash
cd /tmp/build-work
git add -A
git commit -m "feat(#${issue.number}): ${issue.title}"
git push origin ${branchName}

PR_URL=$(gh pr create \\
  --repo ${ctx.env.repo} \\
  --base main \\
  --head ${branchName} \\
  --title "feat(#${issue.number}): ${issue.title}" \\
  --body "Closes #${issue.number}\\n\\nInternal feature build by BUILD agent." \\
  2>&1 | grep "https://github.com" | head -1)

echo "PR URL: $PR_URL"
\`\`\`

### 6. Post BUILD COMPLETE comment + flip label
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "## BUILD COMPLETE (Internal Feature)

PR: $PR_URL
Branch: ${branchName}

Review the PR, then merge to ship to production."

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:design" --add-label "station:build"
SUPA_URL="${ctx.env.supabaseUrl}"
SUPA_KEY="${ctx.env.supabaseKey}"
curl -s -X PATCH \\
  "$SUPA_URL/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: $SUPA_KEY" \\
  -H "Authorization: Bearer $SUPA_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"station":"build"}'
\`\`\`

## Critical rules
- Work on branch ${branchName} — NEVER push to main directly
- This builds INTO the existing app — read existing code before adding
- Confirm: BUILD complete for internal issue #${issue.number}`,
    };
  }

  private async buildStandardTask(
    issue: Issue,
    ctx: FactoryContext,
    templateRegistry: Record<string, TemplateConfig>,
    owner: string,
  ): Promise<AgentTask> {
    const submission = await getSubmissionForIssue(
      issue.number,
      ctx.env.supabaseUrl,
      ctx.env.supabaseKey,
      ctx.log,
    );
    const templateId = resolveTemplate(
      (submission as any)?.tech_stack,
      (submission as any)?.project_type,
      templateRegistry,
    );
    const template = templateRegistry[templateId] ?? DEFAULT_TEMPLATE_REGISTRY[templateId];
    const submissionId = (submission as any)?.id ?? '';
    const SUPABASE_URL = ctx.env.supabaseUrl;
    const SUPABASE_SERVICE_KEY = ctx.env.supabaseKey;

    return {
      key: `build-issue-${issue.number}`,
      station: 'build',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: 'sonnet',
      message: `You are a BUILD agent for the factory pipeline.

Read GitHub issue #${issue.number} from repo ${ctx.env.repo} (with comments).
The issue has a SPEC comment. Build the full application using the template system.

## Step 0 — Mark station as active (run immediately)

\`\`\`bash
curl -s -X PATCH \\
  "${ctx.env.supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${ctx.env.supabaseKey}" \\
  -H "Authorization: Bearer ${ctx.env.supabaseKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"station": "build"}' || true
\`\`\`

## Template to use
- Template: \`${template.repo}\`
- Deploy target: ${template.deployTarget}
- Template ID: ${templateId}

## Steps

### 1. Read the spec
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

### 1b. Open build monitor card in chat
\`\`\`bash
SUBMISSION_ID="${submissionId}"
BUILD_MONITOR_RESP=$(curl -s -X POST "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: ${ctx.env.factorySecret}" \\
  -d '{"type":"build_monitor","content":"","payload":{"type":"build_monitor","status":"building","station":"build","progress":5,"eta_minutes":8,"elapsed_seconds":0,"activities":[]}}')
BUILD_MONITOR_ID=$(echo "$BUILD_MONITOR_RESP" | jq -r '.message.message_id // empty')
\`\`\`

### 2. Set up build repo (seeded from template)
\`\`\`bash
SETUP=$(curl -s -X POST ${ctx.env.factoryAppUrl}/api/github/setup-build-repo \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: $FACTORY_SECRET" \\
  -d '{
    "submissionId": "${submissionId}",
    "issueNumber": ${issue.number},
    "slug": "REPLACE_WITH_SLUG_FROM_SPEC",
    "templateRepo": "${template.repo}"
  }')
BUILD_CLONE_URL=$(echo $SETUP | jq -r .buildCloneUrl)
BUILD_REPO=$(echo $SETUP | jq -r .buildRepo)

git clone "$BUILD_CLONE_URL" /tmp/build-work
cd /tmp/build-work
\`\`\`

### 3. Run the customize script with manifest values from the spec
\`\`\`bash
node scripts/customize.js --manifest='{"name":"PROJECT_NAME","description":"PROJECT_DESC","primaryColor":"#E86F2C"}'
\`\`\`

### 4. Extract DESIGN.md from the issue (PRIMARY UI REFERENCE)

\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments \\
  | grep -A 2000 "Design Philosophy" | head -500 > /tmp/design-issue-${issue.number}.md
wc -l /tmp/design-issue-${issue.number}.md
cat /tmp/design-issue-${issue.number}.md
\`\`\`

**DESIGN.md is your PRIMARY UI reference.** Zero design decisions left to you.
If DESIGN.md is missing from the issue comments, STOP and post: "ERROR: DESIGN.md not found." then exit.

### 5. Run SPEC-provided migrations
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments \\
  | grep -A 500 "## Migration SQL" | head -300 > /tmp/migration-${issue.number}.sql

cd /tmp/build-work
cp /tmp/migration-${issue.number}.sql supabase/migrations/$(date +%Y%m%d%H%M%S)_spec_schema.sql
supabase db push --linked
\`\`\`

### 6. Read Impeccable design skill (MANDATORY for all UI work)
\`\`\`bash
cat ~/.agents/skills/frontend-design/SKILL.md 2>/dev/null
\`\`\`
If not installed: \`npx skills install pbakaus/impeccable@frontend-design\`

**Follow Impeccable principles in ALL UI implementation.** No generic AI aesthetics.

### 7. Implement all spec requirements on top of the template

Build every feature described in the spec. Follow the DESIGN.md for all visual decisions. Apply Impeccable design principles throughout.

### 7. Install deps + TypeScript gate (HARD STOP on errors)
\`\`\`bash
npm install
# Update build monitor: installing deps
[ -n "$BUILD_MONITOR_ID" ] && curl -s -X PATCH "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: ${ctx.env.factorySecret}" \\
  -d "{\"messageId\":\"$BUILD_MONITOR_ID\",\"payload\":{\"type\":\"build_monitor\",\"status\":\"building\",\"station\":\"build\",\"progress\":30,\"activities\":[{\"ts\":\"$(date -u +%H:%M)\",\"event\":\"info\",\"description\":\"Dependencies installed\"}]}}" 2>/dev/null || true
TSC_OUT=$(npx tsc --noEmit --skipLibCheck 2>&1)
TSC_EXIT=$?
echo "$TSC_OUT" | head -30
if [ $TSC_EXIT -ne 0 ]; then
  echo "TypeScript errors found — fix all errors before deploying"
  exit 1
fi
echo "TypeScript check passed"
# Update build monitor: TSC passed
[ -n "$BUILD_MONITOR_ID" ] && curl -s -X PATCH "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: ${ctx.env.factorySecret}" \\
  -d "{\"messageId\":\"$BUILD_MONITOR_ID\",\"payload\":{\"type\":\"build_monitor\",\"status\":\"building\",\"station\":\"build\",\"progress\":55,\"activities\":[{\"ts\":\"$(date -u +%H:%M)\",\"event\":\"info\",\"description\":\"Dependencies installed\"},{\"ts\":\"$(date -u +%H:%M)\",\"event\":\"success\",\"description\":\"TypeScript check passed\"}]}}" 2>/dev/null || true
\`\`\`

### 8. Ensure code is in a GitHub repo (MANDATORY)
If \`$BUILD_REPO\` is empty or not set, you MUST create a GitHub repo and push the code:
\`\`\`bash
if [ -z "$BUILD_REPO" ]; then
  SLUG=$(echo "${issue.title}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 40)
  gh repo create ${owner}/$SLUG --private --source=. --push
  BUILD_REPO="${owner}/$SLUG"
fi
\`\`\`
**Every build MUST have a GitHub repo.** Deploying only to Vercel from a temp directory is NOT acceptable.

### 9. Generate CLAUDE.md (⛔ REQUIRED — pipeline will reject your PR without this)
Create a \`CLAUDE.md\` file in the repo root that captures everything a future agent needs to know about this project. This is critical for Change Request builds — the next agent will read this first.
**Your PR WILL be bounced back if CLAUDE.md is not in the diff.** This is enforced by an automated artifact gate.

\`\`\`bash
cat > CLAUDE.md << 'CLAUDE_EOF'
# CLAUDE.md — Project Context

## Project
- **Name:** [PROJECT_NAME from spec]
- **Description:** [One-line description]
- **Live URL:** [Vercel URL]
- **Build Repo:** [GitHub repo URL]
- **Issue:** [Link to original GitHub issue]

## Stack
- [List all frameworks, libraries, and services used]
- [e.g., Next.js 14 (App Router), Supabase (Auth + DB + Realtime), Vercel, Tailwind CSS, shadcn/ui]

## Architecture
- [Key architecture decisions from the spec/design]
- [API structure, auth model, database schema overview]
- [Any non-obvious patterns (e.g., "admin routes use use(params) for Next.js 15 compat")]

## Environment Variables
- [List all required env vars with descriptions (NOT values)]
- [e.g., NEXT_PUBLIC_SUPABASE_URL — Supabase project URL]

## Database
- [List tables with brief descriptions]
- [Note any RLS policies, triggers, or functions]
- [Migration naming convention]

## Key Files
- [Map of important files and what they do]
- [e.g., src/app/api/sync/route.ts — GitHub → Supabase sync endpoint]

## Known Issues & Gotchas
- [Any quirks, workarounds, or things that tripped you up during the build]
- [e.g., "dash_issues.id is bigint, not UUID — must provide explicitly on insert"]

## Change Request Notes
- [Guidelines for modifying this project]
- [What to be careful about when adding features]
CLAUDE_EOF
\`\`\`

**IMPORTANT:** Replace all placeholders with actual values from your build. Be specific and detailed — this file is the project's memory.

### 10. Update REGRESSION.md (⛔ REQUIRED — pipeline will reject your PR without this)

REGRESSION.md is the living test manifest. Every feature gets test steps here. QA and UAT agents test EVERYTHING on this list — not just new features.
**Your PR WILL be bounced back if REGRESSION.md is not in the diff.** This is enforced by an automated artifact gate.

\`\`\`bash
cd /tmp/build-work

# If REGRESSION.md exists, READ it first and APPEND your new features
if [ -f REGRESSION.md ]; then
  cat REGRESSION.md
  echo "--- Appending new feature tests ---"
else
  # Create the file with a header
  cat > REGRESSION.md << 'REG_HEADER'
# REGRESSION.md — Feature Test Manifest

This file lists every testable feature in the app. QA and UAT agents
run through this ENTIRE list on every build — not just new features.
If any existing feature breaks, the build fails.

**Format:** Each feature has a category, test steps, and expected result.
Mark tests with \`[auth]\` if they require login first.

REG_HEADER
fi

# Append test steps for the features you just built
cat >> REGRESSION.md << 'REG_NEW'

## [FEATURE_NAME] (Issue #${issue.number})
_Added: $(date -u +%Y-%m-%d)_

### Test Steps
- [ ] [Step 1 — describe what to do and what should happen]
- [ ] [Step 2 — next action and expected result]
- [ ] [Step 3 — ...]

### Routes/Endpoints
- [List affected routes, e.g., /dashboard/apps, GET /api/apps]

REG_NEW
\`\`\`

**IMPORTANT:** Replace the placeholders above with ACTUAL test steps for the features you built. Be specific — include URLs, button labels, expected values. These steps will be executed by QA and UAT agents using agent-browser.

### 11. Commit to feature branch + push + open PR
\`\`\`bash
cd /tmp/build-work
BRANCH_NAME="feature/issue-${issue.number}"
git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
git add -A
git commit -m "feat(#${issue.number}): ${issue.title}"
git push origin "$BRANCH_NAME"

# Deploy preview (not production — PR-based flow)
PREVIEW_URL=$(vercel --yes 2>&1 | grep -oP 'https://[\\S]+\\.vercel\\.app' | head -1)
echo "Preview URL: $PREVIEW_URL"

# Open PR against main
PR_URL=$(gh pr create \\
  --repo $BUILD_REPO \\
  --base main \\
  --head "$BRANCH_NAME" \\
  --title "feat(#${issue.number}): ${issue.title}" \\
  --body "## New Build — Issue #${issue.number}

**Source:** ${ctx.env.repo}#${issue.number}
**Template:** ${template.repo}
**Preview:** $PREVIEW_URL

### What was built
- [List key features implemented from spec]

### Stack
- [List frameworks and services used]

---
*Automated PR from Factory Pipeline. QA and UAT will review before merge to production.*" 2>&1)
echo "PR created: $PR_URL"
PR_NUMBER=$(echo "$PR_URL" | grep -oP '\\d+$')

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PREVIEW_URL" --max-time 20)
echo "Preview HTTP status: $HTTP_STATUS"

# Update build monitor: deployed + PR open
[ -n "$BUILD_MONITOR_ID" ] && curl -s -X PATCH "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: ${ctx.env.factorySecret}" \\
  -d "{\"messageId\":\"$BUILD_MONITOR_ID\",\"payload\":{\"type\":\"build_monitor\",\"status\":\"building\",\"station\":\"build\",\"progress\":85,\"activities\":[{\"ts\":\"$(date -u +%H:%M)\",\"event\":\"info\",\"description\":\"Dependencies installed\"},{\"ts\":\"$(date -u +%H:%M)\",\"event\":\"success\",\"description\":\"TypeScript check passed\"},{\"ts\":\"$(date -u +%H:%M)\",\"event\":\"success\",\"description\":\"Deployed to Vercel: $PREVIEW_URL\"},{\"ts\":\"$(date -u +%H:%M)\",\"event\":\"info\",\"description\":\"PR opened: $PR_URL\"}]}}" 2>/dev/null || true
\`\`\`

### 11. Post BUILD COMPLETE comment + flip label
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "## BUILD COMPLETE

**PR:** $PR_URL
**Preview URL:** $PREVIEW_URL
**Build repo:** https://github.com/$BUILD_REPO
**Branch:** $BRANCH_NAME
**Template:** ${template.repo}

_PR will be auto-merged after QA and UAT approval._"
gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:design" --add-label "station:build"
curl -s -X PATCH \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d \'{"station":"build"}\'
[ -n "$BUILD_MONITOR_ID" ] && curl -s -X PATCH "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: ${ctx.env.factorySecret}" \\
  -d "{\"messageId\":\"$BUILD_MONITOR_ID\",\"payload\":{\"type\":\"build_monitor\",\"status\":\"complete\",\"station\":\"build\",\"progress\":100,\"live_url\":\"$PREVIEW_URL\",\"activities\":[{\"ts\":\"$(date -u +%H:%M)\",\"event\":\"success\",\"description\":\"Build complete — PR ready for QA review\"}]}}" 2>/dev/null || true
\`\`\`

## Critical rules
- **Push to feature branch, NEVER to main directly**
- **Open a PR — do NOT merge it** (QA/UAT will handle approval and merge)
- **Every build MUST push to a GitHub repo** — no temp-only deployments
- **Every build MUST generate CLAUDE.md** — project memory is mandatory
- Screenshots go in /tmp/ only (never repo root)
- Template already has boilerplate — build PRODUCT features, not infrastructure
- Confirm: BUILD complete for issue #${issue.number}`,
    };
  }
}
