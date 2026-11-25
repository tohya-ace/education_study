/**
 * KouSen式 配信サーバー（Cloudflare Worker）
 *
 * Web アプリ（kousen_site）のすべてのファイルを「アプリ専用・購読者専用」で配信します。
 *
 *  1. アプリ → POST /__auth/session { appUserId }
 *       サーバーが RevenueCat に問い合わせ、Entitlement が有効なら署名付きトークンを返す
 *  2. アプリの WebView → GET /__auth/start?token=...&next=/
 *       トークンを確認して Cookie（HttpOnly）を発行し、ゲーム画面へリダイレクト
 *  3. それ以外のすべてのリクエスト
 *       Cookie が正しく期限内のときだけファイルを返す。ない／不正なら 403
 *
 * 必要な設定（wrangler.jsonc の vars と、`wrangler secret put` で入れる secrets）
 *   SESSION_SECRET      … secret。トークン署名用のランダム文字列（32文字以上）
 *   RC_SECRET_KEY       … secret。RevenueCat の Secret API key（V1）
 *   RC_ENTITLEMENT_ID   … var。例: acepocket_pro
 *   ALLOW_SANDBOX       … var。"true" ならテスト購入（Test Store / Sandbox）も許可。審査に必要なので通常 "true"
 *   APP_CLIENT_KEY      … var（任意）。アプリが送る X-KouSen-App ヘッダーと一致必須
 *   SESSION_TTL_SECONDS … var（任意）。Cookie の最長有効期間。既定 86400（24時間）
 */

const COOKIE = 'ks_session';
const AUTH_PREFIX = '/__auth/';
const RC_API = 'https://api.revenuecat.com/v1/subscribers/';
const DEFAULT_TTL = 86400;
// 期限切れ直後の更新処理の遅れを許容する猶予
const EXPIRY_GRACE_SECONDS = 60 * 60;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith(AUTH_PREFIX)) {
        return await handleAuth(request, env, url);
      }
      return await serveProtected(request, env);
    } catch (e) {
      console.error('unhandled', e && e.stack ? e.stack : e);
      return text('Internal Server Error', 500);
    }
  },
};

// ---------------------------------------------------------------------------
// 保護されたファイル配信
// ---------------------------------------------------------------------------

async function serveProtected(request, env) {
  const token = getCookie(request, COOKIE);
  const session = token ? await verifyToken(token, env) : null;
  if (!session) return forbidden(request);

  const res = await env.ASSETS.fetch(request);
  // 共有キャッシュ（CDN・プロキシ）に残らないようにする
  const out = new Response(res.body, res);
  const cc = out.headers.get('Cache-Control') || '';
  if (!/private|no-store/i.test(cc)) {
    const parts = cc
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s.toLowerCase() !== 'public');
    out.headers.set('Cache-Control', ['private', ...(parts.length ? parts : ['no-cache'])].join(', '));
  }
  out.headers.append('Vary', 'Cookie');
  applySecurityHeaders(out.headers);
  return out;
}

function forbidden(request) {
  const accept = request.headers.get('Accept') || '';
  const isPage = request.method === 'GET' && (request.mode === 'navigate' || accept.includes('text/html'));
  if (!isPage) return text('Forbidden', 403);
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>KouSen式</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#E6EFF6;color:#1F2A44;
font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;text-align:center;padding:24px}
h1{font-size:20px;color:#274F8E}p{font-size:15px;line-height:1.7}</style></head>
<body><main><h1>KouSen式アプリ専用ページです</h1>
<p>このページは「KouSen式」アプリからご利用ください。<br>アプリを開き直すと、もう一度読み込まれます。</p></main></body></html>`;
  const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  applySecurityHeaders(h);
  return new Response(html, { status: 403, headers: h });
}

function applySecurityHeaders(h) {
  h.set('X-Robots-Tag', 'noindex, nofollow');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'same-origin');
  h.set('Content-Security-Policy', "frame-ancestors 'self'");
}

// ---------------------------------------------------------------------------
// /__auth/*
// ---------------------------------------------------------------------------

async function handleAuth(request, env, url) {
  const route = url.pathname.slice(AUTH_PREFIX.length);

  // 1) アプリ（ネイティブ）からのセッション発行
  if (route === 'session' && request.method === 'POST') {
    if (!checkAppKey(request, env)) return json({ error: 'forbidden' }, 403);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const appUserId = typeof body?.appUserId === 'string' ? body.appUserId : '';
    if (!appUserId || appUserId.length > 200) return json({ error: 'bad_request' }, 400);

    // ストア審査用のアクセスコード（審査担当者は定期購入・無料トライアルを始められないため）
    // コードは Cloudflare のシークレット REVIEW_CODE に設定。未設定なら使えない
    const reviewCode = typeof body?.reviewCode === 'string' ? body.reviewCode : '';
    if (reviewCode) {
      if (!env.REVIEW_CODE || !safeEqual(reviewCode, String(env.REVIEW_CODE))) return json({ error: 'bad_code' }, 403);
      const now = Math.floor(Date.now() / 1000);
      const exp = now + (Number(env.SESSION_TTL_SECONDS) || DEFAULT_TTL);
      const token = await signToken({ v: 1, uid: 'review:' + appUserId, iat: now, exp }, env);
      return json({ token, expiresAt: exp, review: true }, 200);
    }

    let ent;
    try {
      ent = await checkEntitlement(appUserId, env);
    } catch (e) {
      console.error('revenuecat', e && e.message);
      return json({ error: 'upstream_error' }, 502);
    }
    if (!ent.active) return json({ error: 'not_entitled' }, 403);

    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(env.SESSION_TTL_SECONDS) || DEFAULT_TTL;
    let exp = now + ttl;
    if (ent.expiresAt) exp = Math.min(exp, ent.expiresAt + EXPIRY_GRACE_SECONDS);
    const token = await signToken({ v: 1, uid: appUserId, iat: now, exp }, env);
    return json({ token, expiresAt: exp }, 200);
  }

  // 2) WebView の最初の読み込み: Cookie を発行してリダイレクト
  if (route === 'start' && (request.method === 'GET' || request.method === 'HEAD')) {
    const token = url.searchParams.get('token') || '';
    const session = await verifyToken(token, env);
    if (!session) return forbidden(request);
    const next = safeNext(url.searchParams.get('next'));
    const h = new Headers({ Location: next, 'Cache-Control': 'no-store' });
    h.append('Set-Cookie', sessionCookie(token, session.exp));
    applySecurityHeaders(h);
    return new Response(null, { status: 302, headers: h });
  }

  // 3) 画面を再読み込みせずに Cookie を更新（WebView 内の fetch から呼ぶ）
  if (route === 'refresh' && request.method === 'POST') {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const session = await verifyToken(token, env);
    if (!session) return text('Forbidden', 403);
    const h = new Headers({ 'Cache-Control': 'no-store' });
    h.append('Set-Cookie', sessionCookie(token, session.exp));
    return new Response(null, { status: 204, headers: h });
  }

  // 4) ログアウト（購読が切れたときなど）
  if (route === 'logout') {
    const h = new Headers({ 'Cache-Control': 'no-store' });
    h.append('Set-Cookie', `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    return new Response(null, { status: 204, headers: h });
  }

  return text('Not Found', 404);
}

