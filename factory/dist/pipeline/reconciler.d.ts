/**
 * Label reconciliation for stuck issues.
 *
 * Three layers:
 * 1. Post-exit: Called from cleanDeadLocks() after agent dies — flips label if work artifact exists
 * 2. Guard auto-advance: Called from shouldProcess() guards — flips label if work already done
 * 3. Periodic sweep: Scans all open issues every N ticks — catches anything layers 1-2 missed
 */
import type { PipelinesConfig, PipelineStageConfig } from '../types/pipeline.js';
/**
 * Check if a PR's diff includes modifications to required artifact files.
 * Returns { pass: true } if all required artifacts are present,
 * or { pass: false, missing: string[] } with human-readable failure reasons.
 */
export declare function checkArtifactGate(issueNumber: number, station: string, repo: string, buildRepo: string, log: (msg: string) => void): {
    pass: boolean;
    missing: string[];
    warnings: string[];
};
/**
 * Find the pipeline stage for a given station label.
 */
export declare function findStageByLabel(pipelinesConfig: PipelinesConfig, stationLabel: string): PipelineStageConfig | null;
/**
 * Find the stage that produces a given label (i.e., stage.nextLabel === label).
 */
export declare function findStageByNextLabel(pipelinesConfig: PipelinesConfig, label: string): PipelineStageConfig | null;
/**
 * Flip an issue's station label from currentLabel to nextLabel.
 * Also cleans up any other station:* labels (fixes dual-label issues).
 */
export declare function flipLabel(issueNumber: number, repo: string, currentLabel: string, nextLabel: string, log: (msg: string) => void, reason: string): boolean;
/**
 * Called after cleanDeadLocks detects a dead agent that ran > 2 min.
 * Checks if the issue label should be advanced.
 */
export declare function reconcileAfterExit(issueNumber: number, station: string, repo: string, pipelinesConfig: PipelinesConfig, log: (msg: string) => void): void;
/**
 * Called by shouldProcess guards when they detect work is already done.
 * Flips the label and returns the skip reason.
 */
export declare function guardAutoAdvance(issueNumber: number, repo: string, currentLabel: string, nextLabel: string, log: (msg: string) => void, guardName: string): string;
/**
 * Run a full reconciliation sweep if enough ticks have passed.
 * Call this from the main loop after each tick.
 */
export declare function maybeSweep(repo: string, pipelinesConfig: PipelinesConfig, log: (msg: string) => void): void;
//# sourceMappingURL=reconciler.d.ts.map