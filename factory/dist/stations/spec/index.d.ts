/**
 * SpecStation — processes issues at 'station:intake', produces 'station:spec'.
 *
 * Ported from makeSpecTask() in factory-loop.js.
 */
import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
export declare class SpecStation extends BaseStation {
    readonly id = "spec";
    readonly label = "station:intake";
    readonly nextLabel = "station:spec";
    readonly model = "claude-sonnet-4-6";
    readonly concurrency = 3;
    readonly ttl = 1800000;
    shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult>;
    /** Deep-validate manifest fields: required strings non-empty, business/problem min length */
    private validateManifest;
    buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask>;
}
//# sourceMappingURL=index.d.ts.map