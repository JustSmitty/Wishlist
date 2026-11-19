import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { html, raw, esc, safeUrl, money, countdown, initials } from '../src/public/js/dom.js';
import { qrMatrix, qrSvg } from '../src/public/js/qr.js';
import { giftArt } from '../src/public/js/art.js';

test('html`` escapes every interpolated value unless it is explicitly trusted', () => {
  const hostile = '"><img src=x onerror=alert(1)>&\'`';
  const out = String(html`<p title="${hostile}">${hostile}</p>`);
  assert.ok(!out.includes('<img'));
  assert.ok(!out.includes('"><'));
  assert.equal(out, '<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;&#96;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;&#96;</p>');

  // Nested templates and arrays compose without double-escaping; plain strings in arrays are still escaped.
  const rows = ['<b>a</b>', 'b'].map(v => html`<li>${v}</li>`);
  assert.equal(String(html`<ul>${rows}${['<i>']}</ul>`), '<ul><li>&lt;b&gt;a&lt;/b&gt;</li><li>b</li>&lt;i&gt;</ul>');
  assert.equal(String(html`${null}${undefined}${false}${0}`), '0');
  assert.equal(String(html`${raw('<hr>')}`), '<hr>');
  assert.equal(esc({ toString: () => '<x>' }), '&lt;x&gt;');
});

test('safeUrl allows http(s) and same-site paths only', () => {
  assert.equal(safeUrl('https://www.rei.com/p/1'), 'https://www.rei.com/p/1');
  assert.equal(safeUrl('/l/abc'), '/l/abc');
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example/x', 'not a url', null, 42]) {
    assert.equal(safeUrl(bad), '#', String(bad));
  }
});

test('formatting helpers', () => {
  assert.equal(money(null), '');
  assert.match(money(1234.5), /1,234\.50?/);
  assert.match(money(68), /^\$68$/);
  assert.equal(countdown(0), 'today');
  assert.equal(countdown(1), 'tomorrow');
  assert.equal(countdown(10), 'in 10 days');
  assert.equal(initials('Aunt Elena Vance'), 'AV');
});

test('QR encoder reproduces matrices that were verified with an independent decoder', () => {
  // These two fingerprints were recorded after the exact matrices were decoded
  // back to the input text by jsQR (versions 5 and 8, error correction M).
  const fingerprint = (text) => crypto.createHash('sha256')
    .update(qrMatrix(text).map(row => row.map(v => (v ? 1 : 0)).join('')).join('\n')).digest('hex');
  assert.equal(fingerprint('https://hushlist.example/l/shr_0123456789abcdefghijklmnopqrstuv'), '79f57615eaae90520364593b7d0a091f71f960b384d255849e0c8595f0b64305');
  assert.equal(fingerprint('x'.repeat(150)), '9782fa7f0642d3e6b22295c01fc9e2fe9a0f19d22af2cf7b3964dcb6a932e44e');

  // Structural invariants for every supported size.
  for (const length of [1, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213]) {
    const m = qrMatrix('a'.repeat(length));
    const n = m.length;
    assert.equal((n - 17) % 4, 0);
    assert.ok(m.every(row => row.length === n));
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      assert.ok(m[r][c] && m[r + 6][c + 6] && m[r + 3][c + 3] && !m[r + 1][c + 1], 'finder pattern');
    }
    assert.ok(m[n - 8][8], 'dark module');
  }
  assert.throws(() => qrMatrix('a'.repeat(214)), /too long/);
  assert.match(qrSvg('hello', { label: '"><script>' }), /aria-label="script"/);
});

test('gift artwork is deterministic and contains no script-capable markup', () => {
  const item = { id: 'itm_1', title: '"><script>alert(1)</script>', kind: 'nonsense<script>' };
  const a = String(giftArt(item, 'bought')).replace(/wrap\w+/g, 'ID');
  const b = String(giftArt(item, 'bought')).replace(/wrap\w+/g, 'ID');
  assert.equal(a, b);
  assert.ok(!/script|onerror|href|NaN|undefined/i.test(a));
  assert.notEqual(String(giftArt(item, 'open')).length, a.length);
});
