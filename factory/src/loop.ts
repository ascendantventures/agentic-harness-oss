#!/usr/bin/env node
/**
 * agentic-harness — main entrypoint (TypeScript)
 *
 * Multi-pipeline orchestrator that turns GitHub issues into deployed software.
 * Spawns `claude -p` agents for each pipeline stage.
 *
 * To add a pipeline: edit factory/pipelines.json, register stations in
 * StationRegistry.createDefault(), no changes needed here.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname_loop = dirname(fileURLToPath(import.meta.url));

// ─── Load .env from repo root (if present) ────────────────────────────────────
const envPath = join(__dirname_loop, '../../.env');
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env optional */ }

// ─── Imports (after env is loaded) ────────────────────────────────────────────
import { loadConfig } from './core/config.js';
import { KeyManagerImpl } from './core/keys.js';
import { BackoffManagerImpl } from './core/backoff.js';
import { LockManagerImpl } from './core/locks.js';
import { tickV2, type RunnerDepsV2 } from './pipeline/runner.js';
import { maybeSweep } from './pipeline/reconciler.js';
import { StationRegistry } from './stations/registry.js';
import { notifyDiscord } from './notify/discord.js';
import { writeTokenUsageAsync, upsertHarnessHeartbeat } from './notify/supabase.js';
import type { PipelinesConfig } from './types/pipeline.js';
import type { LockEntry } from './types/index.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const USE_CLAUDE_CLI = process.env.FACTORY_USE_CLAUDE === '1';

const FACTORY_KEYS_FILE =
  process.env.FACTORY_KEYS_FILE ??
  join(__dirname_loop, '../../factory/factory-keys.json');

const LOG_FILE = process.env.FACTORY_LOG ?? '/tmp/factory-loop.log';
const LOCK_FILE = '/tmp/factory-loop.lock';
const CRASH_BACKOFF_FILE = '/tmp/factory-crash-backoff.json';
const AGENT_ACTIVITY_FILE = '/tmp/factory-agent-activity.json';

const REPO = process.env.GITHUB_REPO ?? 'owner/repo';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const FACTORY_SECRET = process.env.FACTORY_SECRET ?? '';
const FACTORY_APP_URL = process.env.FACTORY_APP_URL ?? '';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(line);
    writeFileSync(LOG_FILE, lines.slice(-500).join('\n') + '\n');
  } catch {}
}

// ─── Service instantiation ────────────────────────────────────────────────────

const keyManager = new KeyManagerImpl(FACTORY_KEYS_FILE, CLAUDE_BIN, log);
const backoffManager = new BackoffManagerImpl(CRASH_BACKOFF_FILE, log);

const lockManager = new LockManagerImpl(
  LOCK_FILE,
  AGENT_ACTIVITY_FILE,
  log,
  backoffManager.getMap(),
  (m) => backoffManager.save(m),
  (reason) => keyManager.rotateKey(reason),
  (logPath) => keyManager.checkLogForKeyError(logPath),
  (issueNum, station, logFile) =>
    writeTokenUsageAsync(issueNum, station, logFile, SUPABASE_URL, SUPABASE_KEY, log),
  (msg) => notifyDiscord(msg, DISCORD_WEBHOOK_URL, log),
);

// ─── Load config.json ─────────────────────────────────────────────────────────

let config: Awaited<ReturnType<typeof loadConfig>>;
try {
  config = loadConfig();
  if (process.env.GITHUB_REPO) config.github.repo = process.env.GITHUB_REPO;
} catch (e: any) {
  log(`Warning: Failed to load config.json: ${e.message} — using env/defaults`);
  config = {
    stations: {},
    github: { repo: REPO },
    concurrency: { maxTasksPerRun: 4 },
  };
}

const MAX_TASKS_PER_RUN = config.concurrency?.maxTasksPerRun ?? 2;

// ─── Load pipelines.json (Phase 3) ───────────────────────────────────────────

/**
 * Resolve the pipelines file path from config.pipelinesFile (relative to
 * the factory/ directory) or fall back to the default location.
 */
