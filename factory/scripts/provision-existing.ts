#!/usr/bin/env npx tsx
/**
 * Retroactive provisioning — creates Supabase projects, runs migrations, and
 * injects env vars for apps that were built before the provision station existed.
 *
 * Usage: npx tsx factory/scripts/provision-existing.ts
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Manual .env loading (no dotenv dependency)
const envPath = path.join(import.meta.dirname ?? '.', '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const SUPABASE_API = 'https://api.supabase.com/v1';
const token = process.env.SUPABASE_MANAGEMENT_API_TOKEN!;
const orgId = process.env.SUPABASE_ORG_ID!;
const vercelToken = process.env.VERCEL_TOKEN!;

if (!token || !orgId) {
  console.error('Missing SUPABASE_MANAGEMENT_API_TOKEN or SUPABASE_ORG_ID in .env');
  process.exit(1);
}

interface AppToProvision {
  repo: string;           // e.g. ascendantventures/postly-issue-141
  vercelProject: string;  // Vercel project name
  hasMigrations: boolean;
}

const apps: AppToProvision[] = [
  { repo: 'ascendantventures/postly-issue-141', vercelProject: 'postly-issue-141', hasMigrations: true },
  { repo: 'ascendantventures/happydog-build-169', vercelProject: 'happydog-build', hasMigrations: true },
  { repo: 'ascendantventures/fcrm-build-157', vercelProject: 'fcrm-build-157', hasMigrations: true },
  { repo: 'ascendantventures/salon-booking-149', vercelProject: 'salon-booking-149', hasMigrations: true },
];

function generatePassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findExistingProject(name: string): Promise<any | null> {
  const res = await fetch(`${SUPABASE_API}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const projects = (await res.json()) as any[];
  return projects.find((p: any) => p.name === name && p.status !== 'REMOVED') ?? null;
}

async function createProject(name: string): Promise<any | null> {
  console.log(`  Creating Supabase project: ${name}...`);
  const res = await fetch(`${SUPABASE_API}/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      organization_id: orgId,
      db_pass: generatePassword(),
      region: 'us-east-1',
      plan: 'free',
    }),
  });
  if (!res.ok) {
    console.error(`  HTTP ${res.status}: ${await res.text()}`);
    return null;
  }
  return await res.json();
}

async function waitForActive(projectId: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const res = await fetch(`${SUPABASE_API}/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const project = (await res.json()) as any;
    console.log(`  Status: ${project.status} (${i + 1}/30)`);
    if (project.status === 'ACTIVE_HEALTHY') return true;
  }
  return false;
}

async function getKeys(projectId: string): Promise<{ url: string; anonKey: string; serviceKey: string } | null> {
  const res = await fetch(`${SUPABASE_API}/projects/${projectId}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys = (await res.json()) as any[];
  const anon = keys.find((k: any) => k.name === 'anon')?.api_key;
  const service = keys.find((k: any) => k.name === 'service_role')?.api_key;
  if (!anon || !service) return null;
  return { url: `https://${projectId}.supabase.co`, anonKey: anon, serviceKey: service };
}

async function runMigrations(projectId: string, repo: string): Promise<number> {
  let ran = 0;
  try {
    const files = execSync(
      `gh api repos/${repo}/contents/supabase/migrations --jq '.[].name' 2>/dev/null`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim().split('\n').filter(Boolean).sort();

    console.log(`  Found ${files.length} migration(s)`);

    for (const file of files) {
      const sql = execSync(
        `gh api repos/${repo}/contents/supabase/migrations/${file} --jq '.content' 2>/dev/null | base64 -d`,
        { encoding: 'utf8', timeout: 15000 }
      ).trim();

      if (!sql) continue;

      const res = await fetch(`${SUPABASE_API}/projects/${projectId}/database/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      });

      if (res.ok) {
        ran++;
        console.log(`  ✓ ${file}`);
      } else {
        console.log(`  ✗ ${file}: ${(await res.text()).slice(0, 100)}`);
      }
    }
  } catch (e: any) {
    console.log(`  Migration error: ${e.message}`);
  }
  return ran;
}

async function injectVercelEnvVars(projectName: string, keys: { url: string; anonKey: string; serviceKey: string }): Promise<void> {
  if (!vercelToken) {
    console.log('  No VERCEL_TOKEN — skipping');
    return;
  }

  // Get project ID
  const projRes = await fetch(`https://api.vercel.com/v9/projects/${projectName}`, {
    headers: { Authorization: `Bearer ${vercelToken}` },
  });
  if (!projRes.ok) {
    console.log(`  Vercel project "${projectName}" not found (HTTP ${projRes.status})`);
    return;
  }
  const proj = (await projRes.json()) as any;
  const projectId = proj.id;

  const envVars = [
    { key: 'NEXT_PUBLIC_SUPABASE_URL', value: keys.url },
    { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', value: keys.anonKey },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', value: keys.serviceKey },
  ];

  for (const { key, value } of envVars) {
    const body = { key, value, type: 'encrypted', target: ['production', 'preview'] };
    const createRes = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${vercelToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (createRes.status === 409) {
      // Update existing
      const listRes = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env?decrypt=false`, {
        headers: { Authorization: `Bearer ${vercelToken}` },
      });
      const data = (await listRes.json()) as any;
      const existing = data.envs?.find((e: any) => e.key === key);
      if (existing) {
        await fetch(`https://api.vercel.com/v9/projects/${projectId}/env/${existing.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${vercelToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        console.log(`  Updated ${key}`);
      }
    } else if (createRes.ok) {
      console.log(`  Set ${key}`);
    } else {
      console.log(`  Failed ${key}: HTTP ${createRes.status}`);
    }
  }

  // Trigger redeploy
  const listRes = await fetch(`https://api.vercel.com/v6/deployments?app=${projectName}&limit=1&target=production`, {
    headers: { Authorization: `Bearer ${vercelToken}` },
  });
  const deplData = (await listRes.json()) as any;
  const latest = deplData.deployments?.[0];
  if (latest) {
    const reRes = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${vercelToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projectName, deploymentId: latest.uid, target: 'production' }),
    });
    console.log(`  Redeploy: ${reRes.ok ? '✓' : `HTTP ${reRes.status}`}`);
  }
}

async function main() {
  console.log('=== Retroactive Provisioning ===\n');

  for (const app of apps) {
    console.log(`\n📦 ${app.repo}`);
    const projectName = app.vercelProject.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Check existing
    let project = await findExistingProject(projectName);
    if (project) {
      console.log(`  Found existing Supabase project: ${project.id} (${project.status})`);
    } else {
      project = await createProject(projectName);
      if (!project) {
        console.log('  ❌ FAILED — skipping');
        continue;
      }
      console.log(`  Created: ${project.id}`);

      const ready = await waitForActive(project.id);
      if (!ready) {
        console.log('  ❌ Timed out waiting for ACTIVE_HEALTHY');
        continue;
      }
    }

    // Get keys
    const keys = await getKeys(project.id);
    if (!keys) {
      console.log('  ❌ Could not fetch keys');
      continue;
    }
    console.log(`  Supabase URL: ${keys.url}`);

    // Run migrations
    if (app.hasMigrations) {
      const ran = await runMigrations(project.id, app.repo);
      console.log(`  Migrations: ${ran} applied`);
    }

    // Inject into Vercel
    await injectVercelEnvVars(app.vercelProject, keys);

    console.log(`  ✅ Done`);

    // Rate limit: wait between projects
    await sleep(2000);
  }

  console.log('\n=== Complete ===');
}

main().catch(console.error);
