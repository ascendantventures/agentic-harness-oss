import { text, confirm, spinner, isCancel, cancel, note } from '@clack/prompts';
import pc from 'picocolors';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function checkNodeVersion(): Promise<void> {
  const nodeVersionLine = process.version;
  const nodeMajor = parseInt(nodeVersionLine.replace('v', '').split('.')[0], 10);
  if (nodeMajor < 18) {
    throw new Error(`Node.js 18+ required (found: ${nodeVersionLine})`);
  }
}

export async function ensureClaudeCli(): Promise<boolean> {
  try {
    await execAsync('claude --version');
    return true;
  } catch {
    const shouldInstall = await confirm({
      message: 'claude CLI is required but not installed. Do you want to install it now via npm?',
      initialValue: true,
    });

    if (!shouldInstall || isCancel(shouldInstall)) {
      return false; // Not critical if they want to use something else, but we should know
    }

    const s = spinner();
    s.start('Installing claude CLI (this may take a minute)...');
    try {
      await execAsync('npm install -g @anthropic-ai/claude-code');
      s.stop(pc.green('✔ claude CLI installed successfully!'));
      return true;
    } catch (installErr: any) {
      s.stop(pc.red('✖ Installation failed.'));
      return false;
    }
  }
}

export async function ensureGitHubCli(): Promise<void> {
  try {
    await execAsync('gh --version');
    return;
  } catch {}

  const osName = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const pkgManagers = process.platform === 'darwin' ? 'Homebrew' : process.platform === 'win32' ? 'winget / choco' : 'apt-get / Homebrew';

  const installGh = await confirm({
    message: `GitHub CLI is required but not installed. Do you want to try installing it automatically on ${pc.bold(osName)}? ${pc.dim(`(Uses ${pkgManagers})`)}`,
    initialValue: true,
  });

  if (installGh && !isCancel(installGh)) {
    const s = spinner();
    s.start(`Installing GitHub CLI for ${osName}...`);
    try {
      if (process.platform === 'darwin') {
        await execAsync('HOMEBREW_NO_AUTO_UPDATE=1 brew install gh');
      } else if (process.platform === 'win32') {
        try {
           await execAsync('winget install --id GitHub.cli');
        } catch {
           await execAsync('choco install gh -y');
        }
      } else {
        // For Linux, sudo prompts break the TUI. We must instruct the user.
        s.stop(pc.yellow('  Auto-install on Linux requires sudo.'));
        throw new Error(
          `Please open a new terminal and install GitHub CLI manually:\n` +
          `  ${pc.bold('Ubuntu/Debian:')} ${pc.cyan('sudo snap install gh')} OR ${pc.cyan('sudo apt install gh')}\n` +
          `  ${pc.bold('Other:')} ${pc.cyan('https://cli.github.com')}\n\n` +
          `After installing, re-run: ${pc.cyan('npm run setup:reset')}`
        );
      }
      s.stop(pc.green('✔ GitHub CLI installed successfully!'));
    } catch (e: any) {
      if (e.message.includes('sudo snap') || e.message.includes('open a new terminal')) throw e; // Pass through our custom Linux error
      s.stop(pc.red('✖ Installation failed.'));
      throw new Error(`Failed to install gh automatically.\nReason: ${e.message}\nPlease install from: ${pc.cyan('https://cli.github.com')}`);
    }
  } else {
    throw new Error(`Install gh manually from ${pc.cyan('https://cli.github.com')}`);
  }
}

export async function authenticateGitHub(): Promise<void> {
  let authSuccess = false;
  while (!authSuccess) {
    try {
      await execAsync('gh auth status');
      authSuccess = true;
      return; // Already authenticated
    } catch {
      note(
        `To authenticate GitHub CLI, please create a Personal Access Token (classic)\nwith ${pc.bold('repo')}, ${pc.bold('read:org')}, and ${pc.bold('workflow')} scopes at:\n` + 
        pc.cyan(pc.underline('https://github.com/settings/tokens')), 
        '🔑 GitHub Token required'
      );

      const ghToken = await text({
        message: 'Paste your GitHub Personal Access Token:',
        placeholder: 'ghp_...',
      });

      if (isCancel(ghToken) || !ghToken) {
        throw new Error(`Authentication cancelled. You must run ${pc.cyan('gh auth login')} manually later.`);
      }

      const s = spinner();
      s.start('Authenticating GitHub CLI...');
      try {
        await new Promise<void>((resolve, reject) => {
          const child = exec('gh auth login --with-token', (err) => {
            if (err) reject(err);
            else resolve();
          });
          child.stdin?.write(ghToken as string);
          child.stdin?.end();
        });
        authSuccess = true;
        s.stop(pc.green('✔ GitHub authenticated.'));
      } catch (e: any) {
        s.stop(pc.red('  Failed to authenticate with that token. Please try again.'));
      }
    }
  }
}

export async function checkAllDependencies(): Promise<{ hasClaude: boolean }> {
  const s = spinner();
  s.start('Checking basic environment (Node.js)...');
  await checkNodeVersion();
  s.stop(pc.green('✔ Node.js version is compatible.'));
  
  const hasClaude = await ensureClaudeCli();
  await ensureGitHubCli();

  s.start('Checking GitHub authentication...');
  s.stop('Checking GitHub authentication...'); // Need to stop before prompt in authenticateGitHub might happen
  await authenticateGitHub();

  return { hasClaude };
}

