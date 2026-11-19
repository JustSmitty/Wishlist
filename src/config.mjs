/**
 * Runtime configuration.
 *
 * Demo mode is the default for local development. It seeds the sample family,
 * allows one-click sign-in as any sample person and shows sign-in / guest
 * verification codes in the app instead of emailing them. Because that makes
 * every account reachable without a secret, demo mode binds to loopback only.
 *
 * Set HUSHLIST_DEMO=0 (or NODE_ENV=production) to turn all of that off.
 * NODE_ENV=production always wins: asking for demo mode there is refused.
 */
const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Reads an on/off setting. Unset or empty means "not specified". Anything
 * that is not clearly on or off is an error: a security switch must never be
 * decided by a typo.
 */
function parseSwitch(name, value) {
  if (value === undefined || value === null) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === '') return undefined;
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  throw new Error(`${name} must be 1 or 0 (got "${value}")`);
}

function publicUrl(value, demoMode, port) {
  const raw = String(value || '').trim();
  if (!raw) return demoMode ? `http://localhost:${port}` : null;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`HUSHLIST_PUBLIC_URL is not a URL (got "${raw}")`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('HUSHLIST_PUBLIC_URL must start with https:// (http:// is accepted for localhost only)');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('HUSHLIST_PUBLIC_URL must be just the address, such as https://gifts.example.com');
  }
  return url.origin;
}

export function loadConfig(env = process.env) {
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const demoRequested = parseSwitch('HUSHLIST_DEMO', env.HUSHLIST_DEMO);
  if (production && demoRequested === true) {
    throw new Error('HUSHLIST_DEMO cannot be on when NODE_ENV=production. Demo mode lets anyone sign in as anyone.');
  }
  const demoMode = demoRequested ?? !production;
  const port = Number(env.PORT) || 3456;

  const smtpHost = String(env.HUSHLIST_SMTP_HOST || '').trim();
  const smtpPort = Number(env.HUSHLIST_SMTP_PORT) || 587;
  const smtpAllowInsecure = parseSwitch('HUSHLIST_SMTP_ALLOW_INSECURE', env.HUSHLIST_SMTP_ALLOW_INSECURE) === true;
  if (smtpAllowInsecure && !['localhost', '127.0.0.1', '::1'].includes(smtpHost)) {
    throw new Error('HUSHLIST_SMTP_ALLOW_INSECURE is only accepted for a mail server on this machine (localhost)');
  }
  const transport = String(env.HUSHLIST_MAIL_TRANSPORT || '').trim().toLowerCase()
    || (smtpHost ? 'smtp' : (demoMode ? 'none' : 'console'));
  if (!['smtp', 'console', 'none'].includes(transport)) {
    throw new Error(`HUSHLIST_MAIL_TRANSPORT must be smtp, console or none (got "${env.HUSHLIST_MAIL_TRANSPORT}")`);
  }
  if (transport === 'smtp' && (!smtpHost || !env.HUSHLIST_MAIL_FROM)) {
    throw new Error('SMTP delivery needs HUSHLIST_SMTP_HOST and HUSHLIST_MAIL_FROM');
  }

  const googleClientId = String(env.HUSHLIST_GOOGLE_CLIENT_ID || '').trim();
  const googleClientSecret = String(env.HUSHLIST_GOOGLE_CLIENT_SECRET || '').trim();
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error('Google sign-in needs both HUSHLIST_GOOGLE_CLIENT_ID and HUSHLIST_GOOGLE_CLIENT_SECRET');
  }
  const base = publicUrl(env.HUSHLIST_PUBLIC_URL, demoMode, port);
  if (googleClientId && !base) {
    throw new Error('Google sign-in needs HUSHLIST_PUBLIC_URL (the https:// address people use to reach Hushlist)');
  }

  return {
    demoMode,
    // Explicit opt-in to serving demo mode beyond this machine. Not recommended:
    // in demo mode anyone who can reach the server can sign in as anyone.
    demoAllowRemote: parseSwitch('HUSHLIST_DEMO_ALLOW_REMOTE', env.HUSHLIST_DEMO_ALLOW_REMOTE) === true,
    port,
    publicUrl: base,
    host: env.HOST || (demoMode ? '127.0.0.1' : '0.0.0.0'),
    // Served over HTTPS (the public address says so) means secure cookies,
    // unless explicitly turned off.
    secureCookies: parseSwitch('HUSHLIST_SECURE_COOKIES', env.HUSHLIST_SECURE_COOKIES) ?? Boolean(base && base.startsWith('https://')),
    trustProxy: parseSwitch('HUSHLIST_TRUST_PROXY', env.HUSHLIST_TRUST_PROXY) === true,
    adminEmails: new Set(
      String(env.HUSHLIST_ADMIN_EMAILS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    ),
    // Until a real email provider is wired in, the only delivery outside demo
    // mode is the server log. Set to "none" to keep codes out of the log.
    mailTransport: transport,
    smtp: transport === 'smtp' ? {
      host: smtpHost,
      port: smtpPort,
      secure: parseSwitch('HUSHLIST_SMTP_SECURE', env.HUSHLIST_SMTP_SECURE) ?? smtpPort === 465,
      user: String(env.HUSHLIST_SMTP_USER || ''),
      pass: String(env.HUSHLIST_SMTP_PASS || ''),
      from: String(env.HUSHLIST_MAIL_FROM || ''),
      allowInsecure: smtpAllowInsecure
    } : null,
    google: googleClientId ? {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectUri: `${base}/api/auth/google/callback`
    } : null
  };
}
