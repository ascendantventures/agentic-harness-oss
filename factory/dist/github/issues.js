import { execSync } from 'child_process';
export function extractManifest(body) {
    try {
        const match = body?.match(/```json\s*([\s\S]*?)```/);
        if (match)
            return JSON.parse(match[1]);
    }
    catch { }
    return null;
}
export function isValidManifest(issue) {
    const manifest = extractManifest(issue.body ?? '');
    if (!manifest)
        return false;
    const business = (manifest.business ?? '').trim();
    const problem = (manifest.problem ?? '').trim();
    if (business.length < 15 || problem.length < 10)
        return false;
    if (/^(test|api test|submit test|testing)$/i.test(business))
        return false;
    return true;
}
export function isChangeRequestIssue(issue) {
    return issue.title.startsWith('[Change]');
}
export function extractBuildRepo(issueBody) {
    const match = issueBody?.match(/build_repo:\s*(\S+)/);
    return match?.[1] ?? null;
}
export function extractSubmissionId(issueBody) {
    const match = issueBody?.match(/submission_id:\s*(\S+)/);
    return match?.[1] ?? null;
}
/** Enrich a raw GitHubIssue into the typed Issue shape */
export function enrichIssue(raw) {
    const labelNames = (raw.labels ?? []).map((l) => l.name);
    const manifest = extractManifest(raw.body ?? '');
    const hasLabel = (name) => labelNames.includes(name);
    const hasComplexity = (level) => hasLabel(`complexity:${level}`);
    let complexity = null;
    if (hasComplexity('simple'))
        complexity = 'simple';
    else if (hasComplexity('medium'))
        complexity = 'medium';
    else if (hasComplexity('complex'))
        complexity = 'complex';
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
export function getIssuesByLabel(label, repo, limit = 20) {
    const result = execSync(`gh issue list --label "${label}" --state open --limit ${limit} --repo ${repo} --json number,title,body,labels,url 2>/dev/null`, { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(result);
}
/** Fetch all open issues with a given label, enriched */
export function getEnrichedIssuesByLabel(label, repo, limit = 20) {
    return getIssuesByLabel(label, repo, limit).map(enrichIssue);
}
/** Check if the issue has a DESIGN.md comment */
export function hasDesignComment(issueNumber, repo) {
    try {
        const result = execSync(`gh issue view ${issueNumber} --repo ${repo} --json comments`, { encoding: 'utf8', timeout: 15000 });
        const { comments } = JSON.parse(result);
        return (comments ?? []).some((c) => c.body?.includes('# DESIGN.md') ||
            c.body?.includes('Design Philosophy') ||
            c.body?.includes('## Color System'));
    }
    catch {
        return false;
    }
}
/** Check DESIGN.md quality (word count + required sections) */
export function checkDesignQuality(issueNumber, repo, log) {
    try {
        const result = execSync(`gh issue view ${issueNumber} --repo ${repo} --json comments,labels`, { encoding: 'utf8', timeout: 15000 });
        const { comments, labels } = JSON.parse(result);
        const allBodies = (comments ?? []).map((c) => c.body ?? '').join('\n');
        const labelNames = (labels ?? []).map((l) => l.name);
        // Determine complexity tier from labels
        const isSimple = labelNames.includes('complexity:simple') || labelNames.includes('bug');
        const isMedium = labelNames.includes('complexity:medium');
        const isComplex = labelNames.includes('complexity:complex');
        // UAT follow-ups and type:enhancement are typically lighter-weight
        const isFollowUp = labelNames.includes('type:enhancement') ||
            (comments ?? []).some((c) => c.body?.includes('[UAT Follow-up]') || c.body?.includes('follow-up'));
        // Tiered quality gates based on complexity
        if (isSimple || isFollowUp) {
            // Simple/follow-up: just need a DESIGN.md comment with basic structure
            const hasDesignHeader = allBodies.includes('DESIGN.md') || allBodies.includes('Design');
            const designWordCount = allBodies.split(/\s+/).filter(Boolean).length;
            if (!hasDesignHeader || designWordCount < 300) {
                return {
                    ok: false,
                    reason: `Simple/follow-up DESIGN.md too brief (${designWordCount} words, minimum 300)`,
                };
            }
            // Must have at least a component spec or change description
            const hasComponentInfo = allBodies.includes('Component') || allBodies.includes('File Changes') ||
                allBodies.includes('Changes Summary') || allBodies.includes('Specification');
            if (!hasComponentInfo) {
                return {
                    ok: false,
                    reason: 'Simple/follow-up DESIGN.md missing component or change specification',
                };
            }
            return { ok: true };
        }
        if (isMedium) {
            // Medium: need core design sections but not full Impeccable spec
            const mediumWordMin = 800;
            const wordCount = allBodies.split(/\s+/).filter(Boolean).length;
            if (wordCount < mediumWordMin) {
                return {
                    ok: false,
                    reason: `Medium DESIGN.md too short (${wordCount} words, minimum ${mediumWordMin})`,
                };
            }
            const mediumRequired = ['Design Philosophy', 'Component'];
            const missing = mediumRequired.filter((s) => !allBodies.includes(s));
            if (missing.length > 0) {
                return { ok: false, reason: `Medium DESIGN.md missing: ${missing.join(', ')}` };
            }
            return { ok: true };
        }
        // Complex (or unlabeled): full Impeccable quality gate
        const wordCount = allBodies.split(/\s+/).filter(Boolean).length;
        if (wordCount < 1500) {
            return {
                ok: false,
                reason: `DESIGN.md too short (${wordCount} words, minimum 1500). All 12+ sections required.`,
            };
        }
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
    }
    catch (e) {
        log(`checkDesignQuality error for #${issueNumber}: ${e.message}`);
        return { ok: true }; // fail open — don't block on API errors
    }
}
/** Get last QA info from issue comments */
export async function getLastQAInfo(issueNumber, repo, log) {
    try {
        const result = execSync(`gh issue view ${issueNumber} --repo ${repo} --comments --json comments 2>/dev/null`, { encoding: 'utf8', timeout: 15000 });
        const { comments } = JSON.parse(result);
        // Find last QA report
        const qaComment = [...(comments ?? [])].reverse().find((c) => (c.body?.includes('QA REPORT') ||
            c.body?.includes('QA Complete') ||
            c.body?.includes('QA complete')) &&
            (c.body?.includes('FAIL') ||
                c.body?.includes('PASS') ||
                c.body?.includes('❌') ||
                c.body?.includes('✅')));
        // Extract repo URL — check QA comments and BUILD COMPLETE comments
        let buildRepo = null;
        for (const c of [...(comments ?? [])].reverse()) {
            const m1 = c.body?.match(/\*\*Repo:\*\*\s*https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/);
            if (m1) {
                buildRepo = m1[1];
                break;
            }
            const m2 = c.body?.match(/[Bb]uild repo:?\s*https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/);
            if (m2) {
                buildRepo = m2[1];
                break;
            }
        }
        if (!qaComment)
            return { hasFailedQA: false, buildRepo };
        const isFail = (qaComment.body?.includes('FAIL') || qaComment.body?.includes('❌')) &&
            !qaComment.body?.match(/✅\s*QA PASS/);
        return { hasFailedQA: !!isFail, lastQAAt: qaComment.createdAt, buildRepo };
    }
    catch (e) {
        log(`Warning: QA status check failed for #${issueNumber}: ${e.message}`);
        return { hasFailedQA: false, buildRepo: null };
    }
}
/** Check if the build repo has moved since last QA */
export async function hasBuildMovedSinceLastQA(buildRepo, lastQAAt, log) {
    if (!lastQAAt)
        return true; // no prior QA timestamp — run it
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
    }
    catch {
        log(`Could not reach build repo ${buildRepo} — assuming stalled`);
        return false;
    }
}
//# sourceMappingURL=issues.js.map