import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUICK_SYNC_MIN_GAP_MS,
  shouldSkipQuickSync,
  readLastQuickSyncAt,
  writeLastQuickSyncAt,
} from '../lib/auto-sync-throttle.js';

test('shouldSkipQuickSync blocks a retry within the minimum gap', () => {
  const now = 120_000;
  const lastSyncAt = 90_000;
  assert.equal(shouldSkipQuickSync(now, lastSyncAt, QUICK_SYNC_MIN_GAP_MS), true);
});

test('shouldSkipQuickSync allows a retry after the minimum gap', () => {
  const now = 120_000;
  const lastSyncAt = 0;
  assert.equal(shouldSkipQuickSync(now, lastSyncAt, QUICK_SYNC_MIN_GAP_MS), false);
});

test('read/write helpers store and restore the timestamp', () => {
  const storage = new Map();
  const fakeStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  };

  writeLastQuickSyncAt(fakeStorage, 'acu_last_quick_sync', 42);
  assert.equal(readLastQuickSyncAt(fakeStorage, 'acu_last_quick_sync'), 42);
});
