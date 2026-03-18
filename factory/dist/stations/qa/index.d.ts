/**
 * QAStation — processes issues at 'station:build', produces 'station:qa'.
 *
 * Ported from makeQATask() in factory-loop.js.
 *
 * Gates:
 *   1. Base checks (skip/paused/phase2)
 *   2. Manifest check
 *   3. Internal issues signal auto-pass (runner handles label flip)
 *   4. hasBuildMovedSinceLastQA (skip if no new commits since last QA failure)
 */
import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
export interface QAInfo {
    hasFailedQA: boolean;
    lastQAAt?: string;
    buildRepo: string | null;
}
/** Find the last QA comment and whether it was a FAIL. Also extracts build repo URL. */
export declare function getLastQAInfo(issueNumber: number, repo: string, log: (m: string) => void): QAInfo;
/** Check whether the build repo has new commits since the last QA failure. */
export declare function hasBuildMovedSinceLastQA(buildRepo: string | null, lastQAAt: string | undefined, log: (m: string) => void): boolean;
export declare class QAStation extends BaseStation {
    readonly id = "qa";
    readonly label = "station:provisioned";
    readonly nextLabel = "station:qa";
    readonly model = "claude-sonnet-4-6";
    readonly concurrency = 3;
    readonly ttl = 1800000;
    /** Set when shouldProcess returns false due to build not moving — used by runner for stall tracking. */
    lastQAInfo?: QAInfo;
    shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult>;
    buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask>;
}
//# sourceMappingURL=index.d.ts.map