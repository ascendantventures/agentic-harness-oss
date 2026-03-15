import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { reconcileAfterExit } from '../pipeline/reconciler.js';
import { DEFAULT_MAX_RETRIES, MAX_EMPTY_RETRIES } from './backoff.js';
/** Per-station lock TTL — complexity:simple gets shorter TTLs */
export const LOCK_TTL = {
    spec: 1800000,
    qa: 1800000,
    design: 7200000,
    build: 7200000,
    bugfix: 7200000,
};
export const LOCK_TTL_SIMPLE = {
    spec: 900000,
    qa: 900000,
    design: 1800000,
    build: 1800000,
    bugfix: 1800000,
};
export function getLockTTL(station, isSimple) {
    const ttls = isSimple ? LOCK_TTL_SIMPLE : LOCK_TTL;
    return ttls[station] ?? 7200000;
}
/** PID liveness check */
export function isProcessAlive(pid) {
    if (!pid)
        return true; // no PID stored = legacy lock, don't clean
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function lockKey(issueNumber, station) {
    return `${issueNumber}-${station}`;
}
export class LockManagerImpl {
    lockFile;
    agentActivityFile;
    log;
    crashBackoff;
    saveCrashBackoff;
    rotateApiKey;
    checkLogForKeyError;
    writeTokenUsageAsync;
    notifyDiscord;
    pipelinesConfig;
    repo;
    constructor(lockFile, agentActivityFile, log, crashBackoff, saveCrashBackoff, rotateApiKey, checkLogForKeyError, writeTokenUsageAsync, notifyDiscord, pipelinesConfig, repo) {
        this.lockFile = lockFile;
        this.agentActivityFile = agentActivityFile;
        this.log = log;
        this.crashBackoff = crashBackoff;
        this.saveCrashBackoff = saveCrashBackoff;
        this.rotateApiKey = rotateApiKey;
        this.checkLogForKeyError = checkLogForKeyError;
        this.writeTokenUsageAsync = writeTokenUsageAsync;
        this.notifyDiscord = notifyDiscord;
        this.pipelinesConfig = pipelinesConfig;
        this.repo = repo;
    }
    /** Set pipelines config for post-exit label reconciliation */
    setPipelinesConfig(config, repo) {
        this.pipelinesConfig = config;
        this.repo = repo;
    }
    /**
     * Shelve a stuck issue: replace its station label with station:stuck,
     * post a comment explaining why, and notify Discord.
     */
    shelveIssue(issueNumber, station, reason) {
        if (!this.repo)
            return;
        try {
            // Find and remove current station labels, add station:stuck
            const labelsJson = execSync(`gh issue view ${issueNumber} --repo ${this.repo} --json labels --jq '[.labels[].name]'`, { encoding: 'utf8', timeout: 10000 }).trim();
            const labels = JSON.parse(labelsJson);
            const stationLabels = labels.filter(l => l.startsWith('station:'));
            for (const sl of stationLabels) {
                execSync(`gh issue edit ${issueNumber} --repo ${this.repo} --remove-label "${sl}"`, { encoding: 'utf8', timeout: 10000 });
            }
            execSync(`gh issue edit ${issueNumber} --repo ${this.repo} --add-label "station:stuck"`, { encoding: 'utf8', timeout: 10000 });
            // Post a comment
            const comment = `## 🚫 Issue shelved — retry cap exceeded\n\n**Station:** ${station}\n**Reason:** ${reason}\n\nThis issue has been automatically moved to \`station:stuck\` after exceeding the retry limit. A human should review the failure logs and either:\n1. Fix the underlying issue and re-label to the appropriate station\n2. Close the issue if no longer needed\n\nTo retry: remove \`station:stuck\`, add the appropriate station label, and clear the crash backoff file entry.`;
            execSync(`gh issue comment ${issueNumber} --repo ${this.repo} --body ${JSON.stringify(comment)}`, { encoding: 'utf8', timeout: 15000 });
            this.notifyDiscord(`🚫 Issue #${issueNumber} shelved (\`station:stuck\`): ${reason}. Needs human review.`).catch(() => { });
            this.log(`  ✅ #${issueNumber} moved to station:stuck`);
        }
        catch (e) {
            this.log(`  ⚠️ Failed to shelve #${issueNumber}: ${e.message?.slice(0, 100)}`);
        }
    }
    getLocks() {
        try {
            if (existsSync(this.lockFile)) {
                const data = JSON.parse(readFileSync(this.lockFile, 'utf8'));
                const now = Date.now();
                return Object.fromEntries(Object.entries(data).filter(([k, v]) => {
                    const station = k.split('-').slice(1).join('-');
                    const ttl = getLockTTL(station, v.simple);
                    return now - v.ts < ttl;
                }));
            }
        }
        catch { }
        return {};
    }
    setLock(key, meta) {
        const locks = this.getLocks();
        locks[key] = { ts: Date.now(), ...meta };
        writeFileSync(this.lockFile, JSON.stringify(locks, null, 2));
    }
    removeLock(key) {
        const locks = this.getLocks();
        delete locks[key];
        writeFileSync(this.lockFile, JSON.stringify(locks, null, 2));
    }
    isLocked(key) {
        return !!this.getLocks()[key];
    }
    countActiveLocks(station) {
        const locks = this.getLocks();
        return Object.entries(locks).filter(([k, v]) => v.station === station && this.isLocked(k)).length;
    }
    cleanDeadLocks() {
        try {
            if (!existsSync(this.lockFile))
                return;
            const data = JSON.parse(readFileSync(this.lockFile, 'utf8'));
            // Load activity file up-front so dead-lock cleanup can prune stale PID entries
            let agentActivity = {};
            try {
                agentActivity = JSON.parse(readFileSync(this.agentActivityFile, 'utf8'));
            }
            catch { }
            let cleaned = 0;
            for (const [key, val] of Object.entries(data)) {
                if (val.pid && !isProcessAlive(val.pid)) {
                    this.log(`🧹 Cleaning dead lock: ${key} (pid ${val.pid} no longer alive)`);
                    // Crash backoff: if agent died in < 2 min, track it to prevent notification spam
                    const ageLs = Date.now() - (val.ts ?? 0);
                    if (ageLs < 120000) {
                        // Check if failure was due to invalid API key — rotate immediately
                        const agentLogPath = val.logFile;
                        if (agentLogPath && this.checkLogForKeyError(agentLogPath)) {
                            this.rotateApiKey(`fast-fail on ${key}`);
                        }
                        // Track empty (0-byte) log failures separately
                        let logSize = -1;
                        if (val.logFile) {
                            try {
                                logSize = existsSync(val.logFile) ? statSync(val.logFile).size : 0;
                            }
                            catch {
                                logSize = 0;
                            }
                        }
                        const prev = this.crashBackoff.get(key) ?? { failures: 0, until: 0 };
                        const failures = prev.failures + 1;
                        let emptyRuns = prev.emptyRuns ?? 0;
                        if (logSize === 0)
                            emptyRuns++;
                        const backoffMs = Math.min(failures * 5 * 60000, 30 * 60000); // 5m, 10m, 15m... max 30m
                        this.crashBackoff.set(key, { failures, until: Date.now() + backoffMs, emptyRuns });
                        this.saveCrashBackoff(this.crashBackoff);
                        const maxRetries = DEFAULT_MAX_RETRIES[val.station] ?? 5;
                        const isMaxed = failures >= maxRetries || emptyRuns >= MAX_EMPTY_RETRIES;
                        if (isMaxed && val.issue && val.station && this.repo) {
                            // Shelve the issue — label it station:stuck so it stops retrying
                            const reason = emptyRuns >= MAX_EMPTY_RETRIES
                                ? `${emptyRuns} empty-log failures (env/setup issue)`
                                : `${failures} consecutive failures (max ${maxRetries})`;
                            this.log(`🚫 Shelving #${val.issue} (${val.station}): ${reason}`);
                            this.shelveIssue(val.issue, val.station, reason);
                        }
                        else {
                            this.log(`⏸ Crash backoff for ${key}: ${failures} fast-fail(s)${logSize === 0 ? ' (empty log)' : ''}, cooldown ${backoffMs / 60000}m`);
                        }
                    }
                    else {
                        this.crashBackoff.delete(key); // successful run (> 2 min) — clear backoff
                        this.saveCrashBackoff(this.crashBackoff);
                        // Capture token usage for completed runs
                        if (val.issue && val.station && val.logFile) {
                            this.writeTokenUsageAsync(val.issue, val.station, val.logFile).catch(() => { });
                        }
                        // Layer 1: Post-exit label reconciliation
                        if (val.issue && val.station && this.pipelinesConfig && this.repo) {
                            try {
                                reconcileAfterExit(val.issue, val.station, this.repo, this.pipelinesConfig, this.log);
                            }
                            catch (e) {
                                this.log(`  Reconciliation error for #${val.issue}: ${e.message?.slice(0, 100)}`);
                            }
                        }
                    }
                    if (val.pid) {
                        delete agentActivity[val.pid]; // prune stale PID from activity file
                    }
                    delete data[key];
                    cleaned++;
                }
            }
            if (cleaned > 0) {
                try {
                    writeFileSync(this.agentActivityFile, JSON.stringify(agentActivity));
                }
                catch { }
            }
            // Hung agent check: track last-seen-active per PID; only kill if silent for extended period
            for (const [key, val] of Object.entries(data)) {
                if (!val.pid || !isProcessAlive(val.pid) || !val.logFile || !val.ts)
                    continue;
                const ageMin = (Date.now() - val.ts) / 60000;
                if (ageMin < 3)
                    continue;
                try {
                    const logSize = statSync(val.logFile).size;
                    if (logSize > 0)
                        continue;
                    // Check current activity (connections OR child processes)
                    let isActive = false;
                    try {
                        const ssOut = execSync(`ss -tp 2>/dev/null | grep ",pid=${val.pid},"`, {
                            encoding: 'utf8',
                            timeout: 2000,
                        });
                        if (ssOut.trim().length > 0)
                            isActive = true;
                    }
                    catch { }
                    if (!isActive) {
                        try {
                            const pstreeOut = execSync(`pstree -p ${val.pid} 2>/dev/null`, {
                                encoding: 'utf8',
                                timeout: 2000,
                            });
                            if (pstreeOut.match(/─[a-z]+\(\d+\)/g)?.length ?? 0 > 0)
                                isActive = true;
                        }
                        catch { }
                    }
                    if (isActive) {
                        agentActivity[val.pid] = Date.now();
                        try {
                            writeFileSync(this.agentActivityFile, JSON.stringify(agentActivity));
                        }
                        catch { }
                        continue;
                    }
                    // No current activity — check when last seen active
                    const lastSeen = agentActivity[val.pid] ?? val.ts;
                    const silentMin = (Date.now() - lastSeen) / 60000;
                    // Silent threshold by station
                    const silentThreshold = {
                        spec: 3,
                        qa: 5,
                        design: 15,
                        build: 15,
                        bugfix: 15,
                    };
                    const threshold = silentThreshold[val.station] ?? 5;
                    if (silentMin < threshold) {
                        this.log(`[${key}] quiet for ${Math.round(silentMin)}m (threshold ${threshold}m) — not yet hung`);
                        continue;
                    }
                    // Silent beyond threshold → truly hung
                    this.log(`⚠️ Hung agent: ${key} pid=${val.pid} alive=${Math.round(ageMin)}m silent=${Math.round(silentMin)}m — killing`);
                    try {
                        process.kill(val.pid, 'SIGKILL');
                    }
                    catch { }
                    // Register crash backoff
                    const prev = this.crashBackoff.get(key) ?? { failures: 0, until: 0 };
                    const failures = prev.failures + 1;
                    const backoffMs = Math.min(failures * 5 * 60000, 30 * 60000);
                    this.crashBackoff.set(key, { failures, until: Date.now() + backoffMs });
                    this.saveCrashBackoff(this.crashBackoff);
                    this.log(`⏸ Crash backoff for ${key}: ${failures} hung-kill(s), cooldown ${backoffMs / 60000}m`);
                    delete data[key];
                    cleaned++;
                    delete agentActivity[val.pid];
                    try {
                        writeFileSync(this.agentActivityFile, JSON.stringify(agentActivity));
                    }
                    catch { }
                    this.notifyDiscord(`🔴 Hung agent killed: \`${key}\` (alive ${Math.round(ageMin)}m, silent ${Math.round(silentMin)}m) — cooldown ${backoffMs / 60000}m before retry.`).catch(() => { });
                }
                catch { }
            }
            if (cleaned > 0)
                writeFileSync(this.lockFile, JSON.stringify(data, null, 2));
        }
        catch (e) {
            this.log(`cleanDeadLocks error: ${e.message}`);
        }
    }
}
//# sourceMappingURL=locks.js.map