import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startApp } from './helpers.mjs';
import { cleanText, extractMetadataFromHtml, checkUrlSafety, canonicalizeUrl, parsePriceNumber } from '../src/services/capture.mjs';

function raw(base, request) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname, () => socket.write(request));
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    setTimeout(() => socket.destroy(), 800);
  });
}

test('malformed requests get a 400 and the server stays up', async () => {
  const app = await startApp();
  try {
    // Each of the first four used to end the process with an unhandled rejection.
    for (const request of [
      'GET // HTTP/1.1\r\nHost: localhost\r\n\r\n',
      'GET http:// HTTP/1.1\r\nHost: localhost\r\n\r\n',
      'GET /api/session HTTP/1.1\r\nHost: [\r\n\r\n',
      'GET /api/session HTTP/1.1\r\nHost: a b\r\n\r\n',
      'GET /%E0%A4%A HTTP/1.1\r\nHost: localhost\r\n\r\n',
      'GET /api/lists/%E0%A4%A HTTP/1.1\r\nHost: localhost\r\n\r\n'
    ]) {
      const response = await raw(app.base, request);
      assert.match(response, /^HTTP\/1\.1 4\d\d/, request.split('\r\n').slice(0, 2).join(' | '));
    }
    assert.equal((await app.guest.get('/api/session')).status, 200, 'still serving');
  } finally { await app.close(); }
});

test('bodies: JSON objects only, declared as JSON, capped at 1 MB', async () => {
  const app = await startApp();
  try {
    const post = (body, type = 'application/json') =>
      fetch(app.base + '/api/claims', { method: 'POST', headers: { 'Content-Type': type }, body })
        .then(r => r.status).catch(() => 'reset');

    for (const body of ['null', '[]', '"x"', '42', '{bad']) assert.equal(await post(body), 400, body);
    assert.equal(await post('{"item_id":"itm_j1"}', 'text/plain'), 415, 'a cross-site form cannot post JSON');

    const big = await post(JSON.stringify({ item_id: 'itm_j1', order_note: 'a'.repeat(1_200_000) }));
    assert.ok(big === 413 || big === 'reset', `oversized body was ${big}`);
    assert.equal((await app.guest.get('/api/session')).status, 200);

    // Rate limiting covers unauthenticated writes.
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await app.guest.post('/api/reports', { target_type: 'item', target_id: 'x' })).status);
    assert.ok(statuses.includes(429), 'reports are rate limited');
  } finally { await app.close(); }
});

test('security headers, CORS and CSRF', async () => {
  const app = await startApp();
  try {
    const home = await app.guest.get('/');
    const csp = home.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'(;|$)/, 'no unsafe-inline');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(home.headers.get('access-control-allow-origin'), null);

    const api = await app.guest.get('/api/session', { Origin: 'https://evil.example' });
    assert.equal(api.headers.get('access-control-allow-origin'), null, 'web origins get no CORS grant');
    assert.equal(api.headers.get('cache-control'), 'no-store');
    const ext = await app.guest.get('/api/session', { Origin: 'chrome-extension://abcdefghijklmnop' });
    assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
    assert.equal(ext.headers.get('access-control-allow-credentials'), null);

    const justin = await app.as('usr_justin');
    const forged = await justin.post('/api/lists', { name: 'planted' }, { Origin: 'https://evil.example' });
    assert.equal(forged.status, 403);
    const sameOrigin = await justin.post('/api/lists', { name: 'mine' }, { Origin: app.base });
    assert.equal(sameOrigin.status, 201);
  } finally { await app.close(); }
});

test('static files: app routes get the shell, missing assets are 404, no traversal', async () => {
  const app = await startApp();
  try {
    assert.match((await app.guest.get('/gifting')).text, /<!doctype html>/i);
    assert.equal((await app.guest.get('/missing.js')).status, 404);
    for (const p of ['/../server.mjs', '/%2e%2e/server.mjs', '/..%2fserver.mjs', '/js/../../server.mjs']) {
      const res = await app.guest.get(p);
      assert.ok(!res.text.includes('createApp'), p);
    }
  } finally { await app.close(); }
});

