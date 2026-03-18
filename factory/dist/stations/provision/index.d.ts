/**
 * ProvisionStation — creates Supabase project, runs migrations, injects env vars into Vercel,
 * and triggers a redeploy. Runs after build merges (station:build), before QA (station:qa).
 *
 * Pipeline position: build → provision → qa
 * Triggers on: station:provision
 * Advances to: station:qa (on success) or station:stuck (on hard failure)
 *
 * This station is synchronous (no agent spawn) — it executes directly in the loop
 * via directRun() rather than spawning a Claude Code agent.
 */
import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
export declare class ProvisionStation extends BaseStation {
    readonly id = "provision";
    readonly label = "station:build";
    readonly nextLabel = "station:provisioned";
    readonly model = "claude-sonnet-4-6";
    readonly concurrency = 2;
    readonly ttl = 600000;
    shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult>;
    buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask>;
    /**
     * Direct execution — called by the router instead of spawning an agent.
     * Returns true on success (flips to station:qa), false on failure.
     */
    directRun(issue: Issue, ctx: FactoryContext): Promise<boolean>;
    private findExistingProject;
    private createProject;
    private waitForActive;
    private getProjectKeys;
    private runMigrations;
    private injectVercelEnvVars;
    private triggerRedeploy;
    private commentSuccess;
    private commentFailure;
    private extractBuildRepo;
    private generatePassword;
    private sleep;
}
//# sourceMappingURL=index.d.ts.map