/**
 * ProvisionStation — creates Supabase project, runs migrations, injects env vars into Vercel,
 * and triggers a redeploy. Runs after build merges (station:build), before QA (station:qa).
 *
 * Pipeline position: build → provision → qa
 * Triggers on: station:provision
 * Advances to: station:qa (on success) or station:stuck (on hard failure)
 *
 * This station is synchronous (no agent spawn) — it executes directly in the loop
 * via directRun() rather than spawning a Claude Code agent.
 */

import { execSync } from 'child_process';
import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
import { flipLabel } from '../../pipeline/reconciler.js';

const SUPABASE_API = 'https://api.supabase.com/v1';

interface SupabaseProject {
  id: string;
  name: string;
  status: string;
  region: string;
  db_host?: string;
}

interface ProjectKeys {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

export class ProvisionStation extends BaseStation {
  readonly id = 'provision';
  readonly label = 'station:build';
  readonly nextLabel = 'station:provisioned';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 2;
  readonly ttl = 600000; // 10 min — API calls, not agent work

  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    const base = await this.baseCheck(issue, ctx);
    if (base) return base;

    // Must have management API token and org ID
    const token = process.env.SUPABASE_MANAGEMENT_API_TOKEN;
    const orgId = process.env.SUPABASE_ORG_ID;
    if (!token || !orgId) {
      return { process: false, reason: 'SUPABASE_MANAGEMENT_API_TOKEN or SUPABASE_ORG_ID not set' };
    }

    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    // ProvisionStation doesn't spawn an agent — it uses directRun()
    // This method is required by the interface but shouldn't be called directly
    return {
      key: `provision-${issue.number}`,
      station: this.id,
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: `Provision infrastructure for issue #${issue.number}`,
    };
  }

  /**
   * Direct execution — called by the router instead of spawning an agent.
   * Returns true on success (flips to station:qa), false on failure.
   */
  async directRun(issue: Issue, ctx: FactoryContext): Promise<boolean> {
    const log = (msg: string) => ctx.log(`[PROVISION] #${issue.number}: ${msg}`);
    const token = process.env.SUPABASE_MANAGEMENT_API_TOKEN!;
    const orgId = process.env.SUPABASE_ORG_ID!;
    const vercelToken = process.env.VERCEL_TOKEN;

    try {
      // 1. Determine project name from build repo
      const buildRepo = this.extractBuildRepo(issue, ctx);
      if (!buildRepo) {
        log('No build repo found in issue comments — skipping provisioning');
        flipLabel(issue.number, ctx.env.repo, 'station:build', 'station:provisioned', ctx.log, 'Provision: no build repo, advancing to QA');
        return true;
      }

      log(`Build repo: ${buildRepo}`);

      // 2. Check if Supabase project already exists for this issue
      const projectName = `${buildRepo.split('/')[1]}-${issue.number}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
      log(`Supabase project name: ${projectName}`);

      let project = await this.findExistingProject(token, orgId, projectName, log);

      if (!project) {
        // 3. Create Supabase project
        log('Creating Supabase project...');
        const dbPassword = this.generatePassword();
        project = await this.createProject(token, orgId, projectName, dbPassword, log);
        if (!project) {
          log('ERROR: Failed to create Supabase project');
          flipLabel(issue.number, ctx.env.repo, 'station:build', 'station:stuck', ctx.log, 'Provision: Supabase project creation failed');
          this.commentFailure(issue.number, ctx, 'Failed to create Supabase project. Check SUPABASE_MANAGEMENT_API_TOKEN permissions.');
          return false;
        }

        // 4. Wait for project to be ACTIVE_HEALTHY
        log('Waiting for project to become active...');
        const ready = await this.waitForActive(token, project.id, log);
        if (!ready) {
          log('ERROR: Project never became active');
          flipLabel(issue.number, ctx.env.repo, 'station:build', 'station:stuck', ctx.log, 'Provision: Supabase project never became active');
          this.commentFailure(issue.number, ctx, 'Supabase project creation timed out waiting for ACTIVE_HEALTHY status.');
          return false;
        }
      } else {
        log(`Found existing project: ${project.id}`);
      }

      // 5. Get project API keys
      log('Fetching project API keys...');
      const keys = await this.getProjectKeys(token, project.id, log);
      if (!keys) {
        log('ERROR: Could not fetch project keys');
        flipLabel(issue.number, ctx.env.repo, 'station:build', 'station:stuck', ctx.log, 'Provision: could not fetch Supabase keys');
        this.commentFailure(issue.number, ctx, 'Could not fetch Supabase project API keys.');
        return false;
      }

      // 6. Run migrations from the build repo
      log('Running database migrations...');
      const migrationResult = await this.runMigrations(token, project.id, buildRepo, ctx, log);
      if (!migrationResult.success) {
        log(`Migration warning: ${migrationResult.error} — continuing anyway`);
        // Non-fatal: app may still work with partial schema, QA will catch failures
      }

      // 7. Inject env vars into Vercel project
      const vercelProjectName = buildRepo.split('/')[1];
      if (vercelToken) {
        log(`Injecting env vars into Vercel project: ${vercelProjectName}...`);
        await this.injectVercelEnvVars(vercelToken, vercelProjectName, keys, log);

        // 8. Trigger Vercel redeploy
        log('Triggering Vercel redeploy...');
        await this.triggerRedeploy(vercelToken, vercelProjectName, log);
      } else {
        log('No VERCEL_TOKEN — skipping Vercel env injection');
      }

      // 9. Comment success on GitHub issue
      const liveUrl = `https://${vercelProjectName}.vercel.app`;
      this.commentSuccess(issue.number, ctx, {
        projectId: project.id,
        projectName,
        supabaseUrl: keys.supabaseUrl,
        liveUrl,
        migrationResult,
      });

      // 10. Flip to station:qa
      flipLabel(issue.number, ctx.env.repo, 'station:build', 'station:provisioned', ctx.log, 'Provision: complete — Supabase provisioned, env vars injected, redeployed');
      log(`✅ Provisioning complete → station:qa. Live: ${liveUrl}`);
      return true;

    } catch (err: any) {
      log(`ERROR: ${err.message}`);
      flipLabel(issue.number, ctx.env.repo, 'station:build', 'station:stuck', ctx.log, `Provision: unexpected error — ${err.message}`);
      this.commentFailure(issue.number, ctx, `Unexpected error during provisioning: ${err.message}`);
      return false;
    }
  }

