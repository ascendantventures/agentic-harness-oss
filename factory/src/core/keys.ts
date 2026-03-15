import { readFileSync, writeFileSync } from 'fs';
import { spawn as spawnProcess } from 'child_process';
import type { KeyManager, KeysConfig } from '../types/index.js';

export class KeyManagerImpl implements KeyManager {
  constructor(
    private readonly keysFile: string,
    private readonly claudeBin: string,
    private readonly log: (msg: string) => void,
  ) {}

  loadKeys(): KeysConfig | null {
    try {
      return JSON.parse(readFileSync(this.keysFile, 'utf8')) as KeysConfig;
    } catch {
      return null;
    }
  }

  getCurrentKey(): string {
    // Try factory-keys.json first (multi-key rotation)
    try {
      const cfg = JSON.parse(readFileSync(this.keysFile, 'utf8')) as KeysConfig;
      if (cfg?.keys?.length > 0) {
        const idx = (cfg.currentIndex ?? 0) % cfg.keys.length;
        return cfg.keys[idx].key;
      }
    } catch {
      /* fall through */
    }
    // Fallback: env vars (standard setup)
    return (
      process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? ''
    );
  }

  rotateKey(reason = ''): void {
    const cfg = this.loadKeys();
    if (!cfg || !cfg.keys || cfg.keys.length < 2) return;
    const prev = cfg.keys[cfg.currentIndex % cfg.keys.length].account;
    cfg.currentIndex = (cfg.currentIndex + 1) % cfg.keys.length;
    const next = cfg.keys[cfg.currentIndex].account;
    writeFileSync(this.keysFile, JSON.stringify(cfg, null, 2));
    this.log(
      `🔑 API key rotated: ${prev} → ${next}${reason ? ` (${reason})` : ''}`,
    );
  }

  checkLogForKeyError(logPath: string): boolean {
    try {
      const content = readFileSync(logPath, 'utf8');
      return (
        content.includes('Invalid API key') ||
        content.includes('invalid x-api-key') ||
        content.includes('authentication_error')
      );
    } catch {
      return false;
    }
  }

  /**
   * Build the correct env for a given key.
   *
   * CRITICAL:
   *   OAuth token (sk-ant-oat*) → CLAUDE_CODE_OAUTH_TOKEN ONLY,
   *     ANTHROPIC_API_KEY must be absent.
   *   API key (sk-ant-api*) → ANTHROPIC_API_KEY ONLY,
   *     CLAUDE_CODE_OAUTH_TOKEN must be absent.
   * Setting the wrong env var causes silent hang: agent reads task,
   * makes zero network calls, 0-byte log.
   */
  buildAgentEnv(apiKey: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (apiKey.startsWith('sk-ant-oat')) {
      // OAuth token: ONLY CLAUDE_CODE_OAUTH_TOKEN
      env.CLAUDE_CODE_OAUTH_TOKEN = apiKey;
      delete env.ANTHROPIC_API_KEY;
    } else {
      // Real API key (sk-ant-api-*): ONLY ANTHROPIC_API_KEY
      env.ANTHROPIC_API_KEY = apiKey;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    return env;
  }

  validateKey(): Promise<{ ok: boolean; reason?: string }> {
    const apiKey = this.getCurrentKey();
    const keyType = apiKey.startsWith('sk-ant-oat') ? 'OAuth' : 'API key';
    this.log(`🔑 Validating ${keyType} (${apiKey.slice(0, 20)}...)`);
    return new Promise((resolve) => {
      const isRoot = process.getuid?.() === 0;
      const args = [
        '-p',
        '--model',
        'claude-haiku-4-5',
        '--output-format',
        'json',
        ...(isRoot ? [] : ['--dangerously-skip-permissions']),
      ];
      const child = spawnProcess(
        this.claudeBin,
        args,
        { env: this.buildAgentEnv(apiKey), stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let out = '';
      if (child.stdout) child.stdout.on('data', (d: Buffer) => (out += d));
      if (child.stdin) child.stdin.end('Reply with exactly: OK');
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, reason: 'timeout' });
      }, 15000);
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(out.trim().split('\n').pop() ?? '');
          resolve({ ok: !result.is_error, reason: result.result?.slice(0, 80) });
        } catch {
          resolve({ ok: false, reason: `parse error (code ${code})` });
        }
      });
    });
  }
}

