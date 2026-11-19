/**
 * Runtime configuration.
 *
 * Demo mode is the default for local development. It seeds the sample family,
 * allows one-click sign-in as any sample person and shows sign-in / guest
 * verification codes in the app instead of emailing them. Because that makes
 * every account reachable without a secret, demo mode binds to loopback only.
 *
 * Set HUSHLIST_DEMO=0 (or NODE_ENV=production) to turn all of that off.
 */
export function loadConfig(env = process.env) {
  const demoMode = env.HUSHLIST_DEMO !== undefined
    ? env.HUSHLIST_DEMO !== '0'
    : env.NODE_ENV !== 'production';

  return {
    demoMode,
    // Explicit opt-in to serving demo mode beyond this machine. Not recommended:
    // in demo mode anyone who can reach the server can sign in as anyone.
    demoAllowRemote: env.HUSHLIST_DEMO_ALLOW_REMOTE === '1',
    port: Number(env.PORT) || 3456,
    host: env.HOST || (demoMode ? '127.0.0.1' : '0.0.0.0'),
    secureCookies: env.HUSHLIST_SECURE_COOKIES === '1',
    trustProxy: env.HUSHLIST_TRUST_PROXY === '1',
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