/** 長さに関係なく同じ時間で比べる（コードの推測を難しくする） */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function checkAppKey(request, env) {
  if (!env.APP_CLIENT_KEY) return true;
  return request.headers.get('X-KouSen-App') === env.APP_CLIENT_KEY;
}

function safeNext(next) {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next.startsWith(AUTH_PREFIX)) return '/';
  return next;
}

function sessionCookie(token, exp) {
  const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
  return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// ---------------------------------------------------------------------------
// RevenueCat
// ---------------------------------------------------------------------------

/**
 * RevenueCat REST API v1 で Entitlement を確認
 * @returns {{active: boolean, expiresAt: number|null}}
 */
export async function checkEntitlement(appUserId, env, fetchImpl = fetch) {
  if (!env.RC_SECRET_KEY) throw new Error('RC_SECRET_KEY is not set');
  const entitlementId = env.RC_ENTITLEMENT_ID || 'acepocket_pro';
  const res = await fetchImpl(RC_API + encodeURIComponent(appUserId), {
    headers: { Authorization: `Bearer ${env.RC_SECRET_KEY}`, Accept: 'application/json' },
  });
  if (res.status === 404) return { active: false, expiresAt: null };
  if (!res.ok) throw new Error(`RevenueCat ${res.status}`);
  const data = await res.json();
  const sub = data && data.subscriber;
  const ent = sub && sub.entitlements && sub.entitlements[entitlementId];
  if (!ent) return { active: false, expiresAt: null };

  const now = Date.now();
  const expiresMs = latestDate(ent.expires_date, ent.grace_period_expires_date);
  const active = expiresMs === null || expiresMs > now;
  if (!active) return { active: false, expiresAt: null };

  // テスト購入（Test Store / Sandbox）を本番で拒否する
  if (String(env.ALLOW_SANDBOX).toLowerCase() !== 'true') {
    const pid = ent.product_identifier;
    const purchase =
      (sub.subscriptions && sub.subscriptions[pid]) ||
      (sub.non_subscriptions && sub.non_subscriptions[pid] && sub.non_subscriptions[pid][0]);
    if (!purchase || purchase.is_sandbox !== false) return { active: false, expiresAt: null };
  }
  return { active: true, expiresAt: expiresMs === null ? null : Math.floor(expiresMs / 1000) };
}

function latestDate(...values) {
  let best = null;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  // expires_date が null（買い切り）なら無期限
  return values[0] ? best : null;
}

// ---------------------------------------------------------------------------
// 署名付きトークン（HMAC-SHA256）
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const keyCache = new Map();

async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 chars');
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    keyCache.set(secret, k);
  }
  return k;
}

export async function signToken(payload, env) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

export async function verifyToken(token, env) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  let sig;
  try {
    sig = b64urlDecode(token.slice(dot + 1));
  } catch {
    return null;
  }
  const key = await hmacKey(env.SESSION_SECRET);
  const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(body)); // 定数時間比較
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || typeof payload.exp !== 'number') return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad b64');
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function text(body, status) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
