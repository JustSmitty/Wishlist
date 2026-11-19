import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp } from './helpers.mjs';
import { GOOGLE, resetGoogleKeyCache, safeReturnPath } from '../src/services/google.mjs';
import { loadConfig } from '../src/config.mjs';

const CLIENT = { clientId: 'test-client.apps.example', clientSecret: 'test-secret', redirectUri: 'http://localhost:3456/api/auth/google/callback' };

/**
 * Stands in for Google: issues authorization codes, checks the token request
 * the way Google's token endpoint would (client, redirect address, PKCE), and
 * signs ID tokens with a key it publishes. No network.
 */
function fakeGoogle() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const codes = new Map();
  let tokenRequests = 0;
  let keyRequests = 0;

  const sign = (claims, { alg = 'RS256', key = privateKey, keyId = kid } = {}) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg, kid: keyId, typ: 'JWT' });
    const body = enc(claims);
    const signature = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${signature}`;
  };

  const fetchImpl = async (url, init = {}) => {
    if (url === GOOGLE.jwks) {
      keyRequests++;
      const jwk = publicKey.export({ format: 'jwk' });
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
      });
    }
    if (url === GOOGLE.token) {
      tokenRequests++;
      const form = new URLSearchParams(init.body);
      const issued = codes.get(form.get('code'));
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      const ok = issued && !issued.used && form.get('client_id') === CLIENT.clientId && form.get('client_secret') === CLIENT.clientSecret &&
        form.get('redirect_uri') === CLIENT.redirectUri && form.get('grant_type') === 'authorization_code' && challenge === issued.challenge;
      if (!ok) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      issued.used = true;
      return new Response(JSON.stringify({ id_token: issued.idToken(issued), access_token: 'x', token_type: 'Bearer' }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  /** What Google would do after the person picks an account: hand back a code. */
  const approve = (startLocation, claims, { tamper = null } = {}) => {
    const params = new URL(startLocation).searchParams;
    const code = crypto.randomBytes(8).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    codes.set(code, {
      challenge: params.get('code_challenge'),
      idToken: () => {
        const full = { iss: 'https://accounts.google.com', aud: CLIENT.clientId, azp: CLIENT.clientId, iat: now, exp: now + 3600, nonce: params.get('nonce'), email_verified: true, ...claims };
        return tamper ? tamper(full, sign) : sign(full);
      }
    });
    return { code, state: params.get('state'), params };
  };

  return { fetchImpl, approve, sign, stats: () => ({ tokenRequests, keyRequests }) };
}

async function setup() {
  resetGoogleKeyCache();
  const google = fakeGoogle();
  const app = await startApp({ google: CLIENT, googleFetch: google.fetchImpl });
  /** Runs the browser's side of a sign-in. `cookie` is an existing session, if any. */
  const signIn = async (claims, { cookie = null, query = '', tamper = null, dropStateCookie = false, reuse = null } = {}) => {
    const client = app.client(cookie);
    const start = await client.get(`/api/auth/google/start${query}`);
    if (start.status !== 302) return { start };
    const location = start.headers.get('location');
    const stateCookie = start.headers.get('set-cookie')?.split(';')[0];
    const { code, state, params } = google.approve(location, claims, { tamper });
    const cookies = [cookie, dropStateCookie ? null : stateCookie].filter(Boolean).join('; ');
    const callback = await app.client(cookies || null).get(`/api/auth/google/callback?code=${reuse?.code || code}&state=${reuse?.state || state}&iss=${encodeURIComponent('https://accounts.google.com')}`);
    const session = (callback.headers.get('set-cookie') || '').match(/hl_session=[^;]+/)?.[0];
    return { start, location, params, callback, to: callback.headers.get('location'), session, code, state, stateCookie };
  };
  return { app, google, signIn };
}

test('Google sign-in: the request carries state, nonce and PKCE, and a new Gmail address gets an account', async () => {
  const { app, google, signIn } = await setup();
  try {
    const r = await signIn({ sub: 'g-100', email: 'Nia.New@gmail.com', name: 'Nia New' }, { query: '?return=/gifts' });
    const p = r.params;
    assert.equal(new URL(r.location).origin + new URL(r.location).pathname, GOOGLE.authorization);
    assert.deepEqual([p.get('client_id'), p.get('redirect_uri'), p.get('response_type'), p.get('scope'), p.get('code_challenge_method')],
      [CLIENT.clientId, CLIENT.redirectUri, 'code', 'openid email profile', 'S256']);
    assert.ok(p.get('state').length >= 32 && p.get('nonce').length >= 32 && p.get('code_challenge').length === 43);
    assert.match(r.stateCookie, /^hl_oauth=/);
    assert.match(r.start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);

    assert.equal(r.callback.status, 302);
    assert.equal(r.to, '/gifts');
    assert.ok(r.session, 'a session was created');
    const me = (await app.client(r.session).get('/api/session')).json.current_user;
    assert.deepEqual([me.name, me.email, me.google_connected], ['Nia New', 'nia.new@gmail.com', true]);
    assert.equal((await app.client(r.session).get('/api/lists')).json.lists.length, 1, 'a first list, as with email sign-up');
    assert.deepEqual(google.stats(), { tokenRequests: 1, keyRequests: 1 });

    // Next time Google is the key, even if the address on the Google account changed.
    const again = await signIn({ sub: 'g-100', email: 'nia.renamed@gmail.com', name: 'Nia' });
    assert.equal((await app.client(again.session).get('/api/session')).json.current_user.id, me.id);
    assert.equal(google.stats().keyRequests, 1, 'published keys are cached');
  } finally { await app.close(); }
});

test('Google sign-in: links to an existing account only where Google is the authority for the address', async () => {
  const { app, signIn } = await setup();
  try {
    // A Google Workspace account for the domain: Google is the authority, so it is Justin.
    const workspace = await signIn({ sub: 'g-justin', email: 'justin@smith.example', hd: 'smith.example', name: 'J' });
    assert.equal((await app.client(workspace.session).get('/api/session')).json.current_user.id, 'usr_justin');

    // A Google account opened with someone's non-Google address: no automatic link, no new account.
    const outside = await signIn({ sub: 'g-maya', email: 'maya@smith.example', name: 'Not Maya' });
    assert.deepEqual([outside.to, outside.session], ['/welcome?signin_error=use_code', undefined]);
    const unverified = await signIn({ sub: 'g-x', email: 'someone@gmail.com', email_verified: false });
    assert.equal(unverified.to, '/welcome?signin_error=use_code');
    const wrongHd = await signIn({ sub: 'g-y', email: 'elena@smith.example', hd: 'other.example' });
    assert.equal(wrongHd.to, '/welcome?signin_error=use_code');
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE google_sub IN ('g-maya', 'g-x', 'g-y')").get().n, 0);

    // Maya signs in with her email code, then connects that Google account herself.
    const maya = await app.as('usr_maya');
    const mayaCookie = (await app.guest.post('/api/auth/demo-login', { user_id: 'usr_maya' })).headers.get('set-cookie').split(';')[0];
    const linked = await signIn({ sub: 'g-maya', email: 'maya@smith.example' }, { cookie: mayaCookie, query: '?link=1' });
    assert.equal(linked.to, '/?google=connected');
    assert.equal((await maya.get('/api/session')).json.current_user.google_connected, true);
    const viaGoogle = await signIn({ sub: 'g-maya', email: 'maya@smith.example' });
    assert.equal((await app.client(viaGoogle.session).get('/api/session')).json.current_user.id, 'usr_maya');

    // One Google account, one Hushlist account.
    const elenaCookie = (await app.guest.post('/api/auth/demo-login', { user_id: 'usr_elena' })).headers.get('set-cookie').split(';')[0];
    const taken = await signIn({ sub: 'g-maya', email: 'maya@smith.example' }, { cookie: elenaCookie, query: '?link=1' });
    assert.equal(taken.to, '/welcome?signin_error=linked_elsewhere');
    const otherGoogle = await signIn({ sub: 'g-justin-2', email: 'justin@smith.example', hd: 'smith.example' });
    assert.equal(otherGoogle.to, '/welcome?signin_error=linked_elsewhere', 'an account already tied to one Google account is not taken over by another');

    // Disconnecting works, and a link request needs a session.
    assert.equal((await maya.del('/api/auth/google')).json.current_user.google_connected, false);
    const noSession = await app.guest.get('/api/auth/google/start?link=1');
    assert.equal(noSession.headers.get('location'), '/welcome?signin_error=signed_out');

    // A closed account's Google link goes with it.
    const nia = await signIn({ sub: 'g-200', email: 'gone@gmail.com', name: 'Gone' });
    await app.client(nia.session).del('/api/account', { confirm: true });
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE google_sub = 'g-200'").get().n, 0);
  } finally { await app.close(); }
});

test('Google sign-in: forged, replayed, mismatched or stolen responses are refused', async () => {
  const { app, google, signIn } = await setup();
  const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const claims = { sub: 'g-300', email: 'victim@gmail.com', name: 'Victim' };
  try {
    const cases = {
      'signed with another key': (c, sign) => sign(c, { key: otherKey }),
      'unsigned (alg none)': (c, sign) => sign(c, { alg: 'none' }),
      'unknown key id': (c, sign) => sign(c, { keyId: 'nope' }),
      'another audience': (c, sign) => sign({ ...c, aud: 'someone-else' }),
      'another issuer': (c, sign) => sign({ ...c, iss: 'https://evil.example' }),
      'expired': (c, sign) => sign({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }),
      'issued in the future': (c, sign) => sign({ ...c, iat: Math.floor(Date.now() / 1000) + 3600 }),
      'replayed nonce': (c, sign) => sign({ ...c, nonce: 'from-another-sign-in' }),
      'payload edited after signing': (c, sign) => {
        const [h, , s] = sign(c).split('.');
        return `${h}.${Buffer.from(JSON.stringify({ ...c, email: 'admin@gmail.com' })).toString('base64url')}.${s}`;
      },
      'not a token': () => 'garbage'
    };
    for (const [label, tamper] of Object.entries(cases)) {
      const r = await signIn(claims, { tamper });
      assert.equal(r.to, '/welcome?signin_error=invalid', label);
      assert.equal(r.session, undefined, label);
    }

    // The attempt must finish in the browser that started it (login CSRF).
    const elsewhere = await signIn(claims, { dropStateCookie: true });
    assert.equal(elsewhere.to, '/welcome?signin_error=expired');
    // The attack itself: an attacker starts a sign-in into their own Google
    // account and plants the resulting callback link on a victim whose browser
    // holds a state cookie of its own.
    const attacker = await app.guest.get('/api/auth/google/start');
    const planted = google.approve(attacker.headers.get('location'), { sub: 'g-attacker', email: 'attacker@gmail.com', name: 'A' });
    const victimCookie = (await app.guest.get('/api/auth/google/start')).headers.get('set-cookie').split(';')[0];
    const csrf = await app.client(victimCookie).get(`/api/auth/google/callback?code=${planted.code}&state=${planted.state}`);
    assert.equal(csrf.headers.get('location'), '/welcome?signin_error=expired');
    assert.equal(csrf.headers.get('set-cookie')?.includes('hl_session=') && !/hl_session=;/.test(csrf.headers.get('set-cookie')), false);
    // A state is used once.
    const first = await signIn(claims);
    assert.ok(first.session);
    const replay = await app.client(first.stateCookie).get(`/api/auth/google/callback?code=${first.code}&state=${first.state}`);
    assert.equal(replay.headers.get('location'), '/welcome?signin_error=expired');
    // Cancelling at Google, or a response naming another issuer.
    const cancelled = await app.guest.get('/api/auth/google/callback?error=access_denied&state=x');
    assert.equal(cancelled.headers.get('location'), '/welcome?signin_error=cancelled');
    const start = await app.guest.get('/api/auth/google/start');
    const { code, state } = google.approve(start.headers.get('location'), claims);
    const wrongIss = await app.client(start.headers.get('set-cookie').split(';')[0]).get(`/api/auth/google/callback?code=${code}&state=${state}&iss=https://evil.example`);
    assert.equal(wrongIss.headers.get('location'), '/welcome?signin_error=invalid');

    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'admin@gmail.com'").get().n, 0);
  } finally { await app.close(); }
});

