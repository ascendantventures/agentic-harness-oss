/**
 * Main tick() orchestrator — registry-driven pipeline (Phase 2).
 *
 * Each station is a self-contained module registered in StationRegistry.
 * The runner:
 *   1. Fetches issues by station.label
 *   2. Calls station.shouldProcess(enrichedIssue, ctx)
 *   3. Checks locks and crash backoff
 *   4. Calls station.buildTask() and spawns the agent
 *
 * Behaviour is identical to factory-loop.js — only the dispatch mechanism changed.
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { spawnAgent } from '../agents/spawn.js';
import { getIssuesByLabel, enrichIssue } from '../github/issues.js';
import { notifyStation } from '../notify/discord.js';
import {
  getSubmissionForIssue,
  pushToThread,
  pushChangeRequestStatus,
} from '../notify/supabase.js';
import { lockKey } from '../core/locks.js';
import { StationRegistry } from '../stations/registry.js';
import { BuildStation } from '../stations/build/index.js';
import { QAStation } from '../stations/qa/index.js';
import type { FactoryContext } from '../stations/base.js';
import type { GitHubIssue, Issue, LockFile, LockEntry } from '../types/index.js';

const PENDING_FILE = '/tmp/factory-pending.json';
const PHASE2_CHECKED_FILE = '/tmp/factory-phase2-checked.json';

export interface RunnerDeps {
  config?: import('../types/index.js').Config;
  REPO: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  FACTORY_SECRET: string;
  FACTORY_APP_URL: string;
  DISCORD_WEBHOOK_URL: string;
  MAX_TASKS_PER_RUN: number;
  USE_CLAUDE_CLI: boolean;
  LOCK_FILE: string;
  CRASH_BACKOFF_FILE: string;
  LOG_FILE: string;

  log: (msg: string) => void;
  getLocks: () => LockFile;
  setLock: (key: string, meta: Omit<LockEntry, 'ts'>) => void;
  isLocked: (key: string) => boolean;
  countActiveLocks: (station: string) => number;
  isInCrashBackoff: (key: string) => boolean;
  getCurrentKey: () => string;
  buildAgentEnv: (apiKey: string) => NodeJS.ProcessEnv;
  rotateApiKey: (reason: string) => void;
  checkLogForKeyError: (logPath: string) => boolean;
}

/** Build a FactoryContext from RunnerDeps (bridges old deps shape to new context shape). */
function makeCtx(deps: RunnerDeps): FactoryContext {
  return {
    config: deps.config ?? {
      stations: {},
      github: { repo: deps.REPO },
      concurrency: { maxTasksPerRun: deps.MAX_TASKS_PER_RUN },
    },
    env: {
      repo: deps.REPO,
      supabaseUrl: deps.SUPABASE_URL,
      supabaseKey: deps.SUPABASE_KEY,
      factorySecret: deps.FACTORY_SECRET,
      factoryAppUrl: deps.FACTORY_APP_URL,
      discordWebhookUrl: deps.DISCORD_WEBHOOK_URL,
      useClaudeCli: deps.USE_CLAUDE_CLI,
      logFile: deps.LOG_FILE,
    },
    log: deps.log,
  };
}

// Tracks consecutive stuck-skip counts per issue (#191)
const stuckSkipCounts = new Map<number, number>();

// ─── Phase 2 auto-pickup ──────────────────────────────────────────────────────

function getPhase2Checked(): number[] {
  try {
    return JSON.parse(readFileSync(PHASE2_CHECKED_FILE, 'utf8')) as number[];
  } catch {
    return [];
  }
}

function markPhase2Checked(issueNumber: number): void {
  const checked = getPhase2Checked();
  if (!checked.includes(issueNumber)) {
    checked.push(issueNumber);
    try {
      writeFileSync(PHASE2_CHECKED_FILE, JSON.stringify(checked));
    } catch {}
  }
}

