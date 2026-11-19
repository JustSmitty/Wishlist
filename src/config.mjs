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

export function loadConfig(env = process.env) {
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const demoRequested = parseSwitch('HUSHLIST_DEMO', env.HUSHLIST_DEMO);
  if (production && demoRequested === true) {
    throw new Error('HUSHLIST_DEMO cannot be on when NODE_ENV=production. Demo mode lets anyone sign in as anyone.');
  }
  const demoMode = demoRequested ?? !production;

  return {
    demoMode,
    // Explicit opt-in to serving demo mode beyond this machine. Not recommended:
    // in demo mode anyone who can reach the server can sign in as anyone.
    demoAllowRemote: parseSwitch('HUSHLIST_DEMO_ALLOW_REMOTE', env.HUSHLIST_DEMO_ALLOW_REMOTE) === true,
    port: Number(env.PORT) || 3456,
    host: env.HOST || (demoMode ? '127.0.0.1' : '0.0.0.0'),
    secureCookies: parseSwitch('HUSHLIST_SECURE_COOKIES', env.HUSHLIST_SECURE_COOKIES) === true,
    trustProxy: parseSwitch('HUSHLIST_TRUST_PROXY', env.HUSHLIST_TRUST_PROXY) === true,
    adminEmails: new Set(
      String(env.HUSHLIST_ADMIN_EMAILS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    ),
    // Until a real email provider is wired in, the only delivery outside demo
    // mode is the server log. Set to "none" to keep codes out of the log.
    mailTransport: env.HUSHLIST_MAIL_TRANSPORT || (demoMode ? 'none' : 'console')
  };
}
