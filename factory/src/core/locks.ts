import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import type { LockEntry, LockFile, LockManager } from '../types/index.js';

/** Per-station lock TTL — complexity:simple gets shorter TTLs */
export const LOCK_TTL: Record<string, number> = {
  spec: 1800000,
  qa: 1800000,
  design: 7200000,
  build: 7200000,
  bugfix: 7200000,
};

export const LOCK_TTL_SIMPLE: Record<string, number> = {
  spec: 900000,
  qa: 900000,
  design: 1800000,
  build: 1800000,
  bugfix: 1800000,
};

export function getLockTTL(station: string, isSimple?: boolean): number {
  const ttls = isSimple ? LOCK_TTL_SIMPLE : LOCK_TTL;
  return ttls[station] ?? 7200000;
}

/** PID liveness check */
export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return true; // no PID stored = legacy lock, don't clean
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function lockKey(issueNumber: number, station: string): string {
  return `${issueNumber}-${station}`;
}

export class LockManagerImpl implements LockManager {
  constructor(
    private readonly lockFile: string,
    private readonly agentActivityFile: string,
    private readonly log: (msg: string) => void,
    private readonly crashBackoff: Map<string, { failures: number; until: number }>,
    private readonly saveCrashBackoff: (map: Map<string, { failures: number; until: number }>) => void,
    private readonly rotateApiKey: (reason: string) => void,
    private readonly checkLogForKeyError: (logPath: string) => boolean,
    private readonly writeTokenUsageAsync: (
      issueNumber: number,
      station: string,
      logFile: string,
    ) => Promise<void>,
    private readonly notifyDiscord: (msg: string) => Promise<void>,
  ) {}

  getLocks(): LockFile {
    try {
      if (existsSync(this.lockFile)) {
        const data = JSON.parse(readFileSync(this.lockFile, 'utf8')) as LockFile;
        const now = Date.now();
        return Object.fromEntries(
          Object.entries(data).filter(([k, v]) => {
            const station = k.split('-').slice(1).join('-');
            const ttl = getLockTTL(station, v.simple);
            return now - v.ts < ttl;
          }),
        );
      }
    } catch {}
    return {};
  }

  setLock(key: string, meta: Omit<LockEntry, 'ts'>): void {
    const locks = this.getLocks();
    locks[key] = { ts: Date.now(), ...meta };
    writeFileSync(this.lockFile, JSON.stringify(locks, null, 2));
  }

  removeLock(key: string): void {
    const locks = this.getLocks();
    delete locks[key];
    writeFileSync(this.lockFile, JSON.stringify(locks, null, 2));
  }

  isLocked(key: string): boolean {
    return !!this.getLocks()[key];
  }

  countActiveLocks(station: string): number {
    const locks = this.getLocks();
    return Object.entries(locks).filter(
      ([k, v]) => v.station === station && this.isLocked(k),
    ).length;
  }