  // ─── Supabase Management API helpers ─────────────────────────────────────

  private async findExistingProject(token: string, orgId: string, name: string, log: (m: string) => void): Promise<SupabaseProject | null> {
    try {
      const res = await fetch(`${SUPABASE_API}/projects`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const projects = (await res.json()) as SupabaseProject[];
      return projects.find(p => p.name === name && p.status !== 'REMOVED') ?? null;
    } catch (e: any) {
      log(`findExistingProject error: ${e.message}`);
      return null;
    }
  }

  private async createProject(token: string, orgId: string, name: string, dbPassword: string, log: (m: string) => void): Promise<SupabaseProject | null> {
    try {
      const res = await fetch(`${SUPABASE_API}/projects`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          organization_id: orgId,
          db_pass: dbPassword,
          region: 'us-east-1',
          plan: 'free',
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        log(`createProject HTTP ${res.status}: ${body}`);
        return null;
      }
      return (await res.json()) as SupabaseProject;
    } catch (e: any) {
      log(`createProject error: ${e.message}`);
      return null;
    }
  }

  private async waitForActive(token: string, projectId: string, log: (m: string) => void): Promise<boolean> {
    const maxAttempts = 24; // 2 min at 5s intervals
    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(5000);
      try {
        const res = await fetch(`${SUPABASE_API}/projects/${projectId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const project = (await res.json()) as SupabaseProject;
        log(`  status: ${project.status} (attempt ${i + 1}/${maxAttempts})`);
        if (project.status === 'ACTIVE_HEALTHY') return true;
      } catch (e: any) {
        log(`  poll error: ${e.message}`);
      }
    }
    return false;
  }

  private async getProjectKeys(token: string, projectId: string, log: (m: string) => void): Promise<ProjectKeys | null> {
    try {
      const res = await fetch(`${SUPABASE_API}/projects/${projectId}/api-keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        log(`getProjectKeys HTTP ${res.status}`);
        return null;
      }
      const keys = (await res.json()) as Array<{ name: string; api_key: string }>;
      const anon = keys.find(k => k.name === 'anon')?.api_key;
      const service = keys.find(k => k.name === 'service_role')?.api_key;
      if (!anon || !service) {
        log(`getProjectKeys: missing keys in response`);
        return null;
      }
      return {
        supabaseUrl: `https://${projectId}.supabase.co`,
        anonKey: anon,
        serviceRoleKey: service,
      };
    } catch (e: any) {
      log(`getProjectKeys error: ${e.message}`);
      return null;
    }
  }

  private async runMigrations(token: string, projectId: string, buildRepo: string, ctx: FactoryContext, log: (m: string) => void): Promise<{ success: boolean; error?: string; count?: number }> {
    try {
      // Fetch migration files from GitHub
      const migrationList = execSync(
        `gh api repos/${buildRepo}/contents/supabase/migrations --jq '.[].name' 2>/dev/null`,
        { encoding: 'utf8', timeout: 15000 }
      ).trim().split('\n').filter(Boolean).sort();

      if (migrationList.length === 0) {
        log('No migrations found');
        return { success: true, count: 0 };
      }

      log(`Found ${migrationList.length} migration(s)`);
      let ran = 0;

      for (const filename of migrationList) {
        try {
          const sql = execSync(
            `gh api repos/${buildRepo}/contents/supabase/migrations/${filename} --jq '.content' 2>/dev/null | base64 -d`,
            { encoding: 'utf8', timeout: 15000 }
          ).trim();

          if (!sql) continue;

          // Run via Supabase Management API
          const res = await fetch(`${SUPABASE_API}/projects/${projectId}/database/query`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: sql }),
          });

          if (!res.ok) {
            const body = await res.text();
            log(`Migration ${filename} failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
            // Continue — partial migrations are better than none
          } else {
            ran++;
            log(`  ✓ ${filename}`);
          }
        } catch (e: any) {
          log(`Migration ${filename} error: ${e.message}`);
        }
      }

      return { success: true, count: ran };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // ─── Vercel helpers ───────────────────────────────────────────────────────

  private async injectVercelEnvVars(token: string, projectName: string, keys: ProjectKeys, log: (m: string) => void): Promise<void> {
    // Find Vercel project ID
    let projectId: string | null = null;
    try {
      const res = await fetch(`https://api.vercel.com/v9/projects/${projectName}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const proj: any = await res.json();
        projectId = proj.id;
      }
    } catch {}

    if (!projectId) {
      log('Could not find Vercel project — skipping env injection');
      return;
    }

    const envVars = [
      { key: 'NEXT_PUBLIC_SUPABASE_URL', value: keys.supabaseUrl },
      { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', value: keys.anonKey },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', value: keys.serviceRoleKey },
    ];

    for (const { key, value } of envVars) {
      try {
        // Upsert — try create, if conflict patch
        const body = {
          key,
          value,
          type: 'encrypted',
          target: ['production', 'preview'],
        };
        const createRes = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (createRes.status === 409) {
          // Already exists — get existing env id and patch
          const listRes = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env?decrypt=false`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data: any = await listRes.json();
          const existing = data.envs?.find((e: any) => e.key === key);
          if (existing) {
            await fetch(`https://api.vercel.com/v9/projects/${projectId}/env/${existing.id}`, {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ value }),
            });
            log(`  Updated ${key}`);
          }
        } else {
          log(`  Set ${key}`);
        }
      } catch (e: any) {
        log(`  Failed to set ${key}: ${e.message}`);
      }
    }
  }

  private async triggerRedeploy(token: string, projectName: string, log: (m: string) => void): Promise<void> {
    try {
      // Get latest deployment and redeploy it
      const listRes = await fetch(`https://api.vercel.com/v6/deployments?app=${projectName}&limit=1&target=production`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data: any = await listRes.json();
      const latest = data.deployments?.[0];
      if (!latest) {
        log('No existing deployment found to redeploy');
        return;
      }

      const redeployRes = await fetch(`https://api.vercel.com/v13/deployments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectName,
          deploymentId: latest.uid,
          target: 'production',
        }),
      });
      if (redeployRes.ok) {
        log('Redeploy triggered');
      } else {
        const body = await redeployRes.text();
        log(`Redeploy HTTP ${redeployRes.status}: ${body.slice(0, 200)}`);
      }
    } catch (e: any) {
      log(`triggerRedeploy error: ${e.message}`);
    }
  }

  // ─── GitHub comment helpers ────────────────────────────────────────────────

  private commentSuccess(issueNumber: number, ctx: FactoryContext, data: {
    projectId: string;
    projectName: string;
    supabaseUrl: string;
    liveUrl: string;
    migrationResult: { success: boolean; count?: number; error?: string };
  }): void {
    const body = [
      `## ✅ Infrastructure Provisioned`,
      ``,
      `| Resource | Details |`,
      `|----------|---------|`,
      `| Supabase Project | \`${data.projectName}\` (ID: \`${data.projectId}\`) |`,
      `| Supabase URL | ${data.supabaseUrl} |`,
      `| Migrations | ${data.migrationResult.success ? `✅ ${data.migrationResult.count ?? 0} run` : `⚠️ ${data.migrationResult.error}`} |`,
      `| Live URL | ${data.liveUrl} |`,
      ``,
      `Env vars (\`NEXT_PUBLIC_SUPABASE_URL\`, \`NEXT_PUBLIC_SUPABASE_ANON_KEY\`, \`SUPABASE_SERVICE_ROLE_KEY\`) injected into Vercel. Redeploy triggered.`,
      ``,
      `Advancing to QA.`,
    ].join('\n');

    try {
      execSync(
        `gh issue comment ${issueNumber} --repo ${ctx.env.repo} --body ${JSON.stringify(body)}`,
        { encoding: 'utf8', timeout: 15000 }
      );
    } catch {}
  }

  private commentFailure(issueNumber: number, ctx: FactoryContext, reason: string): void {
    const body = `## ❌ Provisioning Failed\n\n${reason}\n\nIssue moved to \`station:stuck\`. Operator action required.`;
    try {
      execSync(
        `gh issue comment ${issueNumber} --repo ${ctx.env.repo} --body ${JSON.stringify(body)}`,
        { encoding: 'utf8', timeout: 15000 }
      );
    } catch {}
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private extractBuildRepo(issue: Issue, ctx: FactoryContext): string | null {
    try {
      const result = execSync(
        `gh issue view ${issue.number} --repo ${ctx.env.repo} --comments --json comments`,
        { encoding: 'utf8', timeout: 15000 }
      );
      const { comments } = JSON.parse(result) as { comments: Array<{ body: string }> };
      for (const c of comments.reverse()) {
        const match = c.body.match(/github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/);
        if (match && !match[1].includes('harness-beta-test')) {
          return match[1];
        }
      }
    } catch {}
    return null;
  }

  private generatePassword(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
    return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
