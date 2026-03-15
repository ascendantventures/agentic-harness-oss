import type { BackoffEntry, BackoffManager } from '../types/index.js';
/** Default retry caps per station. Override via config.json stations[x].maxRetries */
export declare const DEFAULT_MAX_RETRIES: Record<string, number>;
/** Max retries for 0-byte log (env/setup) failures — much lower */
export declare const MAX_EMPTY_RETRIES = 2;
export declare class BackoffManagerImpl implements BackoffManager {
    private readonly backoffFile;
    private readonly log;
    private map;
    constructor(backoffFile: string, log: (msg: string) => void);
    load(): Map<string, BackoffEntry>;
    save(map: Map<string, BackoffEntry>): void;
    isInCrashBackoff(key: string): boolean;
    /**
     * Check if a key has exceeded the retry cap for its station.
     * Also checks the separate empty-run cap (0-byte logs = env/setup failures).
     */
    isMaxedOut(key: string, maxRetries: number): boolean;
    recordCrash(key: string, fast: boolean, logFile?: string): void;
    clearBackoff(key: string): void;
    getBackoff(key: string): BackoffEntry | undefined;
    /** Direct access to the internal map — used by LockManager */
    getMap(): Map<string, BackoffEntry>;
}
//# sourceMappingURL=backoff.d.ts.map