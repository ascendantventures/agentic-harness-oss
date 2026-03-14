import { intro, outro, text, select, confirm, spinner, isCancel, cancel, note } from '@clack/prompts';
import picocolors from 'picocolors';
import pc from 'picocolors';
import { exec, spawn, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

async function checkDependencies() {
  let s = spinner();
  s.start('Checking dependencies (Node.js, claude, gh)...');
  
  try {
    // Check Node.js >= 18
    const nodeVersionLine = process.version;
    const nodeMajor = parseInt(nodeVersionLine.replace('v', '').split('.')[0], 10);
    if (nodeMajor < 18) {
      throw new Error(`Node.js 18+ required (found: ${nodeVersionLine})`);
    }

    // Check claude CLI
    try {
      await execAsync('claude --version');
    } catch {
      s.stop(pc.yellow('claude CLI not found.'));
      const shouldInstall = await confirm({
        message: 'claude CLI is required but not installed. Do you want to install it now via npm?',
        initialValue: true,
      });

      if (!shouldInstall || isCancel(shouldInstall)) {
        throw new Error(`claude CLI not found.\nInstall via: ${pc.cyan('npm install -g @anthropic-ai/claude-code')}`);
      }

      s.start('Installing claude CLI (this may take a minute)...');
      try {
        await execAsync('npm install -g @anthropic-ai/claude-code');
      } catch (installErr: any) {
        throw new Error(`Failed to install claude CLI automatically. You may need sudo, or check your npm permissions.\nPlease install manually: ${pc.cyan('npm install -g @anthropic-ai/claude-code')}`);
      }
      
      // Resume spinner for remaining checks
      s.start('Checking remaining dependencies (gh)...');
    }

    // Check gh CLI
    let ghInstalled = false;
    try {
      await execAsync('gh --version');
      ghInstalled = true;
    } catch {}

    if (!ghInstalled) {
      s.stop(pc.yellow('  GitHub CLI (gh) not found.'));
      
      const osName = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
      const pkgManagers = process.platform === 'darwin' ? 'Homebrew' : process.platform === 'win32' ? 'winget / choco' : 'apt-get / Homebrew';

      const installGh = await confirm({
        message: `GitHub CLI is required but not installed. Do you want to try installing it automatically on ${pc.bold(osName)}? ${pc.dim(`(Uses ${pkgManagers})`)}`,
        initialValue: true,
      });

      if (installGh && !isCancel(installGh)) {
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
          ghInstalled = true;
          s.stop(pc.green('✔ GitHub CLI installed successfully!'));
        } catch (e: any) {
          if (e.message.includes('sudo snap')) throw e; // Pass through our custom Linux error
          throw new Error(`Failed to install gh automatically.\nReason: ${e.message}\nPlease install from: ${pc.cyan('https://cli.github.com')}`);
        }
      } else {
        throw new Error(`Install gh manually from ${pc.cyan('https://cli.github.com')}`);
      }
    }

    s.stop(pc.green('✔ Base dependencies (Node.js, claude, gh) found.'));

    // Check gh CLI auth
    s = spinner();
    s.start('Checking GitHub authentication...');
    let authSuccess = false;
    while (!authSuccess) {
      try {
        await execAsync('gh auth status');
        authSuccess = true;
      } catch {
        s.stop(pc.yellow('  GitHub CLI is not authenticated.'));
        
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

        s = spinner();
        s.start('Authenticating GitHub CLI...');
        try {
          await execAsync(`echo "${ghToken}" | gh auth login --with-token`);
          authSuccess = true;
          s.stop(pc.green('✔ GitHub authenticated.'));
        } catch (e: any) {
          s.stop(pc.red('  Failed to authenticate with that token. Please try again.'));
        }
      }
    }

    s.stop(pc.green('✔ All dependencies are installed and authenticated!'));
  } catch (error: any) {
    s.stop(pc.red('✖ Dependency check failed.'));
    cancel(error.message);
    process.exit(1);
  }
}

