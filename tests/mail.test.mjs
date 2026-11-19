import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSmtpTransport, buildMessage, encodeHeader, SmtpError } from '../src/services/smtp.mjs';
import { sendNotification, dispatchOutbox, setMailTransport } from '../src/services/notifications.mjs';
import { loadConfig } from '../src/config.mjs';
import { testDb } from './helpers.mjs';

/** A self-signed certificate for "localhost", made with openssl if it is installed. */
function testCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hushlist-smtp-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
      '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A small SMTP server that records what it is sent. `startTls` offers
 * STARTTLS with the given certificate; `reply` can override the answer to
 * the end of a message (to simulate temporary or permanent refusal).
 */
async function fakeSmtp({ startTls = null, requireAuth = false, reply = () => '250 2.0.0 queued' } = {}) {
  const received = [];
  const server = net.createServer((raw) => {
    let socket = raw;
    let secured = false;
    let buffer = '';
    let inData = false;
    let data = '';
    let current = { auth: null, from: null, to: [], tls: false };
    const write = (line) => socket.write(`${line}\r\n`);
    const onLine = (line) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          received.push({ ...current, data, tls: secured });
          write(reply(received.length));
          data = '';
          current = { auth: current.auth, from: null, to: [], tls: secured };
        } else {
          data += `${line}\r\n`;
        }
        return;
      }
      const verb = line.split(' ')[0].toUpperCase();
      if (verb === 'EHLO') {
        socket.write('250-fake.example\r\n');
        if (startTls && !secured) socket.write('250-STARTTLS\r\n');
        socket.write('250 AUTH PLAIN LOGIN\r\n');
      } else if (verb === 'STARTTLS' && startTls) {
        write('220 2.0.0 go ahead');
        socket.removeAllListeners('data');
        const upgraded = new tls.TLSSocket(socket, { isServer: true, ...startTls });
        socket = upgraded;
        secured = true;
        buffer = '';
        upgraded.on('data', onData);
      } else if (verb === 'AUTH') {
        current.auth = Buffer.from(line.split(' ')[2] || '', 'base64').toString();
        write('235 2.7.0 ok');
      } else if (verb === 'MAIL') {
        if (requireAuth && !current.auth) { write('530 5.7.0 authentication required'); return; }
        current.from = line; write('250 ok');
      } else if (verb === 'RCPT') { current.to.push(line); write('250 ok'); }
      else if (verb === 'DATA') { inData = true; write('354 go on'); }
      else if (verb === 'QUIT') { write('221 bye'); socket.end(); }
      else write('502 unknown');
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        onLine(line);
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    write('220 fake.example ESMTP');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, received, close: () => new Promise(r => server.close(r)) };
}

