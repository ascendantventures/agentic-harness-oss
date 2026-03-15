import { spawn as spawnProcess } from 'child_process';
import { writeFileSync, mkdirSync, openSync, closeSync } from 'fs';
import { execSync } from 'child_process';
import type { AgentTask, AgentHandle } from '../types/index.js';

const TASK_DIR = '/tmp/factory-tasks';
const AGENT_LOG_DIR = '/tmp/factory-agent-logs';

const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? 'openclaw';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

/** Per-station timeout in seconds */
const TIMEOUT_BY_STATION: Record<string, string> = {
  spec: '1200',
  qa: '1200',
  design: '3600',
  build: '3600',
  bugfix: '3600',
};

export function spawnAgent(
  task: AgentTask,
  useClaudeCli: boolean,
  buildAgentEnv: (apiKey: string) => NodeJS.ProcessEnv,
  getCurrentKey: () => string,
  log: (msg: string) => void,
): AgentHandle {
  // Write task message to a temp file (avoids shell arg escaping issues)
  try { mkdirSync(TASK_DIR, { recursive: true }); } catch {}
  const taskFile = `${TASK_DIR}/${task.key}-${Date.now()}.txt`;
  writeFileSync(taskFile, task.message, 'utf8');

  const timeout = TIMEOUT_BY_STATION[task.station] ?? '3600';

  // Capture stdout/stderr to per-agent log file
  try { mkdirSync(AGENT_LOG_DIR, { recursive: true }); } catch {}
  const agentLogFile = `${AGENT_LOG_DIR}/${task.key}-${Date.now()}.log`;
  const logFd = openSync(agentLogFile, 'a');

  let child: ReturnType<typeof spawnProcess>;

  if (useClaudeCli) {
    // ── v2: Claude Code CLI (claude -p) ──────────────────────────────────
    const apiKey = getCurrentKey();
    const model = task.model ?? 'claude-sonnet-4-6';
    const taskFd = openSync(taskFile, 'r');
    child = spawnProcess(
      CLAUDE_BIN,
      [
        '-p',
        '--model', model,
        '--output-format', 'json',
        '--allowedTools', 'Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)',
        ...(process.getuid?.() === 0 ? [] : ['--dangerously-skip-permissions']),
      ],
      {
        detached: true,
        stdio: [taskFd, logFd, logFd],
        env: buildAgentEnv(apiKey),
      },
    );
    closeSync(taskFd);
  } else {
    // ── v1: OpenClaw agent --local ────────────────────────────────────────
    // ISOLATION FIX: OPENCLAW_STATE_DIR per-task → empty sessions.json →
    // --session-id used correctly → no shared .jsonl lock contention.
    const sessionId = `factory-${task.key}-${Date.now()}`;
    const taskStateDir = `/tmp/factory-state-${sessionId}`;
    try { mkdirSync(taskStateDir, { recursive: true }); } catch {}
    child = spawnProcess(
      OPENCLAW_BIN,
      [
        'agent', '--local', '--agent', 'main',
        '--session-id', sessionId,
        '--message', task.message,
        '--timeout', timeout,
      ],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: taskStateDir,
          OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH ?? '',
        },
      },
    );
    // Clean per-task state dirs older than 4h
    try {
      execSync(
        `find /tmp -maxdepth 1 -name "factory-state-*" -mmin +240 -exec rm -rf {} + 2>/dev/null || true`,
      );
    } catch {}
  }

  child.unref();
  closeSync(logFd);

  // Clean agent logs older than 48h to prevent disk bloat
  try {
    execSync(`find ${AGENT_LOG_DIR} -name "*.log" -mmin +2880 -delete 2>/dev/null || true`);
  } catch {}

  const runtime = useClaudeCli ? 'claude-cli' : 'openclaw';
  log(
    `🚀 Spawned agent for task: ${task.key} [${runtime}] (pid: ${child.pid}) — log: ${agentLogFile}`,
  );

  return {
    pid: child.pid,
    logFile: agentLogFile,
    startedAt: Date.now(),
    task,
  };
}