test('hostile input is processed in linear time', () => {
  const timed = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  assert.ok(timed(() => cleanText('<'.repeat(400_000), 80)) < 250);
  assert.ok(timed(() => cleanText('<script'.repeat(50_000), 2000)) < 250);
  assert.ok(timed(() => extractMetadataFromHtml(null, 'https://shop.example.com/p/thing', "<meta property='og:title' ".repeat(20_000))) < 500);
  assert.ok(timed(() => extractMetadataFromHtml(null, 'https://shop.example.com/p/thing', '<script type="application/ld+json">'.repeat(14_000))) < 500);
  assert.ok(timed(() => extractMetadataFromHtml(null, 'https://shop.example.com/p/thing', '<h1>'.repeat(120_000))) < 500);
});

test('cleanText returns plain text with no markup, however it was encoded', () => {
  assert.equal(cleanText('&lt;img src=x onerror=alert(1)&gt;Hello'), 'Hello');
  assert.equal(cleanText('&amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt;'), 'bold');
  assert.equal(cleanText('<scr<script>ipt>alert(1)</script>'), 'ipt>alert(1)');
  assert.equal(cleanText('5 < 6 and 7 > 3'), '5 < 6 and 7 > 3', 'ordinary comparisons survive');
  assert.equal(cleanText('  a\u0000b\n\tc  '), 'a b c');
  assert.equal(cleanText({ toString: () => 'x' }), '', 'objects are not coerced');
  assert.equal(cleanText('x'.repeat(1000), 10).length, 10);
});

test('link safety: only public http(s) destinations', () => {
  for (const url of [
    'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://localhost:3456/', 'http://localhost./',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[fd12:3456::1]/', 'http://[fe90::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/',
    'http://198.18.0.1/', 'http://192.168.1.1/', 'http://intranet/', 'http://printer.local./',
    'https://user:pass@example.com/', 'https://www.malware-shop.test./login'
  ]) assert.equal(checkUrlSafety(url).safe, false, url);
  assert.equal(checkUrlSafety('https://www.rei.com/product/1').safe, true);
  assert.throws(() => canonicalizeUrl('javascript:alert(document.cookie)'), /Unsafe URL/);
  assert.equal(canonicalizeUrl('https://www.rei.com/p/1?ref=keep&utm_source=x&fbclid=y#frag'), 'https://www.rei.com/p/1?ref=keep');
  assert.equal(canonicalizeUrl('https://www.amazon.co.uk/gp/product/b08n5wrwnw?ref=sr_1&tag=mine'), 'https://www.amazon.co.uk/dp/B08N5WRWNW?tag=mine');
});

test('prices are parsed as one number, in either decimal convention', () => {
  const cases = { '$399.95': 399.95, '1,299.00': 1299, '1.299,00': 1299, '1 299,00 €': 1299, '74,95': 74.95,
    '$12.99 - $15.99': 12.99, '20% off was $50 now $40': 50, 'abc': null, '': null };
  for (const [input, expected] of Object.entries(cases)) assert.equal(parsePriceNumber(input), expected, input);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    await justin.post('/api/items', { list_id: 'lst_justin_holiday', title: '=HYPERLINK("http://evil.example","x")', store: '@SUM(1+1)' });
    const csv = (await justin.get('/api/export?format=csv')).text;
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"",""x"")"`));
    assert.ok(csv.includes(`'@SUM(1+1)`));
    assert.ok(!/(^|,)[=@]/m.test(csv), 'no cell starts with a formula character');
  } finally { await app.close(); }
});

test('demo mode only answers when addressed as this machine (DNS rebinding)', async () => {
  const app = await startApp();
  try {
    const rebound = await raw(app.base, 'POST /api/auth/demo-login HTTP/1.1\r\nHost: attacker.example\r\nContent-Type: application/json\r\nContent-Length: 24\r\n\r\n{"user_id":"usr_justin"}');
    assert.match(rebound, /^HTTP\/1\.1 421/);
    assert.ok(!/set-cookie/i.test(rebound));
    const page = await raw(app.base, 'GET / HTTP/1.1\r\nHost: 192.168.1.20:3456\r\n\r\n');
    assert.match(page, /^HTTP\/1\.1 421/);
  } finally { await app.close(); }

  // Outside demo mode any host name is served; sessions there need a real sign-in.
  const real = await startApp({ demoMode: false });
  try {
    assert.match(await raw(real.base, 'GET /api/session HTTP/1.1\r\nHost: hushlist.example\r\n\r\n'), /^HTTP\/1\.1 200/);
  } finally { await real.close(); }
});
