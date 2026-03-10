import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BackoffManagerImpl } from '../../factory/src/core/backoff.js';

const backoffFile = join(tmpdir(), `test-backoff-${process.pid}.json`);

function cleanup() {
  try { unlinkSync(backoffFile); } catch {}
}

describe('BackoffManagerImpl', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('starts with no backoff entries', () => {
    const bm = new BackoffManagerImpl(backoffFile, () => {});
    assert.equal(bm.isInCrashBackoff('test-key'), false);
    assert.equal(bm.getBackoff('test-key'), undefined);
  });

  it('records a crash and enters backoff', () => {
    const bm = new BackoffManagerImpl(backoffFile, () => {});
    bm.recordCrash('spec-42', true);

    assert.equal(bm.isInCrashBackoff('spec-42'), true);
    const entry = bm.getBackoff('spec-42');
    assert.ok(entry);
    assert.equal(entry.failures, 1);
    assert.ok(entry.until > Date.now());
  });

  it('escalates backoff on repeated crashes', () => {
    const bm = new BackoffManagerImpl(backoffFile, () => {});
    bm.recordCrash('spec-42', true);
    bm.recordCrash('spec-42', true);
    bm.recordCrash('spec-42', true);

    const entry = bm.getBackoff('spec-42');
    assert.ok(entry);
    assert.equal(entry.failures, 3);
    // 3 failures × 5 min = 15 min backoff
    const expectedMs = 3 * 5 * 60000;
    const actualMs = entry.until - Date.now();
    // Allow 1 second tolerance
    assert.ok(Math.abs(actualMs - expectedMs) < 1000, `Expected ~${expectedMs}ms, got ${actualMs}ms`);
  });

  it('caps backoff at 30 minutes', () => {
    const bm = new BackoffManagerImpl(backoffFile, () => {});
    for (let i = 0; i < 10; i++) bm.recordCrash('spec-42', true);

    const entry = bm.getBackoff('spec-42');
    assert.ok(entry);
    assert.equal(entry.failures, 10);
    const maxMs = 30 * 60000;
    const actualMs = entry.until - Date.now();
    assert.ok(actualMs <= maxMs + 1000, `Backoff should be capped at 30min, got ${actualMs / 60000}min`);
  });

  it('clears backoff for a key', () => {
    const bm = new BackoffManagerImpl(backoffFile, () => {});
    bm.recordCrash('spec-42', true);
    assert.equal(bm.isInCrashBackoff('spec-42'), true);

    bm.clearBackoff('spec-42');
    assert.equal(bm.isInCrashBackoff('spec-42'), false);
    assert.equal(bm.getBackoff('spec-42'), undefined);
  });

  it('persists to and loads from file', () => {
    const bm1 = new BackoffManagerImpl(backoffFile, () => {});
    bm1.recordCrash('qa-99', true);

    // Create a new instance — should load from file
    const bm2 = new BackoffManagerImpl(backoffFile, () => {});
    assert.equal(bm2.isInCrashBackoff('qa-99'), true);
    const entry = bm2.getBackoff('qa-99');
    assert.ok(entry);
    assert.equal(entry.failures, 1);
  });

  it('prunes expired entries on load', () => {
    // Write an entry that's already expired
    writeFileSync(backoffFile, JSON.stringify({
      'old-key': { failures: 5, until: Date.now() - 1000 },
      'active-key': { failures: 1, until: Date.now() + 300000 },
    }));

    const bm = new BackoffManagerImpl(backoffFile, () => {});
    assert.equal(bm.isInCrashBackoff('old-key'), false);
    assert.equal(bm.isInCrashBackoff('active-key'), true);
  });

  it('handles missing backoff file gracefully', () => {
    const bm = new BackoffManagerImpl('/nonexistent/path/backoff.json', () => {});
    assert.equal(bm.isInCrashBackoff('anything'), false);
  });
});
