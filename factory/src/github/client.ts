import { execSync } from 'child_process';

/**
 * Run a `gh` command that returns JSON output.
 * Automatically appends `--repo <REPO>` and `--json number,title,body,labels,url`.
 */
export function gh(cmd: string, repo: string): unknown {
  const result = execSync(
    `gh ${cmd} --repo ${repo} --json number,title,body,labels,url 2>/dev/null`,
    { encoding: 'utf8', timeout: 30000 },
  );
  return JSON.parse(result);
}

/**
 * Run a `gh` write command (comment, edit, label) that doesn't support --json output.
 */
export function ghWrite(cmd: string, repo: string): void {
  execSync(`gh ${cmd} --repo ${repo}`, { encoding: 'utf8', timeout: 30000 });
}

/**
 * Run an arbitrary gh command (no automatic --repo or --json injection).
 */
export function ghRaw(cmd: string, repo: string): string {
  return execSync(`gh ${cmd} --repo ${repo} 2>/dev/null`, {
    encoding: 'utf8',
    timeout: 30000,
  });
}

/**
 * Run an arbitrary gh command without a repo flag (e.g., `gh api ...`).
 */
export function ghNoRepo(cmd: string): string {
  return execSync(`gh ${cmd} 2>/dev/null`, {
    encoding: 'utf8',
    timeout: 30000,
  });
}
