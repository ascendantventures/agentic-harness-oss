/**
 * BaseStation — abstract base class for all factory stations.
 *
 * Each concrete station:
 *  - Declares its own id, label, nextLabel, model, concurrency, ttl
 *  - Implements shouldProcess() with station-specific gates
 *  - Implements buildTask() with the full agent prompt
 *  - Inherits shared utility methods from this class
 */
// ─── BaseStation ───────────────────────────────────────────────────────────────
export class BaseStation {
    // ─── Shared utility methods ───────────────────────────────────────────────
    hasLabel(issue, label) {
        return issue.labels.includes(label);
    }
    hasAnyLabel(issue, labels) {
        return labels.some((l) => issue.labels.includes(l));
    }
    isSimple(issue) {
        return issue.complexity === 'simple';
    }
    /**
     * Effective TTL: use shorter LOCK_TTL_SIMPLE for complexity:simple issues.
     * Matches the getLockTTL() logic from the monolith exactly.
     */
    getEffectiveTTL(issue) {
        if (!this.isSimple(issue))
            return this.ttl;
        // Simple TTL is half the normal TTL (matches monolith LOCK_TTL_SIMPLE)
        const SIMPLE_TTLS = {
            spec: 900000,
            qa: 900000,
            design: 1800000,
            build: 1800000,
            bugfix: 1800000,
        };
        return SIMPLE_TTLS[this.id] ?? this.ttl;
    }
    log(ctx, msg) {
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
    async baseCheck(issue, _ctx) {
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
    manifestCheck(issue, env) {
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
//# sourceMappingURL=base.js.map