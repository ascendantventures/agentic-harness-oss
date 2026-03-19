/**
 * BaseStation — abstract base class for all factory stations.
 *
 * Each concrete station:
 *  - Declares its own id, label, nextLabel, model, concurrency, ttl
 *  - Implements shouldProcess() with station-specific gates
 *  - Implements buildTask() with the full agent prompt
 *  - Inherits shared utility methods from this class
 */

import type { Issue, AgentTask, Config } from '../types/index.js';

// ─── ShouldProcessResult ───────────────────────────────────────────────────────

export interface ShouldProcessResult {
  process: boolean;
  /** Reason why skipped, for logging */
  reason?: string;
}

// ─── FactoryContext (lightweight) ─────────────────────────────────────────────

/** Minimal context passed to station methods */
export interface FactoryContext {
  config: Config;
  env: FactoryEnv;
  log: (msg: string) => void;
}

export interface FactoryEnv {
  repo: string;
  supabaseUrl: string;
  supabaseKey: string;
  factorySecret: string;
  factoryAppUrl: string;
  discordWebhookUrl: string;
  useClaudeCli: boolean;
  logFile: string;
}

// ─── BaseStation ───────────────────────────────────────────────────────────────

export abstract class BaseStation {
  /** Unique station identifier (e.g., 'spec', 'design', 'build') */
  abstract readonly id: string;

  /** GitHub label that triggers this station (e.g., 'station:intake') */
  abstract readonly label: string;

  /** GitHub label to apply on completion (e.g., 'station:spec') */
  abstract readonly nextLabel: string;

  /** Claude model to use */
  abstract readonly model: string;

  /** Max concurrent agents for this station */
  abstract readonly concurrency: number;

  /** Max ms before a lock is considered hung (normal issues) */
  abstract readonly ttl: number;

  /**
   * Decide whether to process this issue at this station.
   * Return { process: false, reason } to skip with logging.
   */
  abstract shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult>;

  /**
   * Build the agent task (full prompt) for this issue.
   * Called only when shouldProcess returns { process: true }.
   */
  abstract buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask>;

  // ─── Shared utility methods ───────────────────────────────────────────────

  protected hasLabel(issue: Issue, label: string): boolean {
    return issue.labels.includes(label);
  }

  protected hasAnyLabel(issue: Issue, labels: string[]): boolean {
    return labels.some((l) => issue.labels.includes(l));
  }

  protected isSimple(issue: Issue): boolean {
    return issue.complexity === 'simple';
  }

  /**
   * Effective TTL: use shorter LOCK_TTL_SIMPLE for complexity:simple issues.
   * Matches the getLockTTL() logic from the monolith exactly.
   */
  protected getEffectiveTTL(issue: Issue): number {
    if (!this.isSimple(issue)) return this.ttl;
    // Simple TTL is half the normal TTL (matches monolith LOCK_TTL_SIMPLE)
    const SIMPLE_TTLS: Record<string, number> = {
      spec: 900000,
      qa: 900000,
      design: 1800000,
      build: 1800000,
      bugfix: 1800000,
    };
    return SIMPLE_TTLS[this.id] ?? this.ttl;
  }

  protected log(ctx: FactoryContext, msg: string): void {
    ctx.log(`[${this.id.toUpperCase()}] ${msg}`);
  }

  /**
   * Common shouldProcess checks shared by all stations:
   *   - station:skip → skip
   *   - status:paused → skip
   *   - type:phase2 → skip
   *
   * Returns null if all checks pass (caller should continue with its own checks).
   */
  protected async baseCheck(issue: Issue, _ctx: FactoryContext): Promise<ShouldProcessResult | null> {
    if (this.hasLabel(issue, 'station:skip')) {
      return { process: false, reason: 'has station:skip label' };
    }
    if (this.hasLabel(issue, 'status:paused')) {
      return { process: false, reason: 'status:paused (manually paused by operator)' };
    }
    if (this.hasLabel(issue, 'type:phase2')) {
      return { process: false, reason: 'type:phase2 (deferred backlog, not ready for factory)' };
    }
    return null; // all base checks passed
  }

  /**
   * Manifest check: skip if invalid manifest (unless internal/change/standalone).
   * Ports the shouldProcess() logic from the monolith exactly.
   */
  protected manifestCheck(issue: Issue, env: FactoryEnv): ShouldProcessResult | null {
    const standaloneMode = !env.supabaseUrl;
    // BUG / UAT Fix / Spec Revision issues don't have a manifest — always let them through
    const isBugOrFix = /^\[(BUG|UAT Fix|Spec Revision|Fix)\]/i.test(issue.title);
    if (!issue.isInternal && !issue.isChangeRequest && !isBugOrFix && !standaloneMode) {
      // isValidManifest is computed at enrichment time — manifest non-null means valid
      if (!issue.manifest) {
        return { process: false, reason: `invalid or empty manifest ("${issue.title}")` };
      }
    }
    return null; // manifest ok
  }
}
