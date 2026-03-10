import { readFileSync, writeFileSync } from 'fs';
import type { BackoffEntry, BackoffManager } from '../types/index.js';

export class BackoffManagerImpl implements BackoffManager {
  private map: Map<string, BackoffEntry>;

  constructor(
    private readonly backoffFile: string,
    private readonly log: (msg: string) => void,
  ) {
    this.map = this.load();
  }

  load(): Map<string, BackoffEntry> {
    try {
      const raw = JSON.parse(readFileSync(this.backoffFile, 'utf8')) as Record<
        string,
        BackoffEntry
      >;
      const m = new Map<string, BackoffEntry>();
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) {
        if (v.until > now) m.set(k, v); // prune expired entries on load
      }
      return m;
    } catch {
      return new Map();
    }
  }

  save(map: Map<string, BackoffEntry>): void {
    try {
      const obj: Record<string, BackoffEntry> = {};
      for (const [k, v] of map.entries()) obj[k] = v;
      writeFileSync(this.backoffFile, JSON.stringify(obj, null, 2));
    } catch (e: any) {
      this.log(`saveCrashBackoff error: ${e.message}`);
    }
  }

  isInCrashBackoff(key: string): boolean {
    const b = this.map.get(key);
    if (!b) return false;
    if (Date.now() < b.until) {
      const remaining = ((b.until - Date.now()) / 60000).toFixed(1);
      this.log(
        `⏸ ${key} in crash backoff (${b.failures} fails, ${remaining}m remaining) — skipping spawn`,
      );
      return true;
    }
    return false; // backoff expired
  }

  recordCrash(key: string, _fast: boolean, _logFile?: string): void {
    const prev = this.map.get(key) ?? { failures: 0, until: 0 };
    const failures = prev.failures + 1;
    const backoffMs = Math.min(failures * 5 * 60000, 30 * 60000);
    this.map.set(key, { failures, until: Date.now() + backoffMs });
    this.save(this.map);
  }

  clearBackoff(key: string): void {
    this.map.delete(key);
    this.save(this.map);
  }

  getBackoff(key: string): BackoffEntry | undefined {
    return this.map.get(key);
  }

  /** Direct access to the internal map — used by LockManager */
  getMap(): Map<string, BackoffEntry> {
    return this.map;
  }
}