  cleanDeadLocks(): void {
    try {
      if (!existsSync(this.lockFile)) return;
      const data = JSON.parse(readFileSync(this.lockFile, 'utf8')) as LockFile;

      // Load activity file up-front so dead-lock cleanup can prune stale PID entries
      let agentActivity: Record<string, number> = {};
      try {
        agentActivity = JSON.parse(readFileSync(this.agentActivityFile, 'utf8'));
      } catch {}

      let cleaned = 0;
      for (const [key, val] of Object.entries(data)) {
        if (val.pid && !isProcessAlive(val.pid)) {
          this.log(
            `🧹 Cleaning dead lock: ${key} (pid ${val.pid} no longer alive)`,
          );
          // Crash backoff: if agent died in < 2 min, track it to prevent notification spam
          const ageLs = Date.now() - (val.ts ?? 0);
          if (ageLs < 120000) {
            // Check if failure was due to invalid API key — rotate immediately
            const agentLogPath = val.logFile;
            if (agentLogPath && this.checkLogForKeyError(agentLogPath)) {
              this.rotateApiKey(`fast-fail on ${key}`);
            }
            const prev = this.crashBackoff.get(key) ?? { failures: 0, until: 0 };
            const failures = prev.failures + 1;
            const backoffMs = Math.min(failures * 5 * 60000, 30 * 60000); // 5m, 10m, 15m... max 30m
            this.crashBackoff.set(key, { failures, until: Date.now() + backoffMs });
            this.saveCrashBackoff(this.crashBackoff);
            this.log(
              `⏸ Crash backoff for ${key}: ${failures} fast-fail(s), cooldown ${backoffMs / 60000}m`,
            );
          } else {
            this.crashBackoff.delete(key); // successful run (> 2 min) — clear backoff
            this.saveCrashBackoff(this.crashBackoff);
            // Capture token usage for completed runs
            if (val.issue && val.station && val.logFile) {
              this.writeTokenUsageAsync(val.issue, val.station, val.logFile).catch(() => {});
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
        } catch {}
      }

      // Hung agent check: track last-seen-active per PID; only kill if silent for extended period
      for (const [key, val] of Object.entries(data)) {
        if (!val.pid || !isProcessAlive(val.pid) || !val.logFile || !val.ts) continue;
        const ageMin = (Date.now() - val.ts) / 60000;
        if (ageMin < 3) continue;
        try {
          const logSize = statSync(val.logFile).size;
          if (logSize > 0) continue;
          // Check current activity (connections OR child processes)
          let isActive = false;
          try {
            const ssOut = execSync(`ss -tp 2>/dev/null | grep ",pid=${val.pid},"`, {
              encoding: 'utf8',
              timeout: 2000,
            });
            if (ssOut.trim().length > 0) isActive = true;
          } catch {}
          if (!isActive) {
            try {
              const pstreeOut = execSync(`pstree -p ${val.pid} 2>/dev/null`, {
                encoding: 'utf8',
                timeout: 2000,
              });
              if (pstreeOut.match(/─[a-z]+\(\d+\)/g)?.length ?? 0 > 0) isActive = true;
            } catch {}
          }
          if (isActive) {
            agentActivity[val.pid] = Date.now();
            try {
              writeFileSync(this.agentActivityFile, JSON.stringify(agentActivity));
            } catch {}
            continue;
          }
          // No current activity — check when last seen active
          const lastSeen = agentActivity[val.pid] ?? val.ts;
          const silentMin = (Date.now() - lastSeen) / 60000;
          // Silent threshold by station
          const silentThreshold: Record<string, number> = {
            spec: 3,
            qa: 5,
            design: 15,
            build: 15,
            bugfix: 15,
          };
          const threshold = silentThreshold[val.station] ?? 5;
          if (silentMin < threshold) {
            this.log(
              `[${key}] quiet for ${Math.round(silentMin)}m (threshold ${threshold}m) — not yet hung`,
            );
            continue;
          }
          // Silent beyond threshold → truly hung
          this.log(
            `⚠️ Hung agent: ${key} pid=${val.pid} alive=${Math.round(ageMin)}m silent=${Math.round(silentMin)}m — killing`,
          );
          try {
            process.kill(val.pid, 'SIGKILL');
          } catch {}
          // Register crash backoff
          const prev = this.crashBackoff.get(key) ?? { failures: 0, until: 0 };
          const failures = prev.failures + 1;
          const backoffMs = Math.min(failures * 5 * 60000, 30 * 60000);
          this.crashBackoff.set(key, { failures, until: Date.now() + backoffMs });
          this.saveCrashBackoff(this.crashBackoff);
          this.log(
            `⏸ Crash backoff for ${key}: ${failures} hung-kill(s), cooldown ${backoffMs / 60000}m`,
          );
          delete data[key];
          cleaned++;
          delete agentActivity[val.pid];
          try {
            writeFileSync(this.agentActivityFile, JSON.stringify(agentActivity));
          } catch {}
          this.notifyDiscord(
            `🔴 Hung agent killed: \`${key}\` (alive ${Math.round(ageMin)}m, silent ${Math.round(silentMin)}m) — cooldown ${backoffMs / 60000}m before retry.`,
          ).catch(() => {});
        } catch {}
      }
      if (cleaned > 0) writeFileSync(this.lockFile, JSON.stringify(data, null, 2));
    } catch (e: any) {
      this.log(`cleanDeadLocks error: ${e.message}`);
    }
  }
}
