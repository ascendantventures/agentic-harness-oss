/**
 * Integration tests for station shouldProcess() logic and buildTask() output.
 *
 * These tests verify that:
 * - Stations respect base checks (skip, paused, phase2 labels)
 * - Stations produce well-formed AgentTask objects
 * - Task prompts reference config-driven values, not hardcoded ones
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Issue, AgentTask } from '../../factory/src/types/index.js';
import type { FactoryContext, FactoryEnv } from '../../factory/src/stations/base.js';
import { SpecStation } from '../../factory/src/stations/spec/index.js';
import { QAStation } from '../../factory/src/stations/qa/index.js';
import { BugfixStation } from '../../factory/src/stations/bugfix/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<FactoryEnv> = {}): FactoryEnv {
  return {
    repo: 'test-org/test-repo',
    supabaseUrl: '',
    supabaseKey: '',
    factorySecret: 'test-secret',
    factoryAppUrl: 'https://test.example.com',
    discordWebhookUrl: '',
    useClaudeCli: true,
    logFile: '/tmp/test-factory.log',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FactoryEnv> = {}): FactoryContext {
  return {
    config: {
      stations: {},
      github: { repo: 'test-org/test-repo' },
      concurrency: { maxTasksPerRun: 2 },
    },
    env: makeEnv(overrides),
    log: () => {},
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 42,
    title: 'Build a todo app',
    labels: ['station:intake'],
    body: 'A simple todo application with auth.',
    isInternal: false,
    isChangeRequest: false,
    buildRepo: null,
    manifest: { name: 'Todo App', description: 'A todo app' },
    ...overrides,
  } as Issue;
}

// ── Base check tests (shared across all stations) ────────────────────────────

describe('Station base checks', () => {
  const spec = new SpecStation();

  it('skips issues with station:skip label', async () => {
    const issue = makeIssue({ labels: ['station:intake', 'station:skip'] });
    const result = await spec.shouldProcess(issue, makeCtx());
    assert.equal(result.process, false);
    assert.ok(result.reason?.includes('skip'));
  });

  it('skips paused issues', async () => {
    const issue = makeIssue({ labels: ['station:intake', 'status:paused'] });
    const result = await spec.shouldProcess(issue, makeCtx());
    assert.equal(result.process, false);
    assert.ok(result.reason?.includes('paused'));
  });

  it('skips phase2 issues', async () => {
    const issue = makeIssue({ labels: ['station:intake', 'type:phase2'] });
    const result = await spec.shouldProcess(issue, makeCtx());
    assert.equal(result.process, false);
    assert.ok(result.reason?.includes('phase2'));
  });

  it('processes normal issues', async () => {
    const issue = makeIssue({ labels: ['station:intake'] });
    const result = await spec.shouldProcess(issue, makeCtx());
    assert.equal(result.process, true);
  });
});

// ── SpecStation ──────────────────────────────────────────────────────────────

describe('SpecStation', () => {
  const spec = new SpecStation();

  it('has correct metadata', () => {
    assert.equal(spec.id, 'spec');
    assert.equal(spec.label, 'station:intake');
    assert.equal(spec.nextLabel, 'station:spec');
  });

  it('builds a task with correct structure', async () => {
    const issue = makeIssue();
    const task = await spec.buildTask(issue, makeCtx());

    assert.ok(task.key, 'task should have a key');
    assert.equal(task.station, 'spec');
    assert.equal(task.issueNumber, 42);
    assert.ok(task.message.length > 100, 'task prompt should be substantial');
  });

  it('task prompt does not contain hardcoded personal references', async () => {
    const issue = makeIssue();
    const task = await spec.buildTask(issue, makeCtx());

    assert.ok(!task.message.includes('isaacdl15'), 'should not contain isaacdl15');
    assert.ok(!task.message.includes('/home/openclaw3'), 'should not contain /home/openclaw3');
    assert.ok(!task.message.includes('Angel Agents'), 'should not contain Angel Agents');
  });

  it('task prompt references the configured repo', async () => {
    const issue = makeIssue();
    const task = await spec.buildTask(issue, makeCtx());

    assert.ok(
      task.message.includes('test-org/test-repo'),
      'should reference the configured repo from ctx.env.repo',
    );
  });

  it('skips issues with no manifest in non-standalone mode', async () => {
    const issue = makeIssue({
      manifest: null as any,
      labels: ['station:intake'],
    });
    const ctx = makeCtx({ supabaseUrl: 'https://project.supabase.co', supabaseKey: 'key' });
    const result = await spec.shouldProcess(issue, ctx);
    assert.equal(result.process, false);
    assert.ok(result.reason?.includes('manifest'));
  });

  it('processes issues with no manifest in standalone mode', async () => {
    const issue = makeIssue({
      manifest: null as any,
      labels: ['station:intake'],
    });
    // standalone = no supabaseUrl
    const result = await spec.shouldProcess(issue, makeCtx());
    assert.equal(result.process, true);
  });
});

// ── QAStation ────────────────────────────────────────────────────────────────

describe('QAStation', () => {
  const qa = new QAStation();

  it('has correct metadata', () => {
    assert.equal(qa.id, 'qa');
    assert.equal(qa.label, 'station:build');
    assert.equal(qa.nextLabel, 'station:qa');
  });

  it('builds a task without hardcoded references', async () => {
    const issue = makeIssue({
      labels: ['station:build'],
      buildRepo: 'test-org/todo-app',
      deployedUrl: 'https://todo-app.vercel.app',
    } as any);
    const task = await qa.buildTask(issue, makeCtx());

    assert.ok(!task.message.includes('isaacdl15'));
    assert.ok(!task.message.includes('/home/openclaw3'));
    assert.ok(!task.message.includes('Angel Agents'));
  });
});

// ── BugfixStation ────────────────────────────────────────────────────────────

describe('BugfixStation', () => {
  const bugfix = new BugfixStation();

  it('has correct metadata', () => {
    assert.equal(bugfix.id, 'bugfix');
    assert.equal(bugfix.label, 'station:bugfix');
    assert.equal(bugfix.nextLabel, 'station:build');
  });

  it('builds a task without hardcoded references', async () => {
    const issue = makeIssue({
      labels: ['station:bugfix'],
      buildRepo: 'test-org/todo-app',
    } as any);
    const task = await bugfix.buildTask(issue, makeCtx());

    assert.ok(!task.message.includes('isaacdl15'));
    assert.ok(!task.message.includes('PEDRO_VERCEL_TOKEN'));
    assert.ok(!task.message.includes('/home/openclaw3'));
    assert.ok(!task.message.includes('Angel Agents'));
  });
});
