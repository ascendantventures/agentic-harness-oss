/**
 * PipelineRouter — routes issues to stations based on pipeline configuration.
 *
 * Instead of hardcoded station iteration (the old runner.ts approach), the router:
 *   1. Collects all active labels across all configured pipelines
 *   2. Fetches issues for each label via GitHub
 *   3. Detects which pipeline/stage each issue belongs to
 *   4. Checks concurrency limits and lock state
 *   5. Calls station.shouldProcess() to run station-specific gates
 *   6. Calls station.buildTask() to build the agent task
 *   7. Spawns the agent via spawnAgent()
 *
 * Adding a new pipeline = edit pipelines.json. No code changes here.
 */
import { getIssuesByLabel, extractManifest } from '../github/issues.js';
import { spawnAgent } from '../agents/spawn.js';
import { lockKey } from '../core/locks.js';
import { DEFAULT_MAX_RETRIES } from '../core/backoff.js';
import { flipLabel } from './reconciler.js';
import { PipelineDetector } from './detector.js';
// ─── PipelineRouter ───────────────────────────────────────────────────────────
export class PipelineRouter {
    registry;
    ctx;
    detector;
    constructor(registry, ctx) {
        this.registry = registry;
        this.ctx = ctx;
        this.detector = new PipelineDetector(ctx.pipelinesConfig, registry);
    }
    /**
     * Main routing pass.
     * Iterates all active labels across all pipelines, fetches issues,
     * checks gates, and spawns agents.
     *
     * @returns Number of agents spawned this tick.
     */
    async route() {
        const { ctx } = this;
        let spawned = 0;
        const allLabels = this.getAllActiveLabels();
        ctx.log(`PipelineRouter: scanning ${allLabels.length} active labels across ${ctx.pipelinesConfig.pipelines.length} pipelines`);
        for (const label of allLabels) {
            if (spawned >= ctx.maxTasksPerRun)
                break;
            let issues;
            try {
                issues = getIssuesByLabel(label, ctx.env.repo, 20);
                ctx.log(`  ${label} → ${issues.length} issues`);
            }
            catch (e) {
                ctx.log(`  Error fetching issues for label "${label}": ${e.message}`);
                continue;
            }
            for (const rawIssue of issues) {
                if (spawned >= ctx.maxTasksPerRun)
                    break;
                // Enrich raw issue into Issue shape (labels as string[])
                const issue = {
                    ...rawIssue,
                    labels: (rawIssue.labels ?? []).map((l) => typeof l === 'string' ? l : l.name),
                    raw: rawIssue,
                    manifest: extractManifest(rawIssue.body),
                    isChangeRequest: (rawIssue.title ?? '').startsWith('[Change]'),
                    isInternal: (rawIssue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'type:internal'),
                    isPhase2: (rawIssue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'type:phase2'),
                    complexity: null,
                    body: rawIssue.body ?? '',
                    url: rawIssue.url ?? '',
                    number: rawIssue.number,
                    title: rawIssue.title ?? '',
                };
                // Detect pipeline and current stage
                let pipeline, stage;
                try {
                    const resolved = this.detector.resolve(issue);
                    pipeline = resolved.pipeline;
                    stage = resolved.stage;
                }
                catch (e) {
                    ctx.log(`  #${issue.number}: pipeline detection error — ${e.message}`);
                    continue;
                }
                if (!stage) {
                    // Issue has no label matching any stage in its pipeline — skip
                    continue;
                }
                // Check if the current label matches what we're iterating
                // (avoid double-processing the same issue via two labels in the same tick)
                if (stage.label !== label)
                    continue;
                // Look up the station
                const station = this.registry.get(stage.stationId);
                if (!station) {
                    ctx.log(`  #${issue.number}: no station registered for id "${stage.stationId}" (pipeline: ${pipeline.id}, stage: ${stage.label})`);
                    continue;
                }
                // Concurrency: apply stage override, fall back to station default
                const effectiveConcurrency = stage.concurrency ?? station.concurrency;
                if (ctx.locks.countActiveLocks(station.id) >= effectiveConcurrency) {
                    ctx.log(`  ${station.id.toUpperCase()} at capacity (${effectiveConcurrency}) — skipping #${issue.number}`);
                    continue;
                }
                // Lock check
                const key = lockKey(issue.number, station.id);
                if (ctx.locks.isLocked(key)) {
                    ctx.log(`  ${station.id.toUpperCase()} already locked for #${issue.number}`);
                    continue;
                }
                // Crash backoff
                if (ctx.isInCrashBackoff(key)) {
                    ctx.log(`  #${issue.number} in crash backoff for ${station.id}`);
                    continue;
                }
                // Retry cap — shelve issues that have exceeded max retries
                const stationMaxRetries = ctx.config.stations[station.id]?.settings?.maxRetries
                    ?? DEFAULT_MAX_RETRIES[station.id] ?? 5;
                if (ctx.backoffManager.isMaxedOut(key, stationMaxRetries)) {
                    // Don't spawn — LockManager.cleanDeadLocks handles the shelving
                    continue;
                }
                // Station gate: shouldProcess()
                let shouldResult;
                try {
                    shouldResult = await station.shouldProcess(issue, ctx);
                }
                catch (e) {
                    ctx.log(`  #${issue.number} shouldProcess threw: ${e.message}`);
                    continue;
                }
                if (!shouldResult.process) {
                    ctx.log(`  Skip #${issue.number} [${station.id}]: ${shouldResult.reason ?? 'no reason'}`);
                    continue;
                }
                // Check if station supports directRun (synchronous execution, no agent spawn)
                const stationAny = station;
                if (typeof stationAny.directRun === 'function') {
                    ctx.log(`  Running ${station.id.toUpperCase()} directly for #${issue.number}: ${issue.title}`);
                    // Acquire lock before running to prevent double-execution
                    ctx.locks.setLock(key, {
                        issue: issue.number,
                        station: station.id,
                        pid: process.pid,
                        logFile: ctx.env.logFile,
                    });
                    try {
                        await stationAny.directRun(issue, ctx);
                    }
                    catch (e) {
                        ctx.log(`  ${station.id.toUpperCase()} directRun threw: ${e.message}`);
                    }
                    finally {
                        ctx.locks.removeLock(key);
                    }
                    spawned++;
                    continue;
                }
                // Build the agent task
                let task;
                try {
                    task = await station.buildTask(issue, ctx);
                    // Resolve model: stage override > station config > error
                    const stationConfig = ctx.config.stations[station.id];
                    const effectiveModel = stage.model ?? stationConfig?.model;
                    if (!effectiveModel) {
                        ctx.log(`  #${issue.number}: ERROR — no model configured for station "${station.id}"`);
                        continue;
                    }
                    task.model = effectiveModel;
                }
                catch (e) {
                    ctx.log(`  #${issue.number} buildTask threw: ${e.message}`);
                    continue;
                }
                // Spawn the agent
                ctx.log(`  Spawning ${station.id.toUpperCase()} agent for #${issue.number}: ${issue.title} [model: ${task.model}]`);
                const handle = spawnAgent(task, ctx.useClaudeCli, ctx.buildAgentEnv, ctx.getCurrentKey, ctx.log);
                // Flip label at spawn time so the dashboard reflects "in progress"
                // Only for stations where the output artifact is NOT checked by a guard
                // (spec/design have guards that revert if artifacts are missing)
                const noFlipStations = ['spec', 'design', 'build'];
                if (stage.nextLabel && !noFlipStations.includes(station.id)) {
                    flipLabel(issue.number, ctx.env.repo, stage.label, stage.nextLabel, ctx.log, `spawn-time flip: ${station.id} agent started`);
                }
                // Acquire lock
                ctx.locks.setLock(key, {
                    issue: issue.number,
                    station: station.id,
                    pid: handle.pid,
                    logFile: handle.logFile,
                });
                spawned++;
            }
        }
        return spawned;
    }
    /**
     * Collect all distinct labels referenced by any stage across all pipelines.
     * The router fetches issues for each of these labels each tick.
     */
    getAllActiveLabels() {
        const labels = new Set();
        for (const pipeline of this.ctx.pipelinesConfig.pipelines) {
            for (const stage of pipeline.stages) {
                labels.add(stage.label);
            }
        }
        return [...labels];
    }
}
//# sourceMappingURL=router.js.map