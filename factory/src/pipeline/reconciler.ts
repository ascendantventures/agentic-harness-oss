/**
 * Label reconciliation for stuck issues.
 *
 * Three layers:
 * 1. Post-exit: Called from cleanDeadLocks() after agent dies — flips label if work artifact exists
 * 2. Guard auto-advance: Called from shouldProcess() guards — flips label if work already done
 * 3. Periodic sweep: Scans all open issues every N ticks — catches anything layers 1-2 missed
 */

import { execSync } from 'child_process';
import type { PipelinesConfig, PipelineStageConfig } from '../types/pipeline.js';

// ── Artifact gate: required file modifications per station ──────────────────

interface ArtifactRule {
  file: string;       // file path pattern to check in PR diff
  required: boolean;  // true = bounce if missing, false = warn only
  message: string;    // human-readable description for bounce comment
}

const ARTIFACT_GATES: Record<string, ArtifactRule[]> = {
  build: [
    { file: 'REGRESSION.md', required: true, message: 'REGRESSION.md must be updated with test steps for new behavior' },
    { file: 'CLAUDE.md', required: true, message: 'CLAUDE.md must be updated with architecture notes and key decisions' },
    { file: 'DECISIONS.md', required: false, message: 'Consider updating DECISIONS.md if architectural choices were made' },
  ],
  bugfix: [
    { file: 'REGRESSION.md', required: true, message: 'REGRESSION.md must be updated with regression test steps for this fix' },
  ],
};

/**
 * Check if a PR's diff includes modifications to required artifact files.
 * Returns { pass: true } if all required artifacts are present,
 * or { pass: false, missing: string[] } with human-readable failure reasons.
 */
