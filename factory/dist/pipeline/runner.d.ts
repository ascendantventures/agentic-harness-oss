/**
 * Main tick() orchestrator — registry-driven pipeline (Phase 2).
 *
 * Each station is a self-contained module registered in StationRegistry.
 * The runner:
 *   1. Fetches issues by station.label
 *   2. Calls station.shouldProcess(enrichedIssue, ctx)
 *   3. Checks locks and crash backoff
 *   4. Calls station.buildTask() and spawns the agent
 *
 * Behaviour is identical to factory-loop.js — only the dispatch mechanism changed.
 */
import type { LockFile, LockEntry } from '../types/index.js';
export interface RunnerDeps {
    config?: import('../types/index.js').Config;
    REPO: string;
    SUPABASE_URL: string;
    SUPABASE_KEY: string;
    FACTORY_SECRET: string;
    FACTORY_APP_URL: string;
    DISCORD_WEBHOOK_URL: string;
    MAX_TASKS_PER_RUN: number;
    USE_CLAUDE_CLI: boolean;
    LOCK_FILE: string;
    CRASH_BACKOFF_FILE: string;
    LOG_FILE: string;
    log: (msg: string) => void;
    getLocks: () => LockFile;
    setLock: (key: string, meta: Omit<LockEntry, 'ts'>) => void;
    isLocked: (key: string) => boolean;
    countActiveLocks: (station: string) => number;
    isInCrashBackoff: (key: string) => boolean;
    getCurrentKey: () => string;
    buildAgentEnv: (apiKey: string) => NodeJS.ProcessEnv;
    rotateApiKey: (reason: string) => void;
    checkLogForKeyError: (logPath: string) => boolean;
}
export declare function tick(deps: RunnerDeps): Promise<void>;
import type { PipelinesConfig } from '../types/pipeline.js';
/**
 * RunnerDepsV2 — extends RunnerDeps with the Phase 3 pipeline additions.
 * Build this in loop.ts after loading pipelines.json and creating the registry.
 */
export interface RunnerDepsV2 extends RunnerDeps {
    /** Loaded pipelines.json — passed from loop.ts */
    pipelinesConfig: PipelinesConfig;
    /** Fully populated station registry — from StationRegistry.createDefault() */
    registry: import('../stations/registry.js').StationRegistry;
    /** Backoff manager — for retry cap checks */
    backoffManager: import('../types/index.js').BackoffManager;
}
/**
 * tickV2() — Phase 3 factory loop tick (multi-pipeline).
 *
 * Replaces direct station iteration with PipelineRouter.
 * Adding a new pipeline = edit pipelines.json + register stations.
 * No changes needed here.
 *
 * Preserves syncDoneStations() from tick() for production parity.
 */
export declare function tickV2(deps: RunnerDepsV2): Promise<void>;
//# sourceMappingURL=runner.d.ts.map