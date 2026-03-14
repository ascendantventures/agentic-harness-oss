import { spinner } from '@clack/prompts';
import pc from 'picocolors';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function setupGithubLabels(repo: string): Promise<void> {
  const s = spinner();
  s.start(`Setting up GitHub labels for ${pc.cyan(repo)}...`);

  const labels = [
    "station:intake", "station:spec", "station:design", "station:build", 
    "station:qa", "station:uat", "station:bugfix", "station:done", "station:skip", 
    "station:blocked", "status:paused", "complexity:simple", "complexity:medium", 
    "complexity:complex", "type:internal"
  ];

  for (const label of labels) {
    try {
      await execAsync(`gh label create "${label}" --repo ${repo}`);
    } catch (e: any) {
      // If it already exists, gh CLI will fail with an error. We can ignore it safely.
      // Usually the error contains: 'already exists'
    }
  }

  s.stop(pc.green(`✔ GitHub labels checked/created successfully.`));
}

export async function createExampleIssue(repo: string): Promise<void> {
  const sIssue = spinner();
  sIssue.start('Creating example issue on GitHub...');
  try {
    await execAsync(`gh issue create --repo ${repo} --title "Build a simple todo app with auth" --body "A task management app. Users can sign up, create todos, mark them done. Deploy to Vercel." --label "station:intake" --label "type:internal"`);
    sIssue.stop(pc.green('✔ Example issue created!'));
  } catch (e: any) {
    sIssue.stop(pc.yellow('⚠ Failed to create example issue (check your gh permissions).'));
  }
}
