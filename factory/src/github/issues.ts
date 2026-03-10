import { execSync } from 'child_process';
import type { GitHubIssue, Issue, ClientManifest } from '../types/index.js';

export function extractManifest(body: string | null | undefined): ClientManifest | null {
  try {
    const match = body?.match(/```json\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1]) as ClientManifest;
  } catch {}
  return null;
}

export function isValidManifest(issue: GitHubIssue): boolean {
  const manifest = extractManifest(issue.body ?? '');
  if (!manifest) return false;
  const business = (manifest.business ?? '').trim();
  const problem = (manifest.problem ?? '').trim();
  if (business.length < 15 || problem.length < 10) return false;
  if (/^(test|api test|submit test|testing)$/i.test(business)) return false;
  return true;
}

export function isChangeRequestIssue(issue: GitHubIssue): boolean {
  return issue.title.startsWith('[Change]');
}

export function extractBuildRepo(issueBody: string | null | undefined): string | null {
  const match = issueBody?.match(/build_repo:\s*(\S+)/);
  return match?.[1] ?? null;
}

export function extractSubmissionId(issueBody: string | null | undefined): string | null {
  const match = issueBody?.match(/submission_id:\s*(\S+)/);
  return match?.[1] ?? null;
}

/** Enrich a raw GitHubIssue into the typed Issue shape */
export function enrichIssue(raw: GitHubIssue): Issue {
  const labelNames = (raw.labels ?? []).map((l) => l.name);
  const manifest = extractManifest(raw.body ?? '');

  const hasLabel = (name: string) => labelNames.includes(name);
  const hasComplexity = (level: string) => hasLabel(`complexity:${level}`);

  let complexity: Issue['complexity'] = null;
  if (hasComplexity('simple')) complexity = 'simple';
  else if (hasComplexity('medium')) complexity = 'medium';
  else if (hasComplexity('complex')) complexity = 'complex';

  return {
    raw,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url ?? '',
    labels: labelNames,
    manifest,
    isChangeRequest: isChangeRequestIssue(raw),
    isInternal: hasLabel('type:internal'),
    isPhase2: hasLabel('type:phase2'),
    complexity,
    buildRepo: extractBuildRepo(raw.body) ?? undefined,
    submissionId: extractSubmissionId(raw.body) ?? undefined,
  };
}

/** Fetch issues by label using the `gh` CLI */
export function getIssuesByLabel(
  label: string,
  repo: string,
  limit = 20,
): GitHubIssue[] {
  const result = execSync(
    `gh issue list --label "${label}" --state open --limit ${limit} --repo ${repo} --json number,title,body,labels,url 2>/dev/null`,
    { encoding: 'utf8', timeout: 30000 },
  );
  return JSON.parse(result) as GitHubIssue[];
}

/** Fetch all open issues with a given label, enriched */
export function getEnrichedIssuesByLabel(
  label: string,
  repo: string,
  limit = 20,
): Issue[] {
  return getIssuesByLabel(label, repo, limit).map(enrichIssue);
}

/** Check if the issue has a DESIGN.md comment */
export function hasDesignComment(issueNumber: number, repo: string): boolean {
  try {
    const result = execSync(
      `gh issue view ${issueNumber} --repo ${repo} --json comments`,
      { encoding: 'utf8', timeout: 15000 },
    );
    const { comments } = JSON.parse(result) as { comments: Array<{ body?: string }> };
    return (comments ?? []).some(
      (c) =>
        c.body?.includes('# DESIGN.md') ||
        c.body?.includes('Design Philosophy') ||
        c.body?.includes('## Color System'),
    );
  } catch {
    return false;
  }
}

/** Check DESIGN.md quality (word count + required sections) */
export function checkDesignQuality(
  issueNumber: number,
  repo: string,
  log: (msg: string) => void,
): { ok: boolean; reason?: string } {
  try {
    const result = execSync(
      `gh issue view ${issueNumber} --repo ${repo} --json comments`,
      { encoding: 'utf8', timeout: 15000 },
    );
    const { comments } = JSON.parse(result) as { comments: Array<{ body?: string }> };
    const allBodies = (comments ?? []).map((c) => c.body ?? '').join('\n');

    // AC-002.1: Word count check
    const wordCount = allBodies.split(/\s+/).filter(Boolean).length;
    if (wordCount < 1500) {
      return {
        ok: false,
        reason: `DESIGN.md too short (${wordCount} words, minimum 1500). All 12+ sections required.`,
      };
    }

    // AC-002.2: Required section headers
    const requiredSections = [
      'Design Philosophy',
      'Color System',
      'Typography',
      'Spacing',
      'Component Specifications',
      'Page-by-Page',
      'Icon System',
      'Tailwind Config',
    ];
    const missingSections = requiredSections.filter((s) => !allBodies.includes(s));
    if (missingSections.length > 0) {
      return {
        ok: false,
        reason: `DESIGN.md missing required sections: ${missingSections.join(', ')}`,
      };
    }

    return { ok: true };
  } catch (e: any) {
    log(`checkDesignQuality error for #${issueNumber}: ${e.message}`);
    return { ok: true }; // fail open — don't block on API errors
  }
}

/** Get last QA info from issue comments */
export async function getLastQAInfo(
  issueNumber: number,
  repo: string,
  log: (msg: string) => void,
): Promise<{ hasFailedQA: boolean; lastQAAt?: string; buildRepo: string | null }> {
  try {
    const result = execSync(
      `gh issue view ${issueNumber} --repo ${repo} --comments --json comments 2>/dev/null`,
      { encoding: 'utf8', timeout: 15000 },
    );
    const { comments } = JSON.parse(result) as {
      comments: Array<{ body?: string; createdAt?: string }>;
    };

    // Find last QA report
    const qaComment = [...(comments ?? [])].reverse().find(
      (c) =>
        (c.body?.includes('QA REPORT') ||
          c.body?.includes('QA Complete') ||
          c.body?.includes('QA complete')) &&
        (c.body?.includes('FAIL') ||
          c.body?.includes('PASS') ||
          c.body?.includes('❌') ||
          c.body?.includes('✅')),
    );

    // Extract repo URL — check QA comments and BUILD COMPLETE comments
    let buildRepo: string | null = null;
    for (const c of [...(comments ?? [])].reverse()) {
      const m1 = c.body?.match(/\*\*Repo:\*\*\s*https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/);
      if (m1) {
        buildRepo = m1[1];
        break;
      }
      const m2 = c.body?.match(
        /[Bb]uild repo:?\s*https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/,
      );
      if (m2) {
        buildRepo = m2[1];
        break;
      }
    }

    if (!qaComment) return { hasFailedQA: false, buildRepo };

    const isFail =
      (qaComment.body?.includes('FAIL') || qaComment.body?.includes('❌')) &&
      !qaComment.body?.match(/✅\s*QA PASS/);

    return { hasFailedQA: !!isFail, lastQAAt: qaComment.createdAt, buildRepo };
  } catch (e: any) {
    log(`Warning: QA status check failed for #${issueNumber}: ${e.message}`);
    return { hasFailedQA: false, buildRepo: null };
  }
}

/** Check if the build repo has moved since last QA */
export async function hasBuildMovedSinceLastQA(
  buildRepo: string | null,
  lastQAAt: string | undefined,
  log: (msg: string) => void,
): Promise<boolean> {
  if (!lastQAAt) return true; // no prior QA timestamp — run it
  if (!buildRepo) {
    log('No build repo URL found — assuming QA stalled (will not re-queue)');
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