test('Google sign-in: off unless configured, and only same-site return paths', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.guest.get('/api/auth/google/start')).status, 404);
    assert.equal((await app.guest.get('/api/session')).json.auth.google, false);
  } finally { await app.close(); }
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '/\nx', 42, null]) assert.equal(safeReturnPath(bad), '/', String(bad));
  assert.equal(safeReturnPath('/lists/abc'), '/lists/abc');
  assert.throws(() => loadConfig({ HUSHLIST_DEMO: '0', HUSHLIST_GOOGLE_CLIENT_ID: 'x', HUSHLIST_GOOGLE_CLIENT_SECRET: 'y' }), /HUSHLIST_PUBLIC_URL/);
  assert.throws(() => loadConfig({ HUSHLIST_GOOGLE_CLIENT_ID: 'x' }), /both/);
  assert.throws(() => loadConfig({ HUSHLIST_DEMO: '0', HUSHLIST_PUBLIC_URL: 'http://gifts.example.com' }), /https/);
  const ok = loadConfig({ HUSHLIST_DEMO: '0', HUSHLIST_PUBLIC_URL: 'https://gifts.example.com', HUSHLIST_GOOGLE_CLIENT_ID: 'x', HUSHLIST_GOOGLE_CLIENT_SECRET: 'y' });
  assert.equal(ok.google.redirectUri, 'https://gifts.example.com/api/auth/google/callback');
});