const decodeBody = (data) => Buffer.from(data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

test('SMTP: the message is well formed, encodes any text, and cannot be given extra headers', () => {
  const msg = buildMessage({ from: 'Hushlist <no-reply@gifts.example>', to: 'sam@example.com', subject: 'Für Oma ✓', body: '.line one\nline two' });
  assert.equal(msg.envelopeFrom, 'no-reply@gifts.example');
  const [head] = msg.data.split('\r\n\r\n');
  assert.match(head, /^From: Hushlist <no-reply@gifts\.example>$/m);
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(head, /^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m);
  assert.match(head, /^Content-Transfer-Encoding: base64$/m);
  assert.equal(decodeBody(msg.data), '.line one\r\nline two');
  // A subject with line breaks cannot start new header lines.
  assert.ok(!/\r\nBcc:/i.test(buildMessage({ from: 'a@b.cd', to: 'x@y.zz', subject: 'Hi\r\nBcc: evil@example.com', body: 'b' }).data.split('\r\n\r\n')[0]));
  assert.equal(encodeHeader('plain'), 'plain');
  for (const bad of ['x@y.zz\r\nRCPT TO:<evil@example.com>', 'a b@c.de', '<x@y.zz>', 'no-at-sign']) {
    assert.throws(() => buildMessage({ from: 'a@b.cd', to: bad, subject: 's', body: 'b' }), SmtpError, JSON.stringify(bad));
  }
  assert.throws(() => createSmtpTransport({ host: 'smtp.example.com', from: 'not an address' }), /MAIL_FROM/);
});

test('SMTP: delivers over STARTTLS with sign-in, and refuses to send credentials or mail unencrypted', async (t) => {
  const certificate = testCertificate();
  if (!certificate) { t.skip('openssl is not installed'); return; }
  const smtp = await fakeSmtp({ startTls: certificate, requireAuth: true });
  try {
    const send = createSmtpTransport({
      host: 'localhost', port: smtp.port, secure: false, user: 'mailer', pass: 'p@ss word', from: 'Hushlist <no-reply@gifts.example>',
      tlsOptions: { ca: certificate.cert }
    });
    await send({ to: 'sam@example.com', subject: 'Your code', body: 'Enter 12345678.\n.\nThat dot line was stuffed.', eventType: 'sign_in_code' });
    assert.equal(smtp.received.length, 1);
    const got = smtp.received[0];
    assert.equal(got.tls, true, 'the message went over TLS');
    assert.equal(got.auth, '\0mailer\0p@ss word');
    assert.deepEqual(got.to, ['RCPT TO:<sam@example.com>']);
    assert.equal(decodeBody(got.data), 'Enter 12345678.\r\n.\r\nThat dot line was stuffed.');
    assert.match(got.data, /^Auto-Submitted: auto-generated$/m);

    // The certificate is checked: a server the client cannot verify is refused.
    const unverified = createSmtpTransport({ host: 'localhost', port: smtp.port, from: 'a@gifts.example', user: 'u', pass: 'p' });
    await assert.rejects(unverified({ to: 'sam@example.com', subject: 's', body: 'b' }), /certificate|self-signed|SMTP connection/i);
    assert.equal(smtp.received.length, 1);
  } finally { await smtp.close(); }

  const plain = await fakeSmtp();
  try {
    const send = createSmtpTransport({ host: '127.0.0.1', port: plain.port, secure: false, user: 'u', pass: 'secret', from: 'a@gifts.example' });
    await assert.rejects(send({ to: 'sam@example.com', subject: 's', body: 'b' }), /does not offer STARTTLS/);
    assert.equal(plain.received.length, 0, 'nothing is sent without encryption');
    // A local mail catcher can be used deliberately.
    const local = createSmtpTransport({ host: '127.0.0.1', port: plain.port, secure: false, from: 'a@gifts.example', allowInsecure: true });
    await local({ to: 'sam@example.com', subject: 's', body: 'b' });
    assert.equal(plain.received.length, 1);
  } finally { await plain.close(); }
});

test('mail delivery: temporary failures are retried with growing gaps; permanent ones are given up on', async () => {
  const db = testDb();
  let calls = 0;
  setMailTransport(async () => {
    calls++;
    if (calls <= 2) throw new SmtpError('421 try later', { code: 421 });
    if (calls === 3) return;
    throw new SmtpError('550 no such user', { code: 550, permanent: true });
  });
  try {
    const first = sendNotification(db, { recipientUserId: 'usr_elena', eventType: 'new_follower', subject: 'a', body: 'b' });
    const row = () => db.prepare('SELECT * FROM notifications_outbox WHERE id = ?').get(first.id);
    const now = Date.now();
    assert.equal(await dispatchOutbox(db, new Date(now)), 0);
    assert.equal(row().attempts, 1);
    assert.equal(await dispatchOutbox(db, new Date(now + 30_000)), 0, 'not retried before the gap has passed');
    assert.equal(calls, 1);
    assert.equal(await dispatchOutbox(db, new Date(now + 61_000)), 0);
    assert.equal(row().attempts, 2);
    assert.equal(await dispatchOutbox(db, new Date(now + 61_000 + 5 * 60_000 + 1000)), 1);
    assert.ok(row().sent_at);

    const second = sendNotification(db, { recipientUserId: 'usr_arthur', eventType: 'new_follower', subject: 'a', body: 'b' });
    assert.equal(await dispatchOutbox(db), 0);
    const failed = db.prepare('SELECT * FROM notifications_outbox WHERE id = ?').get(second.id);
    assert.ok(failed.failed_at, 'a permanent refusal is not retried');
    assert.match(failed.last_error, /550/);
    assert.equal(await dispatchOutbox(db, new Date(Date.now() + 86400_000)), 0);
    assert.equal(calls, 4);

    // Two runs at once send a message once.
    let sent = 0;
    setMailTransport(async () => { sent++; await new Promise(r => setTimeout(r, 20)); });
    sendNotification(db, { recipientUserId: 'usr_maya', eventType: 'new_follower', subject: 'once', body: 'b' });
    await Promise.all([dispatchOutbox(db), dispatchOutbox(db), dispatchOutbox(db)]);
    assert.equal(sent, 1);
  } finally { setMailTransport(null); }
});

test('mail settings: SMTP needs a host and sender; unencrypted SMTP only to this machine', () => {
  assert.equal(loadConfig({ HUSHLIST_DEMO: '0', HUSHLIST_SMTP_HOST: 'smtp.example.com', HUSHLIST_MAIL_FROM: 'a@b.cd' }).mailTransport, 'smtp');
  assert.equal(loadConfig({ HUSHLIST_DEMO: '0', HUSHLIST_SMTP_HOST: 'smtp.example.com', HUSHLIST_SMTP_PORT: '465', HUSHLIST_MAIL_FROM: 'a@b.cd' }).smtp.secure, true);
  assert.throws(() => loadConfig({ HUSHLIST_MAIL_TRANSPORT: 'smtp' }), /HUSHLIST_SMTP_HOST/);
  assert.throws(() => loadConfig({ HUSHLIST_SMTP_HOST: 'smtp.example.com' }), /HUSHLIST_MAIL_FROM/);
  assert.throws(() => loadConfig({ HUSHLIST_SMTP_HOST: 'smtp.example.com', HUSHLIST_MAIL_FROM: 'a@b.cd', HUSHLIST_SMTP_ALLOW_INSECURE: '1' }), /only accepted/);
  assert.throws(() => loadConfig({ HUSHLIST_MAIL_TRANSPORT: 'carrier-pigeon' }), /smtp, console or none/);
});