export function checkArtifactGate(
  issueNumber: number,
  station: string,
  repo: string,
  buildRepo: string,
  log: (msg: string) => void,
): { pass: boolean; missing: string[]; warnings: string[] } {
  const rules = ARTIFACT_GATES[station];
  if (!rules || rules.length === 0) return { pass: true, missing: [], warnings: [] };

  const branchName = `feature/issue-${issueNumber}`;

  // Get the list of files changed in the PR
  let changedFiles: string[] = [];
  try {
    const filesOutput = execSync(
      `gh pr view "${branchName}" --repo ${buildRepo} --json files --jq '[.files[].path]'`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    changedFiles = JSON.parse(filesOutput);
  } catch (e: any) {
    // If PR doesn't exist or can't be read, skip the gate (don't block)
    log(`  ⚠️ Artifact gate: could not read PR files for #${issueNumber}: ${e.message?.slice(0, 80)}`);
    return { pass: true, missing: [], warnings: [] };
  }

  const missing: string[] = [];
  const warnings: string[] = [];

  for (const rule of rules) {
    const found = changedFiles.some(f => f.endsWith(rule.file) || f.includes(rule.file));
    if (!found) {
      if (rule.required) {
        missing.push(rule.message);
      } else {
        warnings.push(rule.message);
      }
    }
  }

  // Log warnings (non-blocking)
  for (const w of warnings) {
    log(`  ⚠️ Artifact gate warning #${issueNumber}: ${w}`);
  }

  return { pass: missing.length === 0, missing, warnings };
}

/**
 * Post an artifact gate failure comment on the issue and bounce back to the station.
 */
function bounceForArtifactGate(
  issueNumber: number,
  station: string,
  repo: string,
  stageLabel: string,
  missing: string[],
  log: (msg: string) => void,
): void {
  const body = [
    `## ⛔ Artifact Gate Failed`,
    ``,
    `The ${station} agent completed work but did not update required files:`,
    ``,
    ...missing.map(m => `- ${m}`),
    ``,
    `Bouncing back to \`${stageLabel}\` for the agent to fix. The next ${station} agent will see this comment and update the missing files.`,
  ].join('\n');

  try {
    execSync(
      `gh issue comment ${issueNumber} --repo ${repo} --body ${JSON.stringify(body)}`,
      { encoding: 'utf8', timeout: 15000 },
    );
    log(`⛔ Artifact gate failed for #${issueNumber}: ${missing.join('; ')}`);
  } catch (e: any) {
    log(`⚠️ Failed to post artifact gate comment on #${issueNumber}: ${e.message?.slice(0, 80)}`);
  }
}

// ── Stage → artifact detection patterns ─────────────────────────────────────

const STAGE_ARTIFACTS: Record<string, RegExp> = {
  spec: /## (SPEC|Specification|Requirements)/i,
  design: /## (DESIGN|Design Specification|DESIGN\.md)/i,
  build: /## BUILD COMPLETE/i,
  qa: /## QA Report[\s\S]{0,200}(✅ PASS|QA PASS)/i,  // Only match QA PASS — FAIL must not advance
  bugfix: /## (BUGFIX|Bug Fix) (COMPLETE|Report)/i,
};

// ── Pipeline stage lookup ───────────────────────────────────────────────────

/**
 * Find the pipeline stage for a given station label.
 */
export function findStageByLabel(
  pipelinesConfig: PipelinesConfig,
  stationLabel: string,
): PipelineStageConfig | null {
  for (const pipeline of pipelinesConfig.pipelines) {
    for (const stage of pipeline.stages) {
      if (stage.label === stationLabel) {
        return stage;
      }
    }
  }
  return null;
}

/**
 * Find the stage that produces a given label (i.e., stage.nextLabel === label).
 */
export function findStageByNextLabel(
  pipelinesConfig: PipelinesConfig,
  label: string,
): PipelineStageConfig | null {
  for (const pipeline of pipelinesConfig.pipelines) {
    for (const stage of pipeline.stages) {
      if (stage.nextLabel === label) {
        return stage;
      }
    }
  }
  return null;
}

// ── Label flip helper ───────────────────────────────────────────────────────

/**
 * Flip an issue's station label from currentLabel to nextLabel.
 * Also cleans up any other station:* labels (fixes dual-label issues).
 */
export function flipLabel(
  issueNumber: number,
  repo: string,
  currentLabel: string,
  nextLabel: string,
  log: (msg: string) => void,
  reason: string,
): boolean {
  try {
    // Get current labels
    const labelsJson = execSync(
      `gh issue view ${issueNumber} --repo ${repo} --json labels --jq '[.labels[].name]'`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    const labels: string[] = JSON.parse(labelsJson);

    // Collect all station:* labels to remove
    const stationLabels = labels.filter(l => l.startsWith('station:'));

    if (!stationLabels.includes(currentLabel)) {
      // Label already changed (maybe agent flipped it) — no-op
      return false;
    }

    // Build remove args
    const removeArgs = stationLabels.map(l => `--remove-label "${l}"`).join(' ');

    execSync(
      `gh issue edit ${issueNumber} --repo ${repo} ${removeArgs} --add-label "${nextLabel}"`,
      { encoding: 'utf8', timeout: 15000 },
    );

    log(`🔄 Auto-advanced #${issueNumber}: ${currentLabel} → ${nextLabel} (${reason})`);
    return true;
  } catch (e: any) {
    log(`⚠️ Failed to auto-advance #${issueNumber}: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

// ── Layer 1: Post-exit reconciliation ───────────────────────────────────────

/**
 * Called after cleanDeadLocks detects a dead agent that ran > 2 min.
 * Checks if the issue label should be advanced.
 */
export function reconcileAfterExit(
  issueNumber: number,
  station: string,
  repo: string,
  pipelinesConfig: PipelinesConfig,
  log: (msg: string) => void,
): void {
  // Find the current stage label for this station
  const stageLabel = `station:${station === 'spec' ? 'intake' : station}`;

  // Find stage by stationId
  let stage: PipelineStageConfig | null = null;
  for (const pipeline of pipelinesConfig.pipelines) {
    for (const s of pipeline.stages) {
      if (s.stationId === station) {
        stage = s;
        break;
      }
    }
    if (stage) break;
  }

  if (!stage || !stage.nextLabel) {
    log(`  No stage/nextLabel found for station "${station}" — skipping reconciliation`);
    return;
  }

  // Check if issue still has the current stage label
  try {
    const labelsJson = execSync(
      `gh issue view ${issueNumber} --repo ${repo} --json labels --jq '[.labels[].name]'`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    const labels: string[] = JSON.parse(labelsJson);

    if (labels.includes(stage.label)) {
      // Label hasn't been flipped — check if work artifact exists
      const comments = execSync(
        `gh issue view ${issueNumber} --repo ${repo} --comments --json comments --jq '[.comments[].body]'`,
        { encoding: 'utf8', timeout: 15000 },
      ).trim();

      const artifactPattern = STAGE_ARTIFACTS[station];
      const hasArtifact = artifactPattern ? artifactPattern.test(comments) : true;

      if (hasArtifact) {
        // ── Artifact gate check (BUILD/BUGFIX only) ──
        if (ARTIFACT_GATES[station]) {
          // Determine the build repo (may differ from the pipeline repo)
          let buildRepo = repo;
          try {
            const bodyJson = execSync(
              `gh issue view ${issueNumber} --repo ${repo} --json body --jq '.body'`,
              { encoding: 'utf8', timeout: 15000 },
            ).trim();
            const buildRepoMatch = bodyJson.match(/BUILD_REPO[:\s]+([^\s\n]+)/i)
              || bodyJson.match(/github\.com\/([^/\s]+\/[^/\s]+)/);
            if (buildRepoMatch) {
              buildRepo = buildRepoMatch[1];
            }
          } catch {}

          const gateResult = checkArtifactGate(issueNumber, station, repo, buildRepo, log);
          if (!gateResult.pass) {
            bounceForArtifactGate(issueNumber, station, repo, stage.label, gateResult.missing, log);
            // Don't advance the label — leave it at current station for retry
            return;
          }
        }

        flipLabel(issueNumber, repo, stage.label, stage.nextLabel, log, `post-exit reconciliation: ${station} agent completed`);
      } else {
        log(`  #${issueNumber}: ${station} agent exited but no work artifact found — label unchanged`);
      }
    }
    // else: label already advanced, nothing to do
  } catch (e: any) {
    log(`  Reconciliation check failed for #${issueNumber}: ${e.message?.slice(0, 100)}`);
  }
}

// ── Layer 2: Guard auto-advance helper ──────────────────────────────────────

/**
 * Called by shouldProcess guards when they detect work is already done.
 * Flips the label and returns the skip reason.
 */
export function guardAutoAdvance(
  issueNumber: number,
  repo: string,
  currentLabel: string,
  nextLabel: string,
  log: (msg: string) => void,
  guardName: string,
): string {
  const flipped = flipLabel(
    issueNumber, repo, currentLabel, nextLabel, log,
    `guard auto-advance: ${guardName}`,
  );
  if (flipped) {
    return `${guardName} — auto-advanced to ${nextLabel}`;
  }
  return `${guardName} — label already correct or flip failed`;
}

// ── Layer 3: Periodic reconciliation sweep ──────────────────────────────────

const SWEEP_INTERVAL = 10; // Run every N ticks
let tickCount = 0;

/**
 * Run a full reconciliation sweep if enough ticks have passed.
 * Call this from the main loop after each tick.
 */
export function maybeSweep(
  repo: string,
  pipelinesConfig: PipelinesConfig,
  log: (msg: string) => void,
): void {
  tickCount++;
  if (tickCount < SWEEP_INTERVAL) return;
  tickCount = 0;

  log('🔍 Running periodic reconciliation sweep...');

  try {
    // Fetch all open issues with station labels
    const issuesJson = execSync(
      `gh issue list --repo ${repo} --state open --label "station:" --json number,labels --limit 50`,
      { encoding: 'utf8', timeout: 30000 },
    ).trim();

    // gh label filter might not work with prefix — fetch all and filter
    const allIssuesJson = execSync(
      `gh issue list --repo ${repo} --state open --json number,labels,title --limit 100`,
      { encoding: 'utf8', timeout: 30000 },
    ).trim();

    const issues = JSON.parse(allIssuesJson) as Array<{
      number: number;
      title: string;
      labels: Array<{ name: string }>;
    }>;

    let reconciled = 0;

    for (const issue of issues) {
      const labels = issue.labels.map(l => l.name);
      const stationLabels = labels.filter(l => l.startsWith('station:'));

      // Skip done/blocked/skip
      if (stationLabels.some(l => ['station:done', 'station:blocked', 'station:skip'].includes(l))) {
        continue;
      }

      // Skip if no station label
      if (stationLabels.length === 0) continue;

      // Fix dual labels — if multiple station labels, keep the most advanced one
      if (stationLabels.length > 1) {
        log(`  ⚠️ #${issue.number} has ${stationLabels.length} station labels: ${stationLabels.join(', ')}`);
        // Keep only the most advanced label
        const stageOrder = ['station:intake', 'station:spec', 'station:design', 'station:build', 'station:qa', 'station:uat', 'station:bugfix', 'station:done'];
        const sorted = stationLabels.sort((a, b) => stageOrder.indexOf(b) - stageOrder.indexOf(a));
        const keep = sorted[0];
        const remove = sorted.slice(1);
        for (const label of remove) {
          try {
            execSync(`gh issue edit ${issue.number} --repo ${repo} --remove-label "${label}"`, { encoding: 'utf8', timeout: 10000 });
            log(`  🧹 Removed stale label "${label}" from #${issue.number} (keeping "${keep}")`);
          } catch {}
        }
        reconciled++;
        continue;
      }

      const currentLabel = stationLabels[0];
      const stage = findStageByLabel(pipelinesConfig, currentLabel);
      if (!stage || !stage.nextLabel) continue;

      // Check if work artifact for this stage exists
      const artifactPattern = STAGE_ARTIFACTS[stage.stationId];
      if (!artifactPattern) continue;

      try {
        const comments = execSync(
          `gh issue view ${issue.number} --repo ${repo} --comments --json comments --jq '[.comments[].body]'`,
          { encoding: 'utf8', timeout: 15000 },
        ).trim();

        if (artifactPattern.test(comments)) {
          // Artifact gate check for sweep too
          if (ARTIFACT_GATES[stage.stationId]) {
            const gateResult = checkArtifactGate(issue.number, stage.stationId, repo, repo, log);
            if (!gateResult.pass) {
              bounceForArtifactGate(issue.number, stage.stationId, repo, currentLabel, gateResult.missing, log);
              reconciled++;
              continue;
            }
          }
          flipLabel(issue.number, repo, currentLabel, stage.nextLabel, log, 'periodic sweep');
          reconciled++;
        }
      } catch {}
    }

    if (reconciled > 0) {
      log(`🔍 Reconciliation sweep complete: ${reconciled} issue(s) fixed`);
    } else {
      log('🔍 Reconciliation sweep complete: no stuck issues found');
    }
  } catch (e: any) {
    log(`⚠️ Reconciliation sweep failed: ${e.message?.slice(0, 100)}`);
  }
}
