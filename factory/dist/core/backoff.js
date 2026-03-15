import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
/** Default retry caps per station. Override via config.json stations[x].maxRetries */
export const DEFAULT_MAX_RETRIES = {
    spec: 5,
    design: 5,
    build: 5,
    qa: 3,
    bugfix: 3,
    uat: 3,
};
/** Max retries for 0-byte log (env/setup) failures — much lower */
export const MAX_EMPTY_RETRIES = 2;
export class BackoffManagerImpl {
    backoffFile;
    log;
    map;
    constructor(backoffFile, log) {
        this.backoffFile = backoffFile;
        this.log = log;
        this.map = this.load();
    }
    load() {
        try {
            const raw = JSON.parse(readFileSync(this.backoffFile, 'utf8'));
            const m = new Map();
            const now = Date.now();
            for (const [k, v] of Object.entries(raw)) {
                // Keep entries that are either still backed off OR have high failure counts
                // (maxed-out entries need to persist even after backoff expires)
                if (v.until > now || v.failures >= 2)
                    m.set(k, v);
            }
            return m;
        }
        catch {
            return new Map();
        }
    }
    save(map) {
        try {
            const obj = {};
            for (const [k, v] of map.entries())
                obj[k] = v;
            writeFileSync(this.backoffFile, JSON.stringify(obj, null, 2));
        }
        catch (e) {
            this.log(`saveCrashBackoff error: ${e.message}`);
        }
    }
    isInCrashBackoff(key) {
        const b = this.map.get(key);
        if (!b)
            return false;
        if (Date.now() < b.until) {
            const remaining = ((b.until - Date.now()) / 60000).toFixed(1);
            this.log(`⏸ ${key} in crash backoff (${b.failures} fails, ${remaining}m remaining) — skipping spawn`);
            return true;
        }
        return false; // backoff expired
    }
    /**
     * Check if a key has exceeded the retry cap for its station.
     * Also checks the separate empty-run cap (0-byte logs = env/setup failures).
     */
    isMaxedOut(key, maxRetries) {
        const b = this.map.get(key);
        if (!b)
            return false;
        // Check empty-run cap first (stricter)
        if ((b.emptyRuns ?? 0) >= MAX_EMPTY_RETRIES) {
            this.log(`🚫 ${key} maxed out on empty runs (${b.emptyRuns}/${MAX_EMPTY_RETRIES}) — shelving`);
            return true;
        }
        // Check total failure cap
        if (b.failures >= maxRetries) {
            this.log(`🚫 ${key} maxed out (${b.failures}/${maxRetries} failures) — shelving`);
            return true;
        }
        return false;
    }
    recordCrash(key, fast, logFile) {
        const prev = this.map.get(key) ?? { failures: 0, until: 0 };
        const failures = prev.failures + 1;
        const backoffMs = Math.min(failures * 5 * 60000, 30 * 60000);
        // Track empty (0-byte) log runs separately
        let emptyRuns = prev.emptyRuns ?? 0;
        if (logFile) {
            try {
                const logSize = existsSync(logFile) ? statSync(logFile).size : 0;
                if (logSize === 0) {
                    emptyRuns++;
                }
            }
            catch {
                // Can't stat — treat as empty
                emptyRuns++;
            }
        }
        this.map.set(key, { failures, until: Date.now() + backoffMs, emptyRuns });
        this.save(this.map);
    }
    clearBackoff(key) {
        this.map.delete(key);
        this.save(this.map);
    }
    getBackoff(key) {
        return this.map.get(key);
    }
    /** Direct access to the internal map — used by LockManager */
    getMap() {
        return this.map;
    }
}
//# sourceMappingURL=backoff.js.map