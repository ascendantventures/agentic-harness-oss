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
import type { StationRegistry } from '../stations/registry.js';
import type { FactoryContext } from '../stations/base.js';
import type { LockManager, BackoffManager } from '../types/index.js';
import type { PipelinesConfig } from '../types/pipeline.js';
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
    /** Backoff manager — for retry cap checks */
    backoffManager: BackoffManager;
    /** Current API key for agent spawning */
    getCurrentKey: () => string;
    /** Build environment vars for agent spawn */
    buildAgentEnv: (apiKey: string) => NodeJS.ProcessEnv;
}
export declare class PipelineRouter {
    private readonly registry;
    private readonly ctx;
    private readonly detector;
    constructor(registry: StationRegistry, ctx: PipelineRouterContext);
    /**
     * Main routing pass.
     * Iterates all active labels across all pipelines, fetches issues,
     * checks gates, and spawns agents.
     *
     * @returns Number of agents spawned this tick.
     */
    route(): Promise<number>;
    /**
     * Collect all distinct labels referenced by any stage across all pipelines.
     * The router fetches issues for each of these labels each tick.
     */
    getAllActiveLabels(): string[];
}
//# sourceMappingURL=router.d.ts.map