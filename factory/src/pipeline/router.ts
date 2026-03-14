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

import { getIssuesByLabel } from '../github/issues.js';
import { spawnAgent } from '../agents/spawn.js';
import { lockKey } from '../core/locks.js';
import type { StationRegistry } from '../stations/registry.js';
import type { FactoryContext } from '../stations/base.js';
import type { LockManager } from '../types/index.js';
import type { PipelinesConfig } from '../types/pipeline.js';
import { PipelineDetector } from './detector.js';

// ─── Context extension for the router ────────────────────────────────────────

/**
 * Full context needed by the PipelineRouter.
 * Extends FactoryContext with runtime services that aren't in the lightweight
 * station FactoryContext (locks, spawn helpers, crash backoff, concurrency cap).
 */
export interface PipelineRouterContext extends FactoryContext {
  /** Loaded pipelines.json configuration */
  pipelinesConfig: PipelinesConfig;

  /** Lock manager for concurrency control */
  locks: LockManager;

  /** Max total agents to spawn per tick */
  maxTasksPerRun: number;

  /** Whether to use claude CLI (true) or openclaw agent (false) */
  useClaudeCli: boolean;

  /** Crash backoff check — return true if the key is currently backed off */
  isInCrashBackoff: (key: string) => boolean;

  /** Current API key for agent spawning */
  getCurrentKey: () => string;

  /** Build environment vars for agent spawn */
  buildAgentEnv: (apiKey: string) => NodeJS.ProcessEnv;
}

// ─── PipelineRouter ───────────────────────────────────────────────────────────

export class PipelineRouter {
  private readonly detector: PipelineDetector;

  constructor(
    private readonly registry: StationRegistry,
    private readonly ctx: PipelineRouterContext,
  ) {
    this.detector = new PipelineDetector(ctx.pipelinesConfig, registry);
  }

  /**
   * Main routing pass.
   * Iterates all active labels across all pipelines, fetches issues,
   * checks gates, and spawns agents.
   *
   * @returns Number of agents spawned this tick.
   */
  async route(): Promise<number> {
    const { ctx } = this;
    let spawned = 0;

    const allLabels = this.getAllActiveLabels();
    ctx.log(`PipelineRouter: scanning ${allLabels.length} active labels across ${ctx.pipelinesConfig.pipelines.length} pipelines`);

    for (const label of allLabels) {
      if (spawned >= ctx.maxTasksPerRun) break;

      let issues;
      try {
        issues = getIssuesByLabel(label, ctx.env.repo, 20);
        ctx.log(`  ${label} → ${issues.length} issues`);
      } catch (e: any) {
        ctx.log(`  Error fetching issues for label "${label}": ${e.message}`);
        continue;
      }

      for (const rawIssue of issues) {
        if (spawned >= ctx.maxTasksPerRun) break;

        // Enrich raw issue into Issue shape (labels as string[])
        const issue = {
          ...rawIssue,
          labels: (rawIssue.labels ?? []).map((l: any) =>
            typeof l === 'string' ? l : l.name,
          ) as string[],
          raw: rawIssue,
          manifest: null,
          isChangeRequest: (rawIssue.title ?? '').startsWith('[Change]'),
          isInternal: (rawIssue.labels ?? []).some(
            (l: any) => (typeof l === 'string' ? l : l.name) === 'type:internal',
          ),
          isPhase2: (rawIssue.labels ?? []).some(
            (l: any) => (typeof l === 'string' ? l : l.name) === 'type:phase2',
          ),
          complexity: null as null | 'simple' | 'medium' | 'complex',
          body: rawIssue.body ?? '',
          url: rawIssue.url ?? '',
          number: rawIssue.number,
          title: rawIssue.title ?? '',
        };

        // Detect pipeline and current stage
        let pipeline, stage;
        try {
          const resolved = this.detector.resolve(issue as any);
          pipeline = resolved.pipeline;
          stage = resolved.stage;
        } catch (e: any) {
          ctx.log(`  #${issue.number}: pipeline detection error — ${e.message}`);
          continue;
        }

        if (!stage) {
          // Issue has no label matching any stage in its pipeline — skip
          continue;
        }

        // Check if the current label matches what we're iterating
        // (avoid double-processing the same issue via two labels in the same tick)
        if (stage.label !== label) continue;

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

        // Station gate: shouldProcess()
        let shouldResult;
        try {
          shouldResult = await station.shouldProcess(issue as any, ctx);
        } catch (e: any) {
          ctx.log(`  #${issue.number} shouldProcess threw: ${e.message}`);
          continue;
        }

        if (!shouldResult.process) {
          ctx.log(`  Skip #${issue.number} [${station.id}]: ${shouldResult.reason ?? 'no reason'}`);
          continue;
        }

        // Build the agent task
        let task;
        try {
          task = await station.buildTask(issue as any, ctx);
          
          // Resolve model: stage override > station config > error
          const stationConfig = ctx.config.stations[station.id];
          const effectiveModel = stage.model ?? stationConfig?.model;
          
          if (!effectiveModel) {
            ctx.log(`  #${issue.number}: ERROR — no model configured for station "${station.id}"`);
            continue;
          }
          
          task.model = effectiveModel;
        } catch (e: any) {
          ctx.log(`  #${issue.number} buildTask threw: ${e.message}`);
          continue;
        }

        // Spawn the agent
        ctx.log(`  Spawning ${station.id.toUpperCase()} agent for #${issue.number}: ${issue.title} [model: ${task.model}]`);
        const handle = spawnAgent(
          task,
          ctx.useClaudeCli,
          ctx.buildAgentEnv,
          ctx.getCurrentKey,
          ctx.log,
        );

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
  getAllActiveLabels(): string[] {
    const labels = new Set<string>();
    for (const pipeline of this.ctx.pipelinesConfig.pipelines) {
      for (const stage of pipeline.stages) {
        labels.add(stage.label);
      }
    }
    return [...labels];
  }
}
