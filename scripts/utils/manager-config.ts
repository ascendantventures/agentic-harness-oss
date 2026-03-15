import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export async function copyTemplates(): Promise<void> {
  const configExamplePath = path.join(REPO_ROOT, 'factory', 'config.example.json');
  const configPath = path.join(REPO_ROOT, 'factory', 'config.json');
  const envExamplePath = path.join(REPO_ROOT, '.env.example');
  const envPath = path.join(REPO_ROOT, '.env');

  try {
    await fs.access(configPath);
  } catch {
    await fs.copyFile(configExamplePath, configPath);
  }

  try {
    await fs.access(envPath);
  } catch {
    await fs.copyFile(envExamplePath, envPath);
  }
}

export async function getCurrentSettings(): Promise<{ repo: string; key: string }> {
  let currentRepo = '';
  let currentKey = '';
  try {
    const envContent = await fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8');
    const repoMatch = envContent.match(/^GITHUB_REPO=(.+)$/m);
    if (repoMatch) currentRepo = repoMatch[1].trim();
    
    const oauthMatch = envContent.match(/^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m);
    const apiMatch = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (oauthMatch && !oauthMatch[1].includes('your-vercel-token')) currentKey = oauthMatch[1].split('#')[0].trim();
    else if (apiMatch && !apiMatch[1].includes('your-vercel-token')) currentKey = apiMatch[1].split('#')[0].trim();
  } catch (e) {
    // Ignore errors reading existing config
  }
  return { repo: currentRepo, key: currentKey };
}

export async function saveConfiguration(repo: string, apiKey: string, hasClaude = false, model?: string): Promise<void> {
  const configPath = path.join(REPO_ROOT, 'factory', 'config.json');
  const envPath = path.join(REPO_ROOT, '.env');

  // Update factory/config.json using JSON parsing
  try {
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    if (!config.github) config.github = {};
    config.github.repo = repo;

    // Apply global model preference to all stations if provided
    if (model && config.stations) {
      for (const stationId in config.stations) {
        if (config.stations[stationId]) {
          config.stations[stationId].model = model;
        }
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    // If it fails to parse, fallback to safe regex against old values
    let configContent = await fs.readFile(configPath, 'utf8');
    configContent = configContent.replace(/"repo":\s*".*?"/, `"repo": "${repo}"`);
    if (model) {
      configContent = configContent.replace(/"model":\s*".*?"/g, `"model": "${model}"`);
    }
    await fs.writeFile(configPath, configContent, 'utf8');
  }

  // Update .env using robust anchors
  let envContent = await fs.readFile(envPath, 'utf8');
  
  if (envContent.match(/^GITHUB_REPO=.*/m)) {
    envContent = envContent.replace(/^GITHUB_REPO=.*/m, `GITHUB_REPO=${repo}`);
  } else {
    envContent += `\nGITHUB_REPO=${repo}`;
  }

  // Remove all existing key lines (commented or not) to avoid duplicates
  envContent = envContent.replace(/^#?\s*ANTHROPIC_API_KEY=.*\n?/gm, '');
  envContent = envContent.replace(/^#?\s*CLAUDE_CODE_OAUTH_TOKEN=.*\n?/gm, '');

  // Append the correct key
  if (apiKey.startsWith('sk-ant-oat')) {
    envContent += `\nCLAUDE_CODE_OAUTH_TOKEN=${apiKey}`;
  } else {
    envContent += `\nANTHROPIC_API_KEY=${apiKey}`;
  }

  // Handle FACTORY_USE_CLAUDE
  if (hasClaude) {
    if (envContent.match(/^#?\s*FACTORY_USE_CLAUDE=.*/m)) {
      envContent = envContent.replace(/^#?\s*FACTORY_USE_CLAUDE=.*/m, 'FACTORY_USE_CLAUDE=1');
    } else {
      envContent += '\nFACTORY_USE_CLAUDE=1';
    }
  }

  await fs.writeFile(envPath, envContent, 'utf8');
}

export async function wipeConfiguration(): Promise<void> {
    const configPath = path.join(REPO_ROOT, 'factory', 'config.json');
    const envPath = path.join(REPO_ROOT, '.env');
    try { await fs.rename(configPath, configPath + '.bak'); } catch {}
    try { await fs.rename(envPath, envPath + '.bak'); } catch {}
}
