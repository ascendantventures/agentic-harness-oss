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
  readonly concurrency = 1; // Rate limit safety — max 1 concurrent build
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

    // 4. Design comment check
    const designDone = hasDesignComment(issue.number, ctx.env.repo);
    if (!designDone) {
      this.designAction = { action: 'respawn-design', issueNumber: issue.number };
      return { process: false, reason: 'DESIGN.md not yet posted — waiting for design agent' };
    }

    // 5. Design quality gate
    const qualityCheck = checkDesignQuality(issue.number, ctx.env.repo, ctx.log);
    if (!qualityCheck.ok) {
      this.designAction = {
        action: 'reject-design',
        issueNumber: issue.number,
        reason: qualityCheck.reason,
      };
      return {
        process: false,
        reason: `Design quality gate failed: ${qualityCheck.reason}`,
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

## Steps

### 1. Read the change request spec
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

Extract:
- Summary of what the client wants changed
- Change type (design / bugfix / feature)
- Any details or context provided

### 2. Clone EXISTING build repo (no template setup)
\`\`\`bash
CLONE_URL=$(curl -s -X POST ${ctx.env.factoryAppUrl}/api/github/clone-token \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: $FACTORY_SECRET" \\
  -d '{"owner": "${owner}", "repo": "${repoName}"}' | jq -r .clone_url)

git clone "$CLONE_URL" /tmp/build-work
cd /tmp/build-work
git remote set-url origin "$CLONE_URL"
\`\`\`

### 3. Extract DESIGN.md from the issue (change-focused spec)
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments \\
  | grep -A 2000 "Design Philosophy" | head -500 > /tmp/design-issue-${issue.number}.md
cat /tmp/design-issue-${issue.number}.md
\`\`\`

If no DESIGN.md comment exists, derive the change from the issue title and details.

### 4. Implement the requested changes
- Make ONLY the changes requested — preserve everything else
- Follow the DESIGN.md spec if available

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

### 5. Push changes to build repo
\`\`\`bash
cd /tmp/build-work
git add -A
git commit -m "change: ${issue.title}"
git push origin main
\`\`\`

### 6. Deploy
\`\`\`bash
cd /tmp/build-work
${submissionId && SUPABASE_URL
  ? `EXISTING_LIVE_URL=$(curl -s \\
  "${SUPABASE_URL}/rest/v1/submissions?id=eq.${submissionId}&select=live_url" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" | jq -r '.[0].live_url // empty')

if [ -n "$EXISTING_LIVE_URL" ]; then
  ORIGINAL_PROJECT=$(echo "$EXISTING_LIVE_URL" | sed 's|https://||' | sed 's|\\.vercel\\.app.*||')
  echo "Linking to existing Vercel project: $ORIGINAL_PROJECT"
fi`
  : '# Deploy to your configured hosting provider'}

DEPLOY_OUT=$(vercel --prod --yes 2>&1)
DEPLOY_EXIT=$?
echo "$DEPLOY_OUT" | tail -15
if [ $DEPLOY_EXIT -ne 0 ]; then
  echo "DEPLOY FAILED (exit $DEPLOY_EXIT)"
  gh issue comment ${issue.number} --repo ${ctx.env.repo} \\
    --body "## BUILD FAILED (Change Request)

Vercel deploy exited with code \$DEPLOY_EXIT. Station label NOT flipped — manual investigation required."
  exit 1
fi
LIVE_URL=$(vercel list 2>/dev/null | grep -m1 "https://" | awk '{print $2}')
echo "Deploy succeeded: $LIVE_URL"

# Post-deploy health check
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$LIVE_URL" --max-time 20)
echo "Home page HTTP status: $HTTP_STATUS"
\`\`\`

### 7. Post BUILD COMPLETE comment + flip label
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "## BUILD COMPLETE (Change Request)\\n\\nLive URL: $LIVE_URL\\nBuild repo: https://github.com/${buildRepo}\\nChanges applied: ${issue.title}"
gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:design" --add-label "station:build"
\`\`\`

## Critical rules
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

## Template to use
- Template: \`${template.repo}\`
- Deploy target: ${template.deployTarget}
- Template ID: ${templateId}

## Steps

### 1. Read the spec
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
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

### 6. Implement all spec requirements on top of the template

Build every feature described in the spec. Follow the DESIGN.md for all visual decisions.

### 7. Install deps + TypeScript gate (HARD STOP on errors)
\`\`\`bash
npm install
TSC_OUT=$(npx tsc --noEmit --skipLibCheck 2>&1)
TSC_EXIT=$?
echo "$TSC_OUT" | head -30
if [ $TSC_EXIT -ne 0 ]; then
  echo "TypeScript errors found — fix all errors before deploying"
  exit 1
fi
echo "TypeScript check passed"
\`\`\`

### 8. Deploy
\`\`\`bash
DEPLOY_OUT=$(vercel --prod --yes 2>&1)
DEPLOY_EXIT=$?
echo "$DEPLOY_OUT" | tail -15
if [ $DEPLOY_EXIT -ne 0 ]; then
  echo "DEPLOY FAILED (exit $DEPLOY_EXIT)"
  gh issue comment ${issue.number} --repo ${ctx.env.repo} \\
    --body "## BUILD FAILED\\n\\nDeploy exited with code $DEPLOY_EXIT."
  exit 1
fi
LIVE_URL=$(vercel list 2>/dev/null | head -3 | grep -oP 'https://[\\S]+\\.vercel\\.app' | head -1)
echo "Deploy succeeded: $LIVE_URL"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$LIVE_URL" --max-time 20)
echo "Home page HTTP: $HTTP_STATUS"
\`\`\`

### 9. Post BUILD COMPLETE comment + flip label
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "## BUILD COMPLETE\\n\\nLive URL: $LIVE_URL\\nBuild repo: https://github.com/$BUILD_REPO\\nTemplate used: ${template.repo}"
gh issue edit ${issue.number} --repo ${ctx.env.repo} --remove-label "station:design" --add-label "station:build"
\`\`\`

## Critical rules
- Screenshots go in /tmp/ only (never repo root)
- NEVER push directly to client repo
- Template already has boilerplate — build PRODUCT features, not infrastructure
- Confirm: BUILD complete for issue #${issue.number}`,
    };
  }
}
