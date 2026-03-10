/**
 * ResearchStation — first stage of the Content Pipeline.
 *
 * Triggered by: `pipeline:content`
 * Produces:     `station:draft`
 *
 * This is a documented skeleton — content pipeline implementors should extend
 * the buildTask() prompt with domain-specific research instructions.
 *
 * To activate this station in a pipeline, add it to pipelines.json:
 *   { "stationId": "research", "label": "pipeline:content", "nextLabel": "station:draft" }
 *
 * Note: the label uses the `pipeline:*` prefix (not `station:*`) because this
 * is the content pipeline's entry label — it doubles as both detection signal
 * and stage trigger.
 */

import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';

export class ResearchStation extends BaseStation {
  readonly id = 'research';
  readonly label = 'pipeline:content'; // NOTE: pipeline:* prefix — entry label
  readonly nextLabel = 'station:draft';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 2;
  readonly ttl = 1800000; // 30 min

  async shouldProcess(issue: Issue, _ctx: FactoryContext): Promise<ShouldProcessResult> {
    // Base checks: skip/paused/phase2
    const base = await this.baseCheck(issue, _ctx);
    if (base) return base;

    // Content issues: no manifest or spec-approval validation needed.
    // The pipeline:content label is sufficient signal that this issue is ready.
    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    // ─── IMPLEMENTOR NOTE ─────────────────────────────────────────────────────
    // This prompt is a placeholder. To make the content pipeline real, replace
    // this with domain-specific research instructions. Consider:
    //   - What sources should the agent search? (web, internal docs, API?)
    //   - What format should the research outline follow?
    //   - What information does the DRAFT station need to proceed?
    //   - Should the agent post a structured comment or a file?
    // ─────────────────────────────────────────────────────────────────────────

    const prompt = `# Research Station — Content Pipeline

You are a RESEARCH agent for the content pipeline.

Your task is to research the following topic and produce a structured outline
that the DRAFT station will use to write the article.

## Topic

**${issue.title}**

## Brief

${issue.body || '(no additional details provided)'}

## Steps

### 1. Read the full issue
\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

### 2. Research the topic

Gather:
- Key facts and statistics (with sources)
- Expert opinions or quotes
- Counterarguments or controversies
- Related topics to weave in
- Questions that the DRAFT should answer

### 3. Write research outline to /tmp/research-${issue.number}.md

Structure:
\`\`\`
# Research: ${issue.title}

## Executive Summary (2-3 sentences)
...

## Key Facts & Statistics
- [fact] — Source: [URL]
...

## Expert Perspectives
...

## Counterarguments / Controversies
...

## Open Questions for DRAFT
1. ...

## Sources
- [title](URL)
\`\`\`

### 4. Post research + advance to draft stage
\`\`\`bash
gh issue comment ${issue.number} --repo ${ctx.env.repo} \\
  --body "$(cat /tmp/research-${issue.number}.md)"

gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "pipeline:content" --add-label "station:draft"
\`\`\`

Confirm: Research complete for #${issue.number}`;

    return {
      key: `research-issue-${issue.number}`,
      station: 'research',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: prompt,
      logFile: `/tmp/factory-agent-logs/research-issue-${issue.number}-${Date.now()}.log`,
    };
  }
}
