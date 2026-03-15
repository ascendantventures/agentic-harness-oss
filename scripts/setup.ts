import { intro, outro, text, select, confirm, spinner, isCancel, cancel, note } from '@clack/prompts';
import pc from 'picocolors';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAllDependencies } from './utils/manager-dependencies.js';
import { copyTemplates, getCurrentSettings, saveConfiguration, wipeConfiguration } from './utils/manager-config.js';
import { setupGithubLabels, createExampleIssue } from './utils/manager-github.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

async function main() {
  console.clear();
  
  intro(`
  ${pc.bgCyan(pc.black(' 🏭 agentic-harness installer '))}
  ${pc.dim('The autonomous software factory.')}
  
  ${pc.cyan(pc.bold('SPEC'))} ${pc.dim('→')} ${pc.blue(pc.bold('DESIGN'))} ${pc.dim('→')} ${pc.magenta(pc.bold('BUILD'))} ${pc.dim('→')} ${pc.yellow(pc.bold('QA'))} ${pc.dim('→')} ${pc.green(pc.bold('DONE'))}
  `);

  const isReset = process.argv.includes('--reset');

  if (isReset) {
    await wipeConfiguration();
    note('Previous configuration wiped safely.', '🧹 Factory Reset Triggered');
  }

  let hasClaude = false;
  try {
    const deps = await checkAllDependencies();
    hasClaude = deps.hasClaude;
  } catch (error: any) {
    cancel(error.message);
    process.exit(1);
  }

  await copyTemplates();

  const { repo: currentRepo, key: currentKey } = await getCurrentSettings();

  const isDummyRepo = currentRepo === 'owner/your-repo' || currentRepo === 'owner/repo';
  const isDummyKey = currentKey.includes('...');

  if (currentRepo && !isDummyRepo && currentKey && currentKey.startsWith('sk-ant') && !isDummyKey) {
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
    initialValue: currentRepo && !isDummyRepo ? currentRepo : undefined,
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
    initialValue: currentKey && currentKey.startsWith('sk-ant') && !isDummyKey ? currentKey : undefined,
    validate(value) {
      if (!value || value.length === 0) return 'Claude needs an API key to think!';
    },
  });

  if (isCancel(apiKey)) {
    cancel('Operation cancelled.');
    process.exit(0);
  }

  const model = await select({
    message: `Which Claude model should the factory use?`,
    options: [
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4', hint: 'recommended: balanced power & speed' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4', hint: 'lowest latency & cost' },
      { value: 'claude-opus-4-5', label: 'Claude Opus 4', hint: 'highest quality' },
    ],
  });

  if (isCancel(model)) {
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
  await saveConfiguration(repo as string, apiKey as string, hasClaude, model as string);
  sFiles.stop(pc.green('✔ Configuration files written.'));

  if (setupLabels) {
    await setupGithubLabels(repo as string);
  }

  const testIssue = await confirm({
    message: `Do you want to queue your first agent task now? ${pc.dim('(Creates a "Todo App" issue)')}`,
    initialValue: true,
  });

  if (testIssue && !isCancel(testIssue)) {
    await createExampleIssue(repo as string);
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
