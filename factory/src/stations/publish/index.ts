/**
 * PublishStation — terminal stage of the Content Pipeline.
 *
 * Triggered by: `station:publish`
 * Produces:     null (terminal — no nextLabel)
 *
 * Takes the reviewed article and publishes it to the configured destination:
 * CMS, static site generator, blog platform, etc.
 *
 * This is a documented skeleton. Implementors must fill in:
 *   - Where to publish (CMS API, GitHub Pages, Contentful, Ghost, etc.)
 *   - Authentication method (API key from env or config)
 *   - Post-publish verification
 *
 * Since this is a terminal stage (nextLabel = null in pipelines.json),
 * the issue is closed or moved to 'station:done' by the agent itself.
 */

import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';

export class PublishStation extends BaseStation {
  readonly id = 'publish';
  readonly label = 'station:publish';
  readonly nextLabel = 'station:done'; // applied by the agent manually; null in pipeline config
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 1;
  readonly ttl = 1800000; // 30 min

  async shouldProcess(issue: Issue, _ctx: FactoryContext): Promise<ShouldProcessResult> {
    // Base checks: skip/paused/phase2
    const base = await this.baseCheck(issue, _ctx);
    if (base) return base;

    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    // ─── IMPLEMENTOR NOTE ─────────────────────────────────────────────────────
    // Fill in the publish step with your CMS or platform details:
    //
    //   Ghost CMS:
    //     curl -X POST https://your-ghost-site.com/ghost/api/admin/posts/ \
    //       -H "Authorization: Ghost <API_KEY>" -d '{"posts":[...]}'
    //
    //   Contentful:
    //     Use the Contentful Management API to create an entry and publish it.
    //
    //   GitHub Pages / Jekyll:
    //     Write the article as a Markdown file to _posts/ and push.
    //
    //   WordPress:
    //     Use the REST API: POST /wp-json/wp/v2/posts
    //
    // Set the CMS API key via environment variables or config.json.settings.
    // After publishing, close the issue or add station:done.
    // ─────────────────────────────────────────────────────────────────────────

    const prompt = `# Publish Station — Content Pipeline

You are a PUBLISH agent for the content pipeline.

Your task is to publish the reviewed article to the configured destination.

## Article Topic

**${issue.title}**

## Steps

### 1. Read the issue and approved draft
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

Find the EDITORIAL REVIEW: APPROVED comment. Extract the "Final Draft" section.

### 2. Publish the article

⚠️ IMPLEMENTOR: Replace this step with your CMS publish logic.

Example (Ghost CMS):
\`\`\`bash
# Extract the final draft
cat > /tmp/publish-${issue.number}.md << 'ARTICLE'
[paste final draft here]
ARTICLE

# Publish via Ghost Admin API
curl -s -X POST "$GHOST_API_URL/ghost/api/admin/posts/" \\
  -H "Authorization: Ghost $GHOST_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "posts": [{
      "title": "${issue.title}",
      "status": "published",
      "mobiledoc": "..."
    }]
  }'
\`\`\`

### 3. Verify publication

\`\`\`bash
# Visit the published URL and verify it loads
curl -s -o /dev/null -w "%{http_code}" "$PUBLISHED_URL"
\`\`\`

### 4. Post PUBLISHED comment + close issue
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} \\
  --body "## PUBLISHED ✅

Article is live at: $PUBLISHED_URL

Pipeline complete."

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:publish" --add-label "station:done"
\`\`\`

Confirm: Publish complete for #${issue.number}`;

    return {
      key: `publish-issue-${issue.number}`,
      station: 'publish',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: prompt,
      logFile: `/tmp/factory-agent-logs/publish-issue-${issue.number}-${Date.now()}.log`,
    };
  }
}