async function autoQueuePhase2(issueNumber: number, deps: RunnerDeps): Promise<void> {
  try {
    const checked = getPhase2Checked();
    if (checked.includes(issueNumber)) return;

    const allOpen = JSON.parse(
      execSync(
        `gh issue list --state open --limit 100 --repo ${deps.REPO} --json number,title,labels 2>/dev/null`,
        { encoding: 'utf8', timeout: 30000 },
      ),
    ) as GitHubIssue[];

    const phase2 = allOpen.filter(
      (i) =>
        i.title.includes(`[Phase 2] #${issueNumber}`) &&
        (i.labels ?? []).some((l) => l.name === 'type:phase2'),
    );

    markPhase2Checked(issueNumber);
    if (!phase2.length) return;

    for (const p2 of phase2) {
      deps.log(`🔁 Phase 1 #${issueNumber} done → auto-queuing Phase 2 #${p2.number}: ${p2.title.slice(0, 60)}`);
      execSync(`gh issue edit ${p2.number} --repo ${deps.REPO} --remove-label "type:phase2" --add-label "station:intake"`, { encoding: 'utf8', timeout: 30000 });
      execSync(`gh issue comment ${p2.number} --repo ${deps.REPO} --body "## Phase 2 Auto-Queued\n\nPhase 1 (#${issueNumber}) has passed QA and is ready for client testing.\n\nThis Phase 2 issue has been automatically queued to \`station:intake\`. The factory will pick it up on the next tick.\n\n**Client:** Phase 1 is live — start testing while Phase 2 is being built."`, { encoding: 'utf8', timeout: 30000 });
      execSync(`gh issue comment ${issueNumber} --repo ${deps.REPO} --body "## Phase 2 Started\n\nPhase 2 has been automatically queued: #${p2.number}\n\nYour Phase 1 delivery is live and Phase 2 begins now."`, { encoding: 'utf8', timeout: 30000 });
      deps.log(`✅ Phase 2 #${p2.number} queued → station:intake`);
    }
  } catch (e: any) {
    deps.log(`autoQueuePhase2 error for #${issueNumber}: ${e.message}`);
  }
}