async function handleFiles() {
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

async function setupGithubLabels(repo: string) {
  const s = spinner();
  s.start(`Setting up GitHub labels for ${pc.cyan(repo)}...`);

  const labels = [
    "station:intake", "station:spec", "station:design", "station:build", 
    "station:qa", "station:uat", "station:bugfix", "station:done", "station:skip", 
    "station:blocked", "status:paused", "complexity:simple", "complexity:medium", 
    "complexity:complex"
  ];

  let successCount = 0;
  for (const label of labels) {
    try {
      await execAsync(`gh label create "${label}" --repo ${repo}`);
      successCount++;
    } catch (e: any) {
      // If it already exists, gh CLI will fail with an error. We can ignore it safely.
      // Usually the error contains: 'already exists'
    }
  }

  s.stop(pc.green(`GitHub labels checked/created successfully.`));
}

async function updateEnvAndConfig(repo: string, apiKey: string) {
  const configPath = path.join(REPO_ROOT, 'factory', 'config.json');
  const envPath = path.join(REPO_ROOT, '.env');

  // Update factory/config.json using JSON parsing
  try {
    let configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    if (!config.github) config.github = {};
    config.github.repo = repo;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    // If it fails to parse, fallback to safe regex against old values
    let configContent = await fs.readFile(configPath, 'utf8');
    configContent = configContent.replace(/"repo":\s*".*?"/, `"repo": "${repo}"`);
    await fs.writeFile(configPath, configContent, 'utf8');
  }

  // Update .env using robust anchors
  let envContent = await fs.readFile(envPath, 'utf8');
  
  if (envContent.match(/^GITHUB_REPO=.*/m)) {
    envContent = envContent.replace(/^GITHUB_REPO=.*/m, `GITHUB_REPO=${repo}`);
  } else {
    envContent += `\nGITHUB_REPO=${repo}`;
  }

  // Clear existing uncommented keys to avoid duplicates
  envContent = envContent.replace(/^ANTHROPIC_API_KEY=.*/gm, '# ANTHROPIC_API_KEY=');
  envContent = envContent.replace(/^CLAUDE_CODE_OAUTH_TOKEN=.*/gm, '# CLAUDE_CODE_OAUTH_TOKEN=');

  if (apiKey.startsWith('sk-ant-oat')) {
    envContent = envContent.replace(/^#?\s*CLAUDE_CODE_OAUTH_TOKEN=.*/m, `CLAUDE_CODE_OAUTH_TOKEN=${apiKey}`);
  } else {
    envContent = envContent.replace(/^#?\s*ANTHROPIC_API_KEY=.*/m, `ANTHROPIC_API_KEY=${apiKey}`);
  }

  await fs.writeFile(envPath, envContent, 'utf8');
}

async function main() {
  console.clear();
  
  intro(`
  ${pc.bgCyan(pc.black(' 🏭 agentic-harness installer '))}
  ${pc.dim('The autonomous software factory.')}
  
  ${pc.cyan(pc.bold('SPEC'))} ${pc.dim('→')} ${pc.blue(pc.bold('DESIGN'))} ${pc.dim('→')} ${pc.magenta(pc.bold('BUILD'))} ${pc.dim('→')} ${pc.yellow(pc.bold('QA'))} ${pc.dim('→')} ${pc.green(pc.bold('DONE'))}
  `);

  const isReset = process.argv.includes('--reset');

  if (isReset) {
    try { await fs.unlink(path.join(REPO_ROOT, 'factory', 'config.json')); } catch {}
    try { await fs.unlink(path.join(REPO_ROOT, '.env')); } catch {}
    note('Previous configuration wiped safely.', '🧹 Factory Reset Triggered');
  }

  await checkDependencies();

  await handleFiles();

  // Try to read existing values for defaults
  let currentRepo = '';
  let currentKey = '';
  try {
    const envContent = await fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8');
    const repoMatch = envContent.match(/^GITHUB_REPO=(.+)$/m);
    if (repoMatch) currentRepo = repoMatch[1].trim();
    
    const oauthMatch = envContent.match(/^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m);
    const apiMatch = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (oauthMatch && !oauthMatch[1].includes('your-vercel-token')) currentKey = oauthMatch[1].trim();
    else if (apiMatch && !apiMatch[1].includes('your-vercel-token')) currentKey = apiMatch[1].trim();
  } catch (e) {}

  if (currentRepo && currentRepo !== 'owner/your-repo' && currentKey && currentKey.startsWith('sk-ant')) {
    const shouldOverwrite = await confirm({
      message: `It looks like agentic-harness is already configured for ${pc.cyan(currentRepo)}.\n  Do you want to overwrite the current configuration?`,
      initialValue: false,
    });

    if (isCancel(shouldOverwrite)) {
      cancel('Operation cancelled. Let\'s build later!');
      process.exit(0);
    }
    
    if (!shouldOverwrite) {
      outro(pc.green('✔ Configuration left unchanged. You are good to go! 🚀'));
      process.exit(0);
    }
  }

  const repo = await text({
    message: `Where should the agents work? ${pc.dim('(GitHub Repository)')}`,
    placeholder: 'owner/repo',
    initialValue: currentRepo && currentRepo !== 'owner/your-repo' ? currentRepo : undefined,
    validate(value) {
      if (!value || value.length === 0) return 'Hmm, I really need a repository to work in.';
      if (!value.includes('/')) return 'Format should be: owner/repo (e.g. danywalls/my-app)';
    },
  });

  if (isCancel(repo)) {
    cancel('Operation cancelled.');
    process.exit(0);
  }

  const apiKey = await text({
    message: `What is your Anthropic API Key? ${pc.dim('(Required for Claude)')}`,
    placeholder: 'sk-ant-...',
    initialValue: currentKey && currentKey.startsWith('sk-ant') ? currentKey : undefined,
    validate(value) {
      if (!value || value.length === 0) return 'Claude needs an API key to think!';
    },
  });

  if (isCancel(apiKey)) {
    cancel('Operation cancelled.');
    process.exit(0);
  }

  const setupLabels = await confirm({
    message: `Should I create the required issue labels via ${pc.bold('gh')} in your repo automatically?`,
    initialValue: true,
  });

  if (isCancel(setupLabels)) {
    cancel('Operation cancelled.');
    process.exit(0);
  }

  const sFiles = spinner();
  sFiles.start('Writing configuration files...');
  await updateEnvAndConfig(repo as string, apiKey as string);
  sFiles.stop(pc.green('✔ Configuration files written.'));

  if (setupLabels) {
    await setupGithubLabels(repo as string);
  }

  const testIssue = await confirm({
    message: `Do you want to queue your first agent task now? ${pc.dim('(Creates a "Todo App" issue)')}`,
    initialValue: true,
  });

  if (testIssue && !isCancel(testIssue)) {
    const sIssue = spinner();
    sIssue.start('Creating example issue on GitHub...');
    try {
      await execAsync(`gh issue create --repo ${repo} --title "Build a simple todo app with auth" --body "A task management app. Users can sign up, create todos, mark them done. Deploy to Vercel." --label "station:intake"`);
      sIssue.stop(pc.green('✔ Example issue created!'));
    } catch (e: any) {
      sIssue.stop(pc.yellow('⚠ Failed to create example issue (check your gh permissions).'));
    }
  }

  const startNow = await confirm({
    message: `Do you want to start the factory loop now? ${pc.dim(`(Runs ${pc.cyan('npm run dev')})`)}`,
    initialValue: true,
  });

  note(
    `${pc.cyan('1.')} Your keys have been securely saved to ${pc.cyan('.env')}\n` +
    `${pc.cyan('2.')} Your harness settings are in ${pc.cyan('factory/config.json')}\n` +
    `${pc.cyan('3.')} To deploy from scratch anytime, run: ${pc.cyan(pc.bold('npm run dev'))}`,
    '✨ You are ready to go!'
  );

  if (startNow && !isCancel(startNow)) {
    outro(pc.green('Starting the factory loop... 🚀'));
    
    const child = spawn('npm', ['run', 'dev'], {
      stdio: 'inherit',
      cwd: REPO_ROOT
    });

    child.on('close', (code) => {
      process.exit(code || 0);
    });

    return; // Prevent reaching the second outro
  }

  outro(pc.green('✔ agentic-harness is ready! Happy building! 🏭'));
}

main().catch(console.error);
