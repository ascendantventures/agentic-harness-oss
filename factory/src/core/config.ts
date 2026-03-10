import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '../types/index.js';

const __dirname_config = dirname(fileURLToPath(import.meta.url));

/** Default config path — resolved relative to factory/src/core/ → factory/config.json */
const DEFAULT_CONFIG_PATH = join(__dirname_config, '../../config.json');

export function loadConfig(configPath?: string): Config {
  const path = configPath ?? process.env.FACTORY_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return validateConfig(raw);
}

export function validateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be a JSON object');
  }
  const cfg = raw as Record<string, unknown>;

  // Provide sensible defaults
  const config: Config = {
    stations: (cfg.stations as Config['stations']) ?? {},
    github: {
      repo: (cfg.github as any)?.repo ?? (process.env.GITHUB_REPO ?? 'owner/repo'),
      issueLabels: (cfg.github as any)?.issueLabels,
    },
    concurrency: {
      maxTasksPerRun: (cfg.concurrency as any)?.maxTasksPerRun ?? 2,
      build: (cfg.concurrency as any)?.build,
      qa: (cfg.concurrency as any)?.qa,
      design: (cfg.concurrency as any)?.design,
    },
    notify: cfg.notify as Config['notify'],
  };

  return config;
}
