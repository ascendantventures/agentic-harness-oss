import type { LockEntry, LockFile, LockManager, BackoffEntry } from '../types/index.js';
import type { PipelinesConfig } from '../types/pipeline.js';
/** Per-station lock TTL — complexity:simple gets shorter TTLs */
export declare const LOCK_TTL: Record<string, number>;
export declare const LOCK_TTL_SIMPLE: Record<string, number>;
export declare function getLockTTL(station: string, isSimple?: boolean): number;
/** PID liveness check */
export declare function isProcessAlive(pid: number | undefined): boolean;
export declare function lockKey(issueNumber: number, station: string): string;
export declare class LockManagerImpl implements LockManager {
    private readonly lockFile;
    private readonly agentActivityFile;
    private readonly log;
    private readonly crashBackoff;
    private readonly saveCrashBackoff;
    private readonly rotateApiKey;
    private readonly checkLogForKeyError;
    private readonly writeTokenUsageAsync;
    private readonly notifyDiscord;
    private pipelinesConfig?;
    private repo?;
    constructor(lockFile: string, agentActivityFile: string, log: (msg: string) => void, crashBackoff: Map<string, BackoffEntry>, saveCrashBackoff: (map: Map<string, BackoffEntry>) => void, rotateApiKey: (reason: string) => void, checkLogForKeyError: (logPath: string) => boolean, writeTokenUsageAsync: (issueNumber: number, station: string, logFile: string) => Promise<void>, notifyDiscord: (msg: string) => Promise<void>, pipelinesConfig?: PipelinesConfig | undefined, repo?: string | undefined);
    /** Set pipelines config for post-exit label reconciliation */
    setPipelinesConfig(config: PipelinesConfig, repo: string): void;
    /**
     * Shelve a stuck issue: replace its station label with station:stuck,
     * post a comment explaining why, and notify Discord.
     */
    private shelveIssue;
    getLocks(): LockFile;
    setLock(key: string, meta: Omit<LockEntry, 'ts'>): void;
    removeLock(key: string): void;
    isLocked(key: string): boolean;
    countActiveLocks(station: string): number;
    cleanDeadLocks(): void;
}
//# sourceMappingURL=locks.d.ts.map