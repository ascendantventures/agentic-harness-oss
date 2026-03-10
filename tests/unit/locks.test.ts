import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLockTTL, isProcessAlive, lockKey, LOCK_TTL, LOCK_TTL_SIMPLE } from '../../factory/src/core/locks.js';

describe('lockKey', () => {
  it('generates correct key format', () => {
    assert.equal(lockKey(42, 'spec'), '42-spec');
    assert.equal(lockKey(100, 'bugfix'), '100-bugfix');
  });
});

describe('getLockTTL', () => {
  it('returns normal TTL for known stations', () => {
    assert.equal(getLockTTL('spec'), LOCK_TTL.spec);
    assert.equal(getLockTTL('qa'), LOCK_TTL.qa);
    assert.equal(getLockTTL('build'), LOCK_TTL.build);
    assert.equal(getLockTTL('design'), LOCK_TTL.design);
    assert.equal(getLockTTL('bugfix'), LOCK_TTL.bugfix);
  });

  it('returns simple TTL when isSimple is true', () => {
    assert.equal(getLockTTL('spec', true), LOCK_TTL_SIMPLE.spec);
    assert.equal(getLockTTL('build', true), LOCK_TTL_SIMPLE.build);
  });

  it('returns default TTL for unknown stations', () => {
    assert.equal(getLockTTL('unknown-station'), 7200000);
    assert.equal(getLockTTL('unknown-station', true), 7200000);
  });

  it('simple TTLs are shorter than normal TTLs', () => {
    for (const station of Object.keys(LOCK_TTL)) {
      assert.ok(
        LOCK_TTL_SIMPLE[station]! < LOCK_TTL[station]!,
        `Simple TTL for ${station} should be shorter than normal`,
      );
    }
  });
});

describe('isProcessAlive', () => {
  it('returns true for current process', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 99999999 almost certainly doesn't exist
    assert.equal(isProcessAlive(99999999), false);
  });

  it('returns true when PID is undefined (legacy lock)', () => {
    assert.equal(isProcessAlive(undefined), true);
  });
});
