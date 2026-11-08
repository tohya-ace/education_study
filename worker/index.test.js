// 認証まわりの単体テスト:  node --test worker/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { checkEntitlement, signToken, verifyToken } from './index.js';

const SECRET = 'x'.repeat(40);
const future = new Date(Date.now() + 7 * 864e5).toISOString();
const past = new Date(Date.now() - 864e5).toISOString();

function rcResponse({ expires = future, sandbox = true, entitlement = 'acepocket_pro' } = {}) {
  return {
    subscriber: {
      entitlements: { [entitlement]: { expires_date: expires, grace_period_expires_date: null, product_identifier: 'kousen_monthly_trial2w' } },
      subscriptions: { kousen_monthly_trial2w: { is_sandbox: sandbox, expires_date: expires, period_type: 'trial' } },
      non_subscriptions: {},
    },
  };
}

const fakeFetch = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

function makeEnv(extra = {}) {
  return {
    SESSION_SECRET: SECRET,
    RC_SECRET_KEY: 'sk_test',
    RC_ENTITLEMENT_ID: 'acepocket_pro',
    ALLOW_SANDBOX: 'true',
    APP_CLIENT_KEY: 'kousen-app-v1',
    ASSETS: { fetch: async (req) => new Response('<h1>game</h1>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=0, must-revalidate' } }) },
    ...extra,
  };
}

test('entitlement: active trial (sandbox allowed)', async () => {
  const r = await checkEntitlement('u1', makeEnv(), fakeFetch(rcResponse()));
  assert.equal(r.active, true);
  assert.ok(r.expiresAt > Date.now() / 1000);
});

test('entitlement: sandbox rejected in production mode', async () => {
  const r = await checkEntitlement('u1', makeEnv({ ALLOW_SANDBOX: 'false' }), fakeFetch(rcResponse()));
  assert.equal(r.active, false);
  const r2 = await checkEntitlement('u1', makeEnv({ ALLOW_SANDBOX: 'false' }), fakeFetch(rcResponse({ sandbox: false })));
  assert.equal(r2.active, true);
});

test('entitlement: expired / missing', async () => {
  assert.equal((await checkEntitlement('u1', makeEnv(), fakeFetch(rcResponse({ expires: past })))).active, false);
  assert.equal((await checkEntitlement('u1', makeEnv(), fakeFetch(rcResponse({ entitlement: 'other' })))).active, false);
  assert.equal((await checkEntitlement('u1', makeEnv(), fakeFetch({}, 404))).active, false);
  await assert.rejects(checkEntitlement('u1', makeEnv(), fakeFetch({}, 500)));
});

test('token: sign/verify, tamper, expiry, wrong secret', async () => {
  const env = makeEnv();
  const now = Math.floor(Date.now() / 1000);
  const t = await signToken({ v: 1, uid: 'u1', iat: now, exp: now + 60 }, env);
  assert.equal((await verifyToken(t, env)).uid, 'u1');
  const [b, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, uid: 'evil', iat: now, exp: now + 9999 })).toString('base64url');
  assert.equal(await verifyToken(`${forged}.${s}`, env), null);
  assert.equal(await verifyToken(`${b}.${s.slice(0, -2)}AA`, env), null);
  assert.equal(await verifyToken('garbage', env), null);
  const old = await signToken({ v: 1, uid: 'u1', iat: now - 100, exp: now - 1 }, env);
  assert.equal(await verifyToken(old, env), null);
  assert.equal(await verifyToken(t, makeEnv({ SESSION_SECRET: 'y'.repeat(40) })), null);
});

test('worker: blocks without cookie, serves with cookie', async () => {
  const env = makeEnv();
  const page = new Request('https://k.test/index.html', { headers: { Accept: 'text/html' } });
  const r1 = await worker.fetch(page, env);
  assert.equal(r1.status, 403);
  assert.match(await r1.text(), /アプリ専用/);

  const now = Math.floor(Date.now() / 1000);
  const t = await signToken({ v: 1, uid: 'u1', iat: now, exp: now + 60 }, env);
  const r2 = await worker.fetch(new Request('https://k.test/index.html', { headers: { Cookie: `a=b; ks_session=${t}` } }), env);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('Cache-Control'), 'private, max-age=0, must-revalidate');
  assert.equal(r2.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('worker: /__auth/session issues token only for entitled users', async () => {
  const realFetch = globalThis.fetch;
  try {
    const env = makeEnv();
    const req = (body, key = 'kousen-app-v1') =>
      new Request('https://k.test/__auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-KouSen-App': key },
        body: JSON.stringify(body),
      });

    globalThis.fetch = fakeFetch(rcResponse());
    assert.equal((await worker.fetch(req({ appUserId: 'u1' }, 'wrong'), env)).status, 403);
    assert.equal((await worker.fetch(req({}), env)).status, 400);
    const ok = await worker.fetch(req({ appUserId: '$RCAnonymousID:abc' }), env);
    assert.equal(ok.status, 200);
    const { token, expiresAt } = await ok.json();
    assert.ok(token && expiresAt);

    // start → Cookie 発行 → リダイレクト（外部へのリダイレクトは不可）
    const st = await worker.fetch(new Request(`https://k.test/__auth/start?token=${encodeURIComponent(token)}&next=//evil.com`), env);
    assert.equal(st.status, 302);
    assert.equal(st.headers.get('Location'), '/');
    assert.match(st.headers.get('Set-Cookie'), /^ks_session=.+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    const st2 = await worker.fetch(new Request(`https://k.test/__auth/start?token=${encodeURIComponent(token)}&next=%2Fcat_1.html%3Ffrom%3D1`), env);
    assert.equal(st2.headers.get('Location'), '/cat_1.html?from=1');
    assert.equal((await worker.fetch(new Request('https://k.test/__auth/start?token=bad'), env)).status, 403);

    // refresh
    const rf = await worker.fetch(new Request('https://k.test/__auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env);
    assert.equal(rf.status, 204);
    assert.match(rf.headers.get('Set-Cookie'), /^ks_session=/);

    globalThis.fetch = fakeFetch(rcResponse({ expires: past }));
    const ng = await worker.fetch(req({ appUserId: 'u2' }), env);
    assert.equal(ng.status, 403);
    assert.deepEqual(await ng.json(), { error: 'not_entitled' });

    globalThis.fetch = fakeFetch({}, 500);
    assert.equal((await worker.fetch(req({ appUserId: 'u3' }), env)).status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
});
