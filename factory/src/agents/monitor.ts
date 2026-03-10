import { readFileSync, writeFileSync } from 'fs';

const AGENT_ACTIVITY_FILE = '/tmp/factory-agent-activity.json';

/**
 * ActivityMonitor tracks per-PID last-seen timestamps.
 * Used by LockManager to detect truly hung agents (not just agents
 * between API calls with no open connections).
 */
export class ActivityMonitor {
  private activity: Record<string, number> = {};

  constructor(private readonly activityFile = AGENT_ACTIVITY_FILE) {
    this.load();
  }

  private load(): void {
    try {
      this.activity = JSON.parse(readFileSync(this.activityFile, 'utf8'));
    } catch {
      this.activity = {};
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.activityFile, JSON.stringify(this.activity));
    } catch {}
  }

  updateActivity(pid: number): void {
    this.activity[pid] = Date.now();
    this.persist();
  }

  getLastSeen(pid: number, fallback: number): number {
    return this.activity[pid] ?? fallback;
  }

  isHung(
    pid: number,
    startedAt: number,
    station: string,
    thresholds: Record<string, number> = {
      spec: 3,
      qa: 5,
      design: 15,
      build: 15,
      bugfix: 15,
    },
  ): boolean {
    const ageMin = (Date.now() - startedAt) / 60000;
    if (ageMin < 3) return false;
    const lastSeen = this.getLastSeen(pid, startedAt);
    const silentMin = (Date.now() - lastSeen) / 60000;
    const threshold = thresholds[station] ?? 5;
    return silentMin >= threshold;
  }

  pruneStale(pid: number): void {
    delete this.activity[pid];
    this.persist();
  }
}
