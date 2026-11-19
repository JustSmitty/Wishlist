import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

test('identity comes only from a server-issued session', async () => {
  const app = await startApp();
  try {
    // The old impersonation channels do nothing.
    const spoofed = app.guest.withHeaders({ 'X-User-Id': 'usr_justin' });
    assert.equal((await spoofed.get('/api/session')).json.current_user, null);
    assert.equal((await app.guest.get('/api/export?asUser=usr_justin')).status, 401);
    assert.equal((await spoofed.get('/api/admin')).status, 403);

    const justin = await app.as('usr_justin');
    const session = (await justin.get('/api/session')).json;
    assert.equal(session.current_user.id, 'usr_justin');
    assert.equal(session.current_user.auth_credential_id, undefined, 'internal columns are never serialised');
    assert.equal(session.dependents.length, 1);

    await justin.post('/api/auth/logout');
    assert.equal((await justin.get('/api/session')).json.current_user, null, 'logout invalidates the token server-side');
  } finally { await app.close(); }
});

test('email sign-in: an address is entered only by proving access to it', async () => {
  const app = await startApp();
  try {
    // Existing address: no account data is returned without the code.
    const started = await app.guest.post('/api/auth/start', { email: 'MAYA@smith.example' });
    assert.equal(started.status, 200);
    assert.deepEqual(Object.keys(started.json).sort(), ['challenge_id', 'demo_code', 'expires_in_minutes']);

    const wrong = await app.guest.post('/api/auth/verify', { challenge_id: started.json.challenge_id, code: '000000', name: 'Mallory' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.get('set-cookie'), null);

    const right = await app.guest.post('/api/auth/verify', { challenge_id: started.json.challenge_id, code: started.json.demo_code });
    assert.equal(right.json.current_user.id, 'usr_maya');
    assert.match(right.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);

    // A used challenge cannot be replayed.
    assert.equal((await app.guest.post('/api/auth/verify', { challenge_id: started.json.challenge_id, code: started.json.demo_code })).status, 400);

    // New address: needs a name, then gets an account and a first list.
    const fresh = await app.guest.post('/api/auth/start', { email: 'new.person@example.com' });
    const noName = await app.guest.post('/api/auth/verify', { challenge_id: fresh.json.challenge_id, code: fresh.json.demo_code });
    assert.deepEqual(noName.json, { needs_profile: true });
    const created = await app.guest.post('/api/auth/verify', { challenge_id: fresh.json.challenge_id, code: fresh.json.demo_code, name: 'New Person', birthday_month: 1e17 });
    assert.equal(created.json.created, true);
    assert.equal(created.json.current_user.birthday_month, null, 'out-of-range numbers are dropped, not stored');
    assert.equal(created.json.current_user.is_admin, false);

    // Five wrong codes burn the challenge.
    const brute = await app.guest.post('/api/auth/start', { email: 'justin@smith.example' });
    for (let i = 0; i < 5; i++) await app.guest.post('/api/auth/verify', { challenge_id: brute.json.challenge_id, code: '111111' });
    const locked = await app.guest.post('/api/auth/verify', { challenge_id: brute.json.challenge_id, code: brute.json.demo_code });
    assert.equal(locked.status, 429);
  } finally { await app.close(); }
});

test('outside demo mode nothing is seeded, nobody is listed and codes are not returned', async () => {
  const app = await startApp({ demoMode: false });
  try {
    const session = (await app.guest.get('/api/session')).json;
    assert.deepEqual(session.demo, { enabled: false, personas: [] });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'no sample accounts');
    assert.ok(app.db.prepare('SELECT COUNT(*) AS n FROM retailer_adapters').get().n >= 30, 'adapter config is still installed');

    assert.equal((await app.guest.post('/api/auth/demo-login', { user_id: 'usr_justin' })).status, 404);
    const started = await app.guest.post('/api/auth/start', { email: 'someone@example.com' });
    assert.equal(started.json.demo_code, undefined);
  } finally { await app.close(); }
});

test('extension tokens authenticate by bearer header and can be revoked', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const token = (await justin.post('/api/auth/tokens')).json.token;
    assert.match(token, /^hlx_/);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(token).n, 0, 'the raw token is not stored');

    const ext = app.guest.withHeaders({ Authorization: `Bearer ${token}` });
    assert.equal((await ext.get('/api/lists')).json.lists.length, 2);
    assert.equal((await ext.post('/api/auth/tokens')).status, 403, 'a token cannot mint more tokens');

    await justin.del('/api/auth/tokens');
    assert.equal((await ext.get('/api/lists')).json.lists.length, 0);
  } finally { await app.close(); }
});
