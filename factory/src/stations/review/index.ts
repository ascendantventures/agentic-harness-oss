/**
 * ReviewStation — third stage of the Content Pipeline.
 *
 * Triggered by: `station:review`
 * Produces:     `station:publish`
 *
 * Reads the draft comment and performs editorial review:
 * factual accuracy, style, grammar, SEO, readability.
 * Returns either an approved draft or revision requests.
 *
 * This is a documented skeleton — extend with your editorial standards.
 */

import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';

export class ReviewStation extends BaseStation {
  readonly id = 'review';
  readonly label = 'station:review';
  readonly nextLabel = 'station:publish';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 1;
  readonly ttl = 3600000; // 1 hour

  async shouldProcess(issue: Issue, _ctx: FactoryContext): Promise<ShouldProcessResult> {
    // Base checks: skip/paused/phase2
    const base = await this.baseCheck(issue, _ctx);
    if (base) return base;

    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    // ─── IMPLEMENTOR NOTE ─────────────────────────────────────────────────────
    // Customize the review criteria with your editorial standards:
    //   - Style guide (AP, Chicago, house style)
    //   - Factual accuracy checks (how to verify claims?)
    //   - SEO requirements (keyword density, meta description)
    //   - Brand voice rules
    //   - Revision workflow: should the station loop back to DRAFT on failure,
    //     or request human review? (Currently it advances to publish unconditionally)
    // ─────────────────────────────────────────────────────────────────────────

    const prompt = `# Review Station — Content Pipeline

You are an EDITORIAL REVIEW agent for the content pipeline.

Your task is to review the article draft and either approve it for publication
or request revisions.

## Article Topic

**${issue.title}**

## Steps

### 1. Read the issue and draft
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

Find the most recent Draft comment. Read it thoroughly.

### 2. Review the draft

Check for:
- **Accuracy**: Are all facts and statistics correctly stated? Are sources credible?
- **Clarity**: Is the argument clear and well-structured? Does each section flow logically?
- **Grammar & Style**: Fix typos, awkward sentences, passive voice overuse.
- **Completeness**: Does it answer the key questions from the research? Is the conclusion strong?
- **Length**: Is it appropriately detailed? Too short / too long?

### 3. Post review results

If the draft is ready to publish:
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} \\
  --body "## EDITORIAL REVIEW: APPROVED

The draft has been reviewed and is ready for publication.

### Review Notes
[Brief summary of any minor edits made inline]

### Final Draft
[Paste the final, edited article here]"

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:review" --add-label "station:publish"
\`\`\`

If the draft needs significant revisions:
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} \\
  --body "## EDITORIAL REVIEW: REVISION REQUIRED

The draft needs the following changes before publication:

1. [Specific change required]
2. [Specific change required]
...

Please update the draft and re-submit for review."

# Do NOT flip the label — leave it at station:review for the DRAFT agent to revise
\`\`\`

Confirm: Review complete for #${issue.number}`;

    return {
      key: `review-issue-${issue.number}`,
      station: 'review',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: prompt,
      logFile: `/tmp/factory-agent-logs/review-issue-${issue.number}-${Date.now()}.log`,
    };
  }
}
