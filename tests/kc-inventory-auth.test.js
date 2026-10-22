import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { requireInventoryUser, decodeJwt } from '../app/api/flutter-kelinconnect-inventory/_lib/auth.js';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function sign(payload, secret = 'test-secret', alg = 'HS256') {
  const head = b64({ alg, typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function req(token, extra = {}) {
  const headers = new Headers(extra);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return { headers };
}

const future = () => Math.floor(Date.now() / 1000) + 3600;

test('decodeJwt reads the payload and rejects junk', () => {
  assert.equal(decodeJwt('nope'), null);
  assert.equal(decodeJwt(sign({ loginid: 'KG1', exp: future() })).payload.loginid, 'KG1');
});

test('missing bearer is 401', async () => {
  await assert.rejects(requireInventoryUser(req('')), (e) => e.status === 401);
});

test('local HS256: valid token gives the login id and name', async () => {
  process.env.KC_JWT_SECRET = 'test-secret';
  try {
    const ctx = await requireInventoryUser(req(sign({ loginid: 'KG0543', name: 'Juan Dela Cruz', exp: future() })));
    assert.deepEqual(ctx.user, { loginId: 'KG0543', name: 'Juan Dela Cruz' });
  } finally {
    delete process.env.KC_JWT_SECRET;
  }
});

test('local HS256: wrong signature and expired tokens are 401', async () => {
  process.env.KC_JWT_SECRET = 'test-secret';
  try {
    await assert.rejects(
      requireInventoryUser(req(sign({ loginid: 'X', exp: future() }, 'other-secret'))),
      (e) => e.status === 401
    );
    await assert.rejects(
      requireInventoryUser(req(sign({ loginid: 'X', exp: 1 }))),
      (e) => e.status === 401
    );
  } finally {
    delete process.env.KC_JWT_SECRET;
  }
});

test('remote check: KelinConnect 401 rejects, 200 accepts and is cached', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  let status = 401;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    assert.match(init.headers.Authorization, /^Bearer /);
    return new Response(JSON.stringify({ ok: true }), { status });
  };
  try {
    const rejected = sign({ loginid: 'A1', exp: future() }, 'kc-secret');
    await assert.rejects(requireInventoryUser(req(rejected)), (e) => e.status === 401);

    status = 200;
    const accepted = sign({ sub: 'B2', exp: future() }, 'kc-secret');
    const r = req(accepted, { 'x-kc-user-name': 'Maria' });
    const ctx = await requireInventoryUser(r);
    assert.deepEqual(ctx.user, { loginId: 'B2', name: 'Maria' });

    const before = calls;
    await requireInventoryUser(r);
    assert.equal(calls, before, 'second call should use the cache');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('remote check: tries the next KelinConnect URL when the first reply has no employee id', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/api/auth/session')
      ? { authenticated: true, user: { id: 'uuid-2', email: 'a@b.c' } }
      : { success: true, data: [{ employee_id: 'KG0999', employee_name: 'Ana' }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const ctx = await requireInventoryUser(req(sign({ sub: 'uuid-2', exp: future() }, 'kc-secret-2')));
    assert.equal(ctx.user.loginId, 'KG0999');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('remote check: app sign-in id is ignored unless KC_TRUST_APP_LOGIN_ID=1', async () => {
  const realFetch = globalThis.fetch;
  const realTrust = process.env.KC_TRUST_APP_LOGIN_ID;
  delete process.env.KC_TRUST_APP_LOGIN_ID;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ authenticated: true, user: { id: 'uuid-6', email: 'x@y.z' } }),
    { status: 200 }
  );
  try {
    const ctx = await requireInventoryUser(req(sign({ userId: 'uuid-6', exp: future() }, 'kc-secret-6'), { 'x-kc-login-id': 'KG0751' }));
    assert.equal(ctx.user.loginId, 'unknown');
  } finally {
    globalThis.fetch = realFetch;
    if (realTrust === undefined) delete process.env.KC_TRUST_APP_LOGIN_ID;
    else process.env.KC_TRUST_APP_LOGIN_ID = realTrust;
  }
});

test('remote check: app sign-in id is used only when trusted and KelinConnect accepts the token', async () => {
  const realFetch = globalThis.fetch;
  const realTrust = process.env.KC_TRUST_APP_LOGIN_ID;
  process.env.KC_TRUST_APP_LOGIN_ID = '1';
  let status = 200;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ authenticated: true, user: { id: 'uuid-3', email: 'x@y.z' } }),
    { status }
  );
  try {
    const ok = await requireInventoryUser(req(sign({ userId: 'uuid-3', exp: future() }, 'kc-secret-3'), { 'x-kc-login-id': 'kg0751' }));
    assert.equal(ok.user.loginId, 'KG0751');

    const junk = await requireInventoryUser(req(sign({ userId: 'uuid-4', exp: future() }, 'kc-secret-4'), { 'x-kc-login-id': "KG1' OR 1=1" }));
    assert.equal(junk.user.loginId, 'unknown');

    status = 401;
    await assert.rejects(
      requireInventoryUser(req(sign({ userId: 'uuid-5', exp: future() }, 'kc-secret-5'), { 'x-kc-login-id': 'KG0751' })),
      (e) => e.status === 401
    );
  } finally {
    globalThis.fetch = realFetch;
    if (realTrust === undefined) delete process.env.KC_TRUST_APP_LOGIN_ID;
    else process.env.KC_TRUST_APP_LOGIN_ID = realTrust;
  }
});

test('remote check: employee id comes from the KelinConnect reply when the token has none', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ authenticated: true, user: { id: 'uuid-1', employee_id: 'KG0751', full_name: 'Carlo R' } }),
    { status: 200 }
  );
  try {
    const ctx = await requireInventoryUser(req(sign({ sub: 'uuid-1', exp: future() }, 'kc-secret')));
    assert.deepEqual(ctx.user, { loginId: 'KG0751', name: 'Carlo R' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
