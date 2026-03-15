/**
 * BuildStation — processes issues at 'station:design', produces 'station:build'.
 *
 * Gates:
 *  1. Base checks (skip/paused/phase2)
 *  2. Manifest check
 *  3. spec_approved gate
 *  4. hasDesignComment (if not, re-spawn design)
 *  5. checkDesignQuality (if fails, reject design back to spec)
 */
import type { Issue, AgentTask, TemplateConfig } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
export declare const DEFAULT_TEMPLATE_REGISTRY: Record<string, TemplateConfig>;
/**
 * Build the effective template registry by merging config overrides with defaults.
 * If config.templates.entries is set, those repos are used; otherwise defaults apply.
 */
export declare function getTemplateRegistry(ctx: FactoryContext): Record<string, TemplateConfig>;
export declare function resolveTemplate(techStack: string | string[] | undefined, projectType: string | undefined, registry?: Record<string, TemplateConfig>): string;
export declare class BuildStation extends BaseStation {
    readonly id = "build";
    readonly label = "station:design";
    readonly nextLabel = "station:build";
    readonly model = "claude-sonnet-4-6";
    readonly concurrency = 3;
    readonly ttl = 7200000;
    /**
     * Returned when design quality fails or design is missing.
     * Caller (runner.ts) must handle these side-effects.
     */
    designAction?: {
        action: 'respawn-design' | 'reject-design' | 'pause-design';
        issueNumber: number;
        reason?: string;
    };
    shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult>;
    buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask>;
    private buildChangeRequestTask;
    private buildInternalTask;
    private buildStandardTask;
}
//# sourceMappingURL=index.d.ts.map