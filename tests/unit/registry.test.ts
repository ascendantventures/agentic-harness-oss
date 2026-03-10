import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StationRegistry } from '../../factory/src/stations/registry.js';
import { BaseStation } from '../../factory/src/stations/base.js';
import type { Issue, AgentTask } from '../../factory/src/types/index.js';
import type { FactoryContext, ShouldProcessResult } from '../../factory/src/stations/base.js';

/** Minimal concrete station for testing */
class TestStation extends BaseStation {
  readonly id: string;
  readonly label: string;
  readonly nextLabel: string;
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 1;
  readonly ttl = 1800000;

  constructor(id: string, label: string, nextLabel: string) {
    super();
    this.id = id;
    this.label = label;
    this.nextLabel = nextLabel;
  }

  async shouldProcess(): Promise<ShouldProcessResult> {
    return { process: true };
  }

  async buildTask(_issue: Issue, _ctx: FactoryContext): Promise<AgentTask> {
    return {
      key: `${this.id}-test`,
      station: this.id,
      issueNumber: 1,
      issueTitle: 'test',
      model: this.model,
      message: 'test prompt',
    };
  }
}

describe('StationRegistry', () => {
  it('registers and retrieves a station by id', () => {
    const registry = new StationRegistry();
    const station = new TestStation('spec', 'station:intake', 'station:spec');
    registry.register(station);

    const found = registry.get('spec');
    assert.ok(found);
    assert.equal(found.id, 'spec');
  });

  it('retrieves a station by label', () => {
    const registry = new StationRegistry();
    const station = new TestStation('spec', 'station:intake', 'station:spec');
    registry.register(station);

    const found = registry.getByLabel('station:intake');
    assert.ok(found);
    assert.equal(found.id, 'spec');
  });

  it('returns undefined for unknown id', () => {
    const registry = new StationRegistry();
    assert.equal(registry.get('nonexistent'), undefined);
  });

  it('returns undefined for unknown label', () => {
    const registry = new StationRegistry();
    assert.equal(registry.getByLabel('station:nonexistent'), undefined);
  });

  it('throws on duplicate station id', () => {
    const registry = new StationRegistry();
    registry.register(new TestStation('spec', 'station:intake', 'station:spec'));

    assert.throws(() => {
      registry.register(new TestStation('spec', 'station:other', 'station:spec'));
    }, /already registered/);
  });

  it('lists all registered station ids', () => {
    const registry = new StationRegistry();
    registry.register(new TestStation('spec', 'station:intake', 'station:spec'));
    registry.register(new TestStation('build', 'station:design', 'station:build'));
    registry.register(new TestStation('qa', 'station:build', 'station:qa'));

    const ids = registry.list();
    assert.deepEqual(ids, ['spec', 'build', 'qa']);
  });

  it('getAll returns station instances in order', () => {
    const registry = new StationRegistry();
    registry.register(new TestStation('spec', 'station:intake', 'station:spec'));
    registry.register(new TestStation('build', 'station:design', 'station:build'));

    const all = registry.getAll();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.id, 'spec');
    assert.equal(all[1]!.id, 'build');
  });
});
