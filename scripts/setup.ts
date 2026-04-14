import { intro, outro, text, select, confirm, spinner, isCancel, cancel, note, group } from '@clack/prompts';
import pc from 'picocolors';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAllDependencies } from './utils/manager-dependencies.js';
import { copyTemplates, getCurrentSettings, saveConfiguration, wipeConfiguration } from './utils/manager-config.js';
import { setupGithubLabels, createExampleIssue, verifyRepoExists } from './utils/manager-github.js';
import { verifyApiKey } from './utils/manager-anthropic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

async function main() {
  console.clear();
  
  intro(`${pc.bgBlack(pc.cyan(' agentic-harness 🏭 '))}`);
  
  note(
    `${pc.cyan(pc.bold('SPEC'))} ${pc.dim('→')} ${pc.blue(pc.bold('DESIGN'))} ${pc.dim('→')} ${pc.magenta(pc.bold('BUILD'))} ${pc.dim('→')} ${pc.yellow(pc.bold('QA'))} ${pc.dim('→')} ${pc.green(pc.bold('DONE'))}\n\n` +
    `${pc.dim('Configure your autonomous software factory in seconds.')}`,
    'Welcome to the future of shipping.'
  );

  const isReset = process.argv.includes('--reset');

  if (isReset) {
    const sReset = spinner();
    sReset.start('Wiping previous configuration...');
    await wipeConfiguration();
    sReset.stop(pc.green('✔ Factory Reset complete. Previous configs moved to .bak'));
  }

  // 1. Dependency Check
  let hasClaude = false;
  try {
    const deps = await checkAllDependencies();
    hasClaude = deps.hasClaude;
  } catch (error: any) {
    cancel(error.message);
    process.exit(1);
  }

  await copyTemplates();
  const current = await getCurrentSettings();

  // 2. Identity & Environment Group
  const project = await group({
    repo: () => text({
      message: `Where should the agents work? ${pc.dim('(GitHub Repository)')}`,
      placeholder: 'owner/repo',
      initialValue: current.repo && !current.repo.includes('your-repo') ? current.repo : undefined,
      validate(value) {
        if (!value) return 'A repository is required.';
        if (!value.includes('/')) return 'Format: owner/repo';
      },
    }),
    apiKey: () => text({
      message: `Anthropic API Key: ${pc.dim('(Claude\'s brain power)')}`,
      placeholder: 'sk-ant-...',
      initialValue: current.key && current.key.startsWith('sk-ant') ? current.key : undefined,
      validate(value) {
        if (!value) return 'Claude needs an API key to think!';
      },
    }),
    configureSaaS: () => confirm({
      message: `Configure SaaS environment variables? ${pc.dim('(Vercel, Supabase)')}`,
      initialValue: false,
    }),
  }, {
    onCancel: () => { cancel('Setup aborted.'); process.exit(0); }
  });

  // Verify repo access
  const sVerify = spinner();
  sVerify.start(`Verifying access to ${pc.cyan(project.repo)}...`);
  const exists = await verifyRepoExists(project.repo);
  if (!exists) {
    sVerify.stop(pc.red('✖ Repository not found or no access.'));
    const proceed = await confirm({ message: 'Continue anyway?', initialValue: false });
    if (!proceed || isCancel(proceed)) { cancel('Setup aborted.'); process.exit(1); }
  } else {
    sVerify.stop(pc.green(`✔ Verified access to ${project.repo}.`));
  }

  // Verify API Key
  let validKey = false;
  let currentKey = project.apiKey;

  while (!validKey) {
    const isOk = await verifyApiKey(currentKey);
    if (isOk) {
      validKey = true;
      project.apiKey = currentKey; 
    } else {
      const action = await select({
        message: pc.red('Anthropic API key validation failed.'),
        options: [
          { value: 'retry', label: '🔄 Try a different key', hint: 'Update the sk-ant-... token' },
          { value: 'bypass', label: '⏩ Skip validation', hint: 'Continue with current key (may fail during run)' },
          { value: 'cancel', label: '🚪 Abort setup', hint: 'Exit installation' },
        ],
      });

      if (isCancel(action) || action === 'cancel') { cancel('Setup aborted.'); process.exit(0); }
      if (action === 'bypass') break;

      const newKey = await text({
        message: 'Enter your Anthropic API Key:',
        placeholder: 'sk-ant-...',
        initialValue: currentKey.startsWith('sk-ant') ? currentKey : undefined,
        validate(val) { 
          if (!val) return 'Key is required.';
          if (!val.startsWith('sk-ant')) return 'Key must start with sk-ant';
        }
      });

      if (isCancel(newKey)) { cancel('Setup aborted.'); process.exit(0); }
      currentKey = newKey;
    }
  }

  // SaaS Sub-group
  const saas: Record<string, string> = {};
  if (project.configureSaaS) {
    const saasRes = await group({
      vercelToken: () => text({
        message: 'Vercel API Token:',
        placeholder: 'Optional',
        initialValue: current.vercelToken
      }),
      supabaseUrl: () => text({
        message: 'Supabase URL:',
        placeholder: 'https://xxx.supabase.co',
        initialValue: current.supabaseUrl
      }),
      supabaseKey: () => text({
        message: 'Supabase Service Role Key:',
        placeholder: 'ey...',
        initialValue: current.supabaseKey
      }),
    }, {
      onCancel: () => { cancel('Setup aborted.'); process.exit(0); }
    });
    if (saasRes.vercelToken) saas['VERCEL_TOKEN'] = saasRes.vercelToken;
    if (saasRes.supabaseUrl) saas['SUPABASE_URL'] = saasRes.supabaseUrl;
    if (saasRes.supabaseKey) saas['SUPABASE_SERVICE_ROLE_KEY'] = saasRes.supabaseKey;
  }

  // 3. AI Brain Group
  const brain = await group({
    model: () => select({
      message: 'Choose Claude Intelligence Profile:',
      options: [
        { value: 'claude-3-5-sonnet-latest', label: 'Balanced (Standard)', hint: 'Sonnet 3.5: Best value & speed' },
        { value: 'claude-3-opus-latest', label: 'Maximum Quality', hint: 'Opus 3: Best for complex logic' },
        { value: 'claude-3-5-haiku-latest', label: 'High Performance', hint: 'Haiku 3.5: Ultra fast & cheap' },
      ],
    }),
    setupLabels: () => confirm({
      message: 'Initialize GitHub labels automatically?',
      initialValue: true,
    }),
  }, {
    onCancel: () => { cancel('Setup aborted.'); process.exit(0); }
  });

  // 4. Persistence
  const sSave = spinner();
  sSave.start('Committing configuration to disk...');
  await saveConfiguration(project.repo, project.apiKey, hasClaude, brain.model, saas);
  sSave.stop(pc.green('✔ Configuration saved to .env and factory/config.json'));

  if (brain.setupLabels) {
    await setupGithubLabels(project.repo);
  }

  // 5. Post-Setup Menu (Dashboard)
  let exitMenu = false;
  while (!exitMenu) {
    console.clear();
    intro(pc.green('✨ agentic-harness is ready!'));
    
    const action = await select({
      message: 'What would you like to do next?',
      options: [
        { value: 'start', label: '🚀 Start Factory Loop', hint: 'Runs npm run dev' },
        { value: 'issue', label: '📝 Create Example Issue', hint: 'Queues a Todo App build' },
        { value: 'config', label: '🔍 Inspect Configuration', hint: 'View your saved settings' },
        { value: 'exit', label: '🚪 Exit', hint: 'Finish setup' },
      ],
    });

    if (isCancel(action) || action === 'exit') {
      exitMenu = true;
      outro(pc.cyan('Happy building! 🏭'));
      process.exit(0);
    }

    if (action === 'start') {
      outro(pc.green('Spawning the factory... 🚀'));
      const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', cwd: REPO_ROOT });
      child.on('close', (code) => process.exit(code || 0));
      return;
    }

    if (action === 'issue') {
      await createExampleIssue(project.repo);
      await new Promise(r => setTimeout(r, 2000)); // Pause for readability
    }

    if (action === 'config') {
      note(
        `${pc.bold('Repo:')} ${project.repo}\n` +
        `${pc.bold('Model:')} ${brain.model}\n` +
        `${pc.bold('API Key:')} ${project.apiKey.slice(0, 10)}... (Masked)\n` +
        (project.configureSaaS ? `${pc.bold('SaaS:')} Configured` : `${pc.bold('SaaS:')} Not Configured`),
        'Current Settings'
      );
      await confirm({ message: 'Press Enter to return to menu', initialValue: true });
    }
  }
}

main().catch(console.error);
