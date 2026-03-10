/**
 * DraftStation — second stage of the Content Pipeline.
 *
 * Triggered by: `station:draft`
 * Produces:     `station:review`
 *
 * Reads the research comment from the ResearchStation and writes
 * a full article draft as a GitHub comment.
 *
 * This is a documented skeleton — extend buildTask() with your
 * style guide, word count requirements, tone, format, etc.
 */

import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';

export class DraftStation extends BaseStation {
  readonly id = 'draft';
  readonly label = 'station:draft';
  readonly nextLabel = 'station:review';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 2;
  readonly ttl = 3600000; // 1 hour

  async shouldProcess(issue: Issue, _ctx: FactoryContext): Promise<ShouldProcessResult> {
    // Base checks: skip/paused/phase2
    const base = await this.baseCheck(issue, _ctx);
    if (base) return base;

    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    // ─── IMPLEMENTOR NOTE ─────────────────────────────────────────────────────
    // Customize this prompt with:
    //   - Target word count
    //   - Style guide URL or inline style rules
    //   - Tone: formal / conversational / technical
    //   - Required sections (intro, body, conclusion, CTA, etc.)
    //   - SEO keywords or headings
    //   - Output format (Markdown, HTML, plain text)
    // ─────────────────────────────────────────────────────────────────────────

    const prompt = `# Draft Station — Content Pipeline

You are a DRAFT agent for the content pipeline.

Your task is to write a complete article draft based on the research produced
by the Research station.

## Article Topic

**${issue.title}**

## Steps

### 1. Read the issue and research
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

Find the Research comment (it will contain "## Executive Summary").
Read it carefully — this is your source material.

### 2. Write the article draft

Use the research outline to write a complete, publication-ready draft.

Requirements:
- Clear, engaging introduction that states the topic
- Well-structured body with headings and subheadings
- Specific facts and statistics cited from the research
- Balanced perspective on controversies
- Strong conclusion with key takeaways
- Minimum 800 words

Write the draft to /tmp/draft-${issue.number}.md.

### 3. Post draft + advance to review
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} \\
  --body "$(cat /tmp/draft-${issue.number}.md)"

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:draft" --add-label "station:review"
\`\`\`

Confirm: Draft complete for #${issue.number}`;

    return {
      key: `draft-issue-${issue.number}`,
      station: 'draft',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: prompt,
      logFile: `/tmp/factory-agent-logs/draft-issue-${issue.number}-${Date.now()}.log`,
    };
  }
}
