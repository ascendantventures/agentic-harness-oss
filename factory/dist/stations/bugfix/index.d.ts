/**
 * BugfixStation — processes issues at 'station:bugfix', sends back to 'station:build'.
 *
 * Ported from makeBugfixTask() in factory-loop.js.
 *
 * Note: Change requests at station:bugfix use the BUILD prompt instead.
 * The runner handles this routing decision; BugfixStation provides the default prompt.
 */
import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
export declare class BugfixStation extends BaseStation {
    readonly id = "bugfix";
    readonly label = "station:bugfix";
    readonly nextLabel = "station:provisioned";
    readonly model = "claude-sonnet-4-6";
    readonly concurrency = 1;
    readonly ttl = 7200000;
    shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult>;
    buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask>;
}
//# sourceMappingURL=index.d.ts.map