async function syncDoneStations(deps: RunnerDeps): Promise<void> {
  if (!deps.SUPABASE_URL) return; // standalone mode

  try {
    const doneIssues = JSON.parse(
      execSync(`gh issue list --label "station:done" --state open --limit 20 --repo ${deps.REPO} --json number,title,body,labels,url 2>/dev/null`, { encoding: 'utf8', timeout: 30000 }),
    ) as GitHubIssue[];

    for (const issue of doneIssues) {
      const enriched = enrichIssue(issue);

      if (enriched.isChangeRequest) {
        const crs = await fetch(
          `${deps.SUPABASE_URL}/rest/v1/change_requests?github_issue_number=eq.${issue.number}&select=id,status`,
          { headers: { apikey: deps.SUPABASE_KEY, Authorization: `Bearer ${deps.SUPABASE_KEY}` } },
        ).then((r) => r.json()).catch(() => []) as Array<{ id: string; status: string }>;

        const cr = Array.isArray(crs) ? crs[0] : null;
        if (cr && cr.status !== 'complete') {
          deps.log(`Syncing CR #${issue.number} → complete (was: ${cr.status})`);
          await pushChangeRequestStatus(issue.number, 'complete', deps.SUPABASE_URL, deps.SUPABASE_KEY, deps.log).catch(() => null);
        }
        continue;
      }

      const subs = await fetch(
        `${deps.SUPABASE_URL}/rest/v1/submissions?github_issue_number=eq.${issue.number}&select=id,station`,
        { headers: { apikey: deps.SUPABASE_KEY, Authorization: `Bearer ${deps.SUPABASE_KEY}` } },
      ).then((r) => r.json()).catch(() => []) as Array<{ id: string; station: string }>;

      const sub = Array.isArray(subs) ? subs[0] : null;
      if (sub && sub.station !== 'done') {
        await fetch(`${deps.SUPABASE_URL}/rest/v1/submissions?id=eq.${sub.id}`, {
          method: 'PATCH',
          headers: { apikey: deps.SUPABASE_KEY, Authorization: `Bearer ${deps.SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ station: 'done' }),
        });
        deps.log(`Auto-synced #${issue.number} Supabase station → done`);
      }

      await autoQueuePhase2(issue.number, deps);
    }
  } catch (e: any) {
    deps.log(`syncDoneStations error: ${e.message}`);
  }
}

// ─── Registry-driven spawn helper ─────────────────────────────────────────────

/** Notify Discord + Supabase thread for a station transition, then spawn the agent. */
async function spawnForStation(
  issue: Issue,
  stationId: string,
  deps: RunnerDeps,
  ctx: FactoryContext,
  taskFn: () => Promise<import('../types/index.js').AgentTask>,
): Promise<{ pid?: number; logFile: string } | null> {
  const rawIssue = issue.raw;
  const isSimple = issue.complexity === 'simple';

  await notifyStation(rawIssue.number, rawIssue.title, stationId, deps.DISCORD_WEBHOOK_URL, deps.log);

  // Supabase thread push — fire-and-forget
  const statusMessages: Record<string, string> = {
    spec: 'Writing your project specification...',
    design: 'Spec approved — designing your visual system...',
    build: 'Design complete — building your app right now...',
    qa: 'Build complete — testing before delivery...',
    bugfix: 'Fixing issues reported by QA...',
  };
  getSubmissionForIssue(rawIssue.number, deps.SUPABASE_URL, deps.SUPABASE_KEY)
    .then((sub) => {
      if ((sub as any)?.id) {
        pushToThread(
          (sub as any).id as string,
          'status_update',
          { type: 'status_update', station: stationId },
          statusMessages[stationId] ?? `Processing at ${stationId}...`,
          deps.FACTORY_APP_URL,
          deps.FACTORY_SECRET,
          deps.log,
        );
      }
    })
    .catch(() => null);

  // For [Change] issues at build/bugfix: push in_progress to change_requests
  if ((stationId === 'build' || stationId === 'bugfix') && issue.isChangeRequest) {
    pushChangeRequestStatus(rawIssue.number, 'in_progress', deps.SUPABASE_URL, deps.SUPABASE_KEY, deps.log).catch(() => null);
  }

  const task = await taskFn();
  const handle = spawnAgent(task, deps.USE_CLAUDE_CLI, deps.buildAgentEnv, deps.getCurrentKey, deps.log);

  deps.setLock(lockKey(rawIssue.number, stationId), {
    issue: rawIssue.number,
    station: stationId,
    pid: handle.pid,
    logFile: handle.logFile,
    simple: isSimple,
  });

  deps.log(`🚀 Spawned ${stationId.toUpperCase()} for #${rawIssue.number}: ${rawIssue.title}`);
  return handle;
}

// ─── Main tick ────────────────────────────────────────────────────────────────

export async function tick(deps: RunnerDeps): Promise<void> {
  deps.log('═══ Factory loop starting ═══');

  await syncDoneStations(deps);

  const ctx = makeCtx(deps);

  // Build the registry (uses default stations)
  const registry = await StationRegistry.createDefault(ctx.config);

  let added = 0;

  // ─── Registry-driven station loop ─────────────────────────────────────────
  for (const station of registry.getAll()) {
    if (added >= deps.MAX_TASKS_PER_RUN) break;

    // Fetch issues for this station's trigger label
    let rawIssues: GitHubIssue[] = [];
    try {
      rawIssues = getIssuesByLabel(station.label, deps.REPO);
      deps.log(`${station.label}  → ${rawIssues.length} issues`);
    } catch (e: any) {
      deps.log(`Error fetching ${station.label} issues: ${e.message}`);
      continue;
    }

    if (rawIssues.length === 0) continue;

    // Concurrency cap
    const activeLocks = deps.countActiveLocks(station.id);
    if (activeLocks >= station.concurrency) {
      deps.log(`${station.id.toUpperCase()} at capacity (${station.concurrency} max, ${activeLocks} active) — skipping`);
      continue;
    }

    for (const raw of rawIssues) {
      if (added >= deps.MAX_TASKS_PER_RUN) break;
      if (activeLocks >= station.concurrency) break;

      const issue = enrichIssue(raw);

      // shouldProcess check
      const { process, reason } = await station.shouldProcess(issue, ctx);
      if (!process) {
        deps.log(`Skip #${raw.number} [${station.id}]: ${reason ?? 'shouldProcess=false'}`);

        // ── BuildStation special actions ──────────────────────────────────────
        if (station instanceof BuildStation && station.designAction) {
          const { action, issueNumber, reason: rejReason } = station.designAction;

          if (action === 'respawn-design') {
            // Re-spawn DESIGN agent if no lock and capacity allows
            const designStation = registry.get('design');
            const designKey = lockKey(issueNumber, 'design');
            const designCap = designStation?.concurrency ?? 2;
            if (
              designStation &&
              !deps.isLocked(designKey) &&
              deps.countActiveLocks('design') < designCap
            ) {
              deps.log(`DESIGN.md missing for #${issueNumber} with no lock — re-spawning DESIGN agent`);
              const designTask = await designStation.buildTask(issue, ctx);
              const h = spawnAgent(designTask, deps.USE_CLAUDE_CLI, deps.buildAgentEnv, deps.getCurrentKey, deps.log);
              deps.setLock(designKey, { issue: issueNumber, station: 'design', pid: h.pid, simple: issue.complexity === 'simple' });
            } else {
              deps.log(`DESIGN.md not posted yet for #${issueNumber} — waiting`);
            }
          }

          if (action === 'reject-design') {
            // Check if already rejected once — if so, pause instead
            try {
              const result = JSON.parse(
                execSync(`gh issue view ${issueNumber} --repo ${deps.REPO} --json comments`, { encoding: 'utf8', timeout: 15000 }),
              ) as { comments: Array<{ body?: string }> };
              const alreadyRejected = result.comments.some((c) => c.body?.includes('DESIGN.md REJECTED'));

              if (alreadyRejected) {
                // AC-002.3: Second failure — pause
                execSync(`gh issue comment ${issueNumber} --repo ${deps.REPO} --body "⚠️ DESIGN quality gate failed twice. Pausing for manual review.\n\nReason: ${rejReason}"`, { encoding: 'utf8', timeout: 30000 });
                execSync(`gh issue edit ${issueNumber} --repo ${deps.REPO} --remove-label "station:design" --add-label "status:paused"`, { encoding: 'utf8', timeout: 30000 });
                deps.log(`[#${issueNumber}] DESIGN quality gate failed twice — paused`);
              } else {
                // First rejection — re-queue to spec
                const rejBody = `## DESIGN.md REJECTED — Quality Gate Failure\n\n**Reason:** ${rejReason}\n\n**Required:** All 12+ sections present (including Tailwind Config, Motion Spec, Hero Visual), minimum 1500 words total, ALL hex values filled in (no #XXXXXX placeholders), ALL routes from spec covered.\n\nPlease re-read the SPEC and produce a complete DESIGN.md. BUILD cannot start until this passes.`;
                execSync(`gh issue comment ${issueNumber} --repo ${deps.REPO} --body "${rejBody.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, { encoding: 'utf8', timeout: 30000 });
                execSync(`gh issue edit ${issueNumber} --repo ${deps.REPO} --remove-label "station:design" --add-label "station:spec"`, { encoding: 'utf8', timeout: 30000 });
                deps.log(`[#${issueNumber}] DESIGN rejected (${rejReason}) — re-queued for DESIGN`);
              }
            } catch (e: any) {
              deps.log(`Design rejection action failed for #${issueNumber}: ${e.message}`);
            }
          }
          continue;
        }

        // ── QAStation: stall guard + internal auto-pass ───────────────────────
        if (station instanceof QAStation) {
          // Auto-pass internal issues
          if (reason?.includes('type:internal')) {
            deps.log(`#${raw.number} is type:internal — auto-passing QA → station:done`);
            try {
              execSync(`gh issue edit ${raw.number} --repo ${deps.REPO} --remove-label "station:build" --add-label "station:done"`, { encoding: 'utf8', timeout: 30000 });
              execSync(`gh issue comment ${raw.number} --repo ${deps.REPO} --body "## QA Auto-Pass ✅\n\nInternal issue — QA skipped per factory policy. Review on demand.\n\nStation: \`station:done\`"`, { encoding: 'utf8', timeout: 30000 });
            } catch (e: any) {
              deps.log(`Failed to auto-pass #${raw.number}: ${e.message}`);
            }
            continue;
          }

          // QA stall guard — track stuck skip counts (#191)
          if (reason?.includes('QA already failed') || reason?.includes('QA stalled')) {
            const stuckCount = (stuckSkipCounts.get(raw.number) ?? 0) + 1;
            stuckSkipCounts.set(raw.number, stuckCount);
            deps.log(`Skipping QA for #${raw.number} — stuck skip count: ${stuckCount}/3`);

            if (stuckCount >= 3) {
              deps.log(`#${raw.number} stuck for ${stuckCount} cycles — escalating to station:blocked`);
              try {
                execSync(`gh issue edit ${raw.number} --repo ${deps.REPO} --remove-label "station:build" --add-label "station:blocked"`, { encoding: 'utf8', timeout: 30000 });
                execSync(`gh issue comment ${raw.number} --repo ${deps.REPO} --body "## 🚫 Escalated to Blocked\n\nThis issue has failed QA ${stuckCount}+ times with no new commits in the build repo. Manual intervention required.\n\nTag Pedro for review."`, { encoding: 'utf8', timeout: 30000 });
              } catch (e: any) {
                deps.log(`Escalation error for #${raw.number}: ${e.message}`);
              }
              stuckSkipCounts.delete(raw.number);
            }
          }
        }

        continue;
      }

      // ── QAStation: clear stuckSkipCount on progress ───────────────────────
      if (station instanceof QAStation) {
        stuckSkipCounts.delete(raw.number);
      }

      // Lock + backoff checks
      const key = lockKey(raw.number, station.id);
      if (deps.isLocked(key)) {
        deps.log(`${station.id.toUpperCase()} already locked for #${raw.number}, skipping`);
        continue;
      }
      if (deps.isInCrashBackoff(key)) continue;

      // Spawn!
      await spawnForStation(issue, station.id, deps, ctx, () => station.buildTask(issue, ctx));
      added++;
    }
  }

  // ── station:qa → QA agent (direct QA label, same as station:build path) ────
  // This handles issues where station:qa was set directly (e.g., manual queue or legacy)
  // Mirrors the 'qaIssues' loop in the monolith exactly.
  if (added < deps.MAX_TASKS_PER_RUN) {
    const qaStation = registry.get('qa');
    if (qaStation) {
      let qaDirectIssues: GitHubIssue[] = [];
      try {
        qaDirectIssues = getIssuesByLabel('station:qa', deps.REPO);
        if (qaDirectIssues.length > 0) {
          deps.log(`station:qa (direct) → ${qaDirectIssues.length} issues`);
        }
      } catch (e: any) {
        deps.log(`Error fetching station:qa issues: ${e.message}`);
      }

      for (const raw of qaDirectIssues) {
        if (added >= deps.MAX_TASKS_PER_RUN) break;
        if (deps.countActiveLocks('qa') >= qaStation.concurrency) break;

        const issue = enrichIssue(raw);

        // Auto-pass type:internal
        if (issue.isInternal) {
          deps.log(`#${raw.number} is type:internal — auto-passing QA → station:done`);
          try {
            execSync(`gh issue edit ${raw.number} --repo ${deps.REPO} --remove-label "station:qa" --add-label "station:done"`, { encoding: 'utf8', timeout: 30000 });
            execSync(`gh issue comment ${raw.number} --repo ${deps.REPO} --body "## QA Auto-Pass ✅\n\nInternal issue — QA skipped per factory policy. Review on demand.\n\nStation: \`station:done\`"`, { encoding: 'utf8', timeout: 30000 });
          } catch (e: any) {
            deps.log(`Failed to auto-pass #${raw.number}: ${e.message}`);
          }
          continue;
        }

        // Use a temporary ctx for QAStation where we target station:qa label issues
        const { process, reason } = await qaStation.shouldProcess(issue, ctx);
        if (!process) {
          deps.log(`Skip #${raw.number} [qa-direct]: ${reason ?? 'shouldProcess=false'}`);

          // stall guard
          if (reason?.includes('QA already failed') || reason?.includes('QA stalled')) {
            const stuckCount = (stuckSkipCounts.get(raw.number) ?? 0) + 1;
            stuckSkipCounts.set(raw.number, stuckCount);
            deps.log(`Skipping QA for #${raw.number} (direct) — stuck skip count: ${stuckCount}/3`);
            if (stuckCount >= 3) {
              deps.log(`#${raw.number} stuck ${stuckCount} cycles — escalating to station:blocked`);
              try {
                execSync(`gh issue edit ${raw.number} --repo ${deps.REPO} --remove-label "station:qa" --add-label "station:blocked"`, { encoding: 'utf8', timeout: 30000 });
                execSync(`gh issue comment ${raw.number} --repo ${deps.REPO} --body "## 🚫 Escalated to Blocked\n\nFailed QA ${stuckCount}+ times with no new build repo commits. Manual intervention required."`, { encoding: 'utf8', timeout: 30000 });
              } catch {}
              stuckSkipCounts.delete(raw.number);
            }
          }
          continue;
        }

        stuckSkipCounts.delete(raw.number);

        const key = lockKey(raw.number, 'qa');
        if (deps.isLocked(key)) { deps.log(`QA already locked for #${raw.number}, skipping`); continue; }
        if (deps.isInCrashBackoff(key)) continue;

        await spawnForStation(issue, 'qa', deps, ctx, () => qaStation.buildTask(issue, ctx));
        added++;
      }
    }
  }

  clearPending();
  deps.log(`═══ Factory loop complete: ${added} agents spawned ═══`);
}

function clearPending(): void {
  try {
    writeFileSync(PENDING_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), tasks: [] }, null, 2));
  } catch {}
}

// ─── Phase 3: PipelineRouter-based tick ──────────────────────────────────────
// Import NOTE: Dynamic require is intentional here to match the existing pattern
// in StationRegistry.createDefault() and avoid circular module issues at load time.

import type { PipelinesConfig } from '../types/pipeline.js';
import { PipelineRouter, type PipelineRouterContext } from './router.js';

/**
 * RunnerDepsV2 — extends RunnerDeps with the Phase 3 pipeline additions.
 * Build this in loop.ts after loading pipelines.json and creating the registry.
 */
export interface RunnerDepsV2 extends RunnerDeps {
  /** Loaded pipelines.json — passed from loop.ts */
  pipelinesConfig: PipelinesConfig;
  /** Fully populated station registry — from StationRegistry.createDefault() */
  registry: import('../stations/registry.js').StationRegistry;
}

/**
 * tickV2() — Phase 3 factory loop tick (multi-pipeline).
 *
 * Replaces direct station iteration with PipelineRouter.
 * Adding a new pipeline = edit pipelines.json + register stations.
 * No changes needed here.
 *
 * Preserves syncDoneStations() from tick() for production parity.
 */
export async function tickV2(deps: RunnerDepsV2): Promise<void> {
  deps.log('═══ Factory loop starting (v2 — multi-pipeline) ═══');

  // 1. Sync done stations (Supabase + Phase 2 auto-queue) — same as tick()
  await syncDoneStations(deps);

  // 2. Build PipelineRouterContext from the flat RunnerDepsV2 shape
  const ctx = makeCtx(deps);
  const routerCtx: PipelineRouterContext = {
    ...ctx,
    pipelinesConfig: deps.pipelinesConfig,
    locks: {
      getLocks: deps.getLocks,
      setLock: deps.setLock,
      removeLock: (_key: string) => { /* TTL-based expiry — no manual remove needed */ },
      isLocked: deps.isLocked,
      countActiveLocks: deps.countActiveLocks,
      cleanDeadLocks: () => { /* handled by LockManagerImpl before tickV2 is called */ },
    },
    maxTasksPerRun: deps.MAX_TASKS_PER_RUN,
    useClaudeCli: deps.USE_CLAUDE_CLI,
    isInCrashBackoff: deps.isInCrashBackoff,
    getCurrentKey: deps.getCurrentKey,
    buildAgentEnv: deps.buildAgentEnv,
  };

  // 3. Route all pipelines via PipelineRouter
  const router = new PipelineRouter(deps.registry, routerCtx);
  const spawned = await router.route();

  clearPending();
  deps.log(`═══ Factory loop complete (v2): ${spawned} agents spawned ═══`);
}
