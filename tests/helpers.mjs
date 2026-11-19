import { createDatabase } from '../src/db/schema.mjs';
import { seedDatabase } from '../src/db/seed.mjs';
import { createApp } from '../src/server.mjs';

export function testDb() {
  const db = createDatabase(':memory:');
  seedDatabase(db);
  return db;
}

/**
 * Starts the app on an ephemeral port with an in-memory database.
 * `as(userId)` returns a client signed in as that sample person (demo login);
 * `guest` is a client with no session.
 */
export async function startApp(options = {}) {
  const db = options.db || createDatabase(':memory:');
  const { server } = createApp(db, { demoMode: true, mailTransport: 'none', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client(cookie = null, extraHeaders = {}) {
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...extraHeaders,
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text, headers: res.headers };
    };
    return {
      get: (path, headers) => call('GET', path, undefined, headers),
      post: (path, body = {}, headers) => call('POST', path, body, headers),
      patch: (path, body = {}, headers) => call('PATCH', path, body, headers),
      del: (path, body, headers) => call('DELETE', path, body, headers),
      withHeaders: (headers) => client(cookie, { ...extraHeaders, ...headers })
    };
  }

  const guest = client();
  async function as(userId) {
    const res = await guest.post('/api/auth/demo-login', { user_id: userId });
    if (res.status !== 200) throw new Error(`demo login failed for ${userId}: ${res.text}`);
    return client(res.headers.get('set-cookie').split(';')[0]);
  }

  /** Signs up a brand-new person through the real email-code flow. */
  async function signUp(email, name, extra = {}) {
    const started = await guest.post('/api/auth/start', { email });
    const done = await guest.post('/api/auth/verify', { challenge_id: started.json.challenge_id, code: started.json.demo_code, name, ...extra });
    if (done.status !== 200) throw new Error(`sign-up failed: ${done.text}`);
    const c = client(done.headers.get('set-cookie').split(';')[0]);
    c.user = done.json.current_user;
    return c;
  }

  return { db, base, server, guest, as, signUp, client, close: () => new Promise(r => server.close(r)) };
}