function loadPipelinesConfig(): PipelinesConfig {
  // config.pipelinesFile is relative to factory/ (where config.json lives)
  const configDir = join(__dirname_loop, '../../factory');
  const pipelinesFilePath = (config as any).pipelinesFile
    ? resolve(configDir, (config as any).pipelinesFile as string)
    : join(__dirname_loop, '../../factory/pipelines.json');

  try {
    const raw = readFileSync(pipelinesFilePath, 'utf8');
    const parsed = JSON.parse(raw) as PipelinesConfig;
    log(`Loaded pipelines.json: ${parsed.pipelines.length} pipelines (default: ${parsed.default})`);
    for (const p of parsed.pipelines) {
      log(`  Pipeline "${p.id}" (${p.name}): ${p.stages.length} stages`);
    }
    return parsed;
  } catch (e: any) {
    log(`Warning: Failed to load pipelines.json from ${pipelinesFilePath}: ${e.message}`);
    log('Falling back to built-in software pipeline definition');
    // Minimal fallback so the factory can still run the software pipeline
    return {
      default: 'software',
      pipelines: [
        {
          id: 'software',
          name: 'Software Factory',
          entryLabel: 'station:intake',
          doneLabel: 'station:done',
          detectFn: 'default',
          stages: [
            { stationId: 'spec',    label: 'station:intake',  nextLabel: 'station:spec'   },
            { stationId: 'design',  label: 'station:spec',    nextLabel: 'station:design' },
            { stationId: 'build',   label: 'station:design',  nextLabel: 'station:build'  },
            { stationId: 'qa',      label: 'station:build',   nextLabel: 'station:qa'     },
            { stationId: 'bugfix',  label: 'station:bugfix',  nextLabel: 'station:build'  },
          ],
        },
      ],
    };
  }
}

const pipelinesConfig = loadPipelinesConfig();

// ─── Build station registry (Phase 2+3) ───────────────────────────────────────

let registry: StationRegistry;
try {
  registry = await StationRegistry.createDefault(config);
  log(`Station registry: ${registry.list().join(', ')}`);
} catch (e: any) {
  log(`Fatal: Failed to build station registry: ${e.message}`);
  process.exit(1);
}

// ─── Runner deps ──────────────────────────────────────────────────────────────

const depsV2: RunnerDepsV2 = {
  config,
  REPO,
  SUPABASE_URL,
  SUPABASE_KEY,
  FACTORY_SECRET,
  FACTORY_APP_URL,
  DISCORD_WEBHOOK_URL,
  MAX_TASKS_PER_RUN,
  USE_CLAUDE_CLI,
  LOCK_FILE,
  CRASH_BACKOFF_FILE,
  LOG_FILE,

  log,
  getLocks: () => lockManager.getLocks(),
  setLock: (key, meta) => lockManager.setLock(key, meta as Omit<LockEntry, 'ts'>),
  isLocked: (key) => lockManager.isLocked(key),
  countActiveLocks: (station) => lockManager.countActiveLocks(station),
  isInCrashBackoff: (key) => backoffManager.isInCrashBackoff(key),
  getCurrentKey: () => keyManager.getCurrentKey(),
  buildAgentEnv: (apiKey) => keyManager.buildAgentEnv(apiKey),
  rotateApiKey: (reason) => keyManager.rotateKey(reason),
  checkLogForKeyError: (logPath) => keyManager.checkLogForKeyError(logPath),

  // Phase 3 additions
  pipelinesConfig,
  registry,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('═══ Factory loop starting (TypeScript v2 — multi-pipeline) ═══');

  // Clean dead locks before processing (Layer 1: includes post-exit label reconciliation)
  lockManager.setPipelinesConfig(pipelinesConfig, REPO);
  lockManager.cleanDeadLocks();

  // Upsert heartbeat to Supabase so the dashboard shows live status
  const currentLocks = lockManager.getLocks();
  await upsertHarnessHeartbeat(
    SUPABASE_URL,
    SUPABASE_KEY,
    process.pid,
    Object.keys(currentLocks).length,
    currentLocks as Record<string, unknown>,
    log,
  );

  // Layer 3: Periodic reconciliation sweep (every 10 ticks)
  maybeSweep(REPO, pipelinesConfig, log);

  // Key validation (only when using claude CLI)
  if (USE_CLAUDE_CLI) {
    const kv = await keyManager.validateKey();
    if (!kv.ok) {
      log(`❌ Key validation FAILED: ${kv.reason} — skipping spawn this tick`);
      await notifyDiscord(
        `🔴 Factory key invalid: \`${kv.reason}\` — no agents spawned. Run \`claude setup-token\` and update factory-keys.json.`,
        DISCORD_WEBHOOK_URL,
        log,
      ).catch(() => {});
      return;
    }
    log(`✅ Key validation OK`);
  }

  await tickV2(depsV2);
}

main().catch((e: Error) => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
