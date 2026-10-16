import test from 'node:test';
import assert from 'node:assert/strict';

import { cacheIsFresh } from '../lib/server-cache.js';
import { inventoryDistinctCountSql } from '../services/mysql.js';

test('cacheIsFresh returns true within the TTL window', () => {
  const now = 1_000;
  const cached = { ts: now - 5_000, value: { ok: true } };
  assert.equal(cacheIsFresh(cached, 30_000, now), true);
});

test('cacheIsFresh returns false once the TTL is exceeded', () => {
  const now = 1_000;
  const cached = { ts: now - 40_000, value: { ok: true } };
  assert.equal(cacheIsFresh(cached, 30_000, now), false);
});

test('inventoryDistinctCountSql de-dupes warehouse rows to unique inventory IDs', () => {
  const sql = inventoryDistinctCountSql('w');
  assert.match(sql, /COUNT\(DISTINCT TRIM\(w\.inventory_id\)\)/);
  assert.doesNotMatch(sql, /COUNT\(\*\)/);
});
