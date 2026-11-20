/**
 * Sign in with Google (OpenID Connect, authorization code flow).
 *
 * Endpoints, the RS256 signing algorithm and S256 PKCE support are as
 * published in Google's discovery document,
 * https://accounts.google.com/.well-known/openid-configuration .
 *
 * Every protection is used, not only the required ones:
 * - state, bound to the browser by a cookie, against login cross-site
 *   request forgery (someone signing you into their account);
 * - PKCE (S256), so an intercepted code is useless;
 * - nonce, so an ID token cannot be replayed into another sign-in;
 * - the ID token's signature is checked against Google's published keys,
 *   and its issuer, audience, expiry and nonce are checked, even though it
 *   arrives straight from Google over TLS.
 *
 * Accounts are keyed on `sub`, as Google's OpenID Connect guide requires
 * ("Don't use the email field as a unique identifier for a user. Always use
 * the sub field."). The email address is used once, to find an existing
 * Hushlist account the first time someone signs in with Google, and only
 * where the address belongs to Google's own systems:
 *   - a Google Workspace address: the guide says to use the `hd` claim, not
 *     the email's domain, to identify Workspace users, so `hd` must be
 *     present and equal to the address's domain;
 *   - an @gmail.com address. Google's guide does not state this case. It is
 *     this code's judgement that a Gmail address shown on a Google account
 *     is that account's own mailbox.
 * Anyone else signs in with an email code first and then connects Google
 * from their account settings.
 */

import crypto from 'node:crypto';
import { sha256, secretToken } from '../db/schema.mjs';
import { AppError } from '../errors.mjs';

export const GOOGLE = Object.freeze({
  issuer: 'https://accounts.google.com',
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs'
});

const STATE_MINUTES = 10;
const CLOCK_SKEW_SECONDS = 120;

/** A sign-in failure whose code is safe to put in a redirect and show. */
export class GoogleSignInError extends AppError {
  constructor(code, message) {
    super(message, 400, { code });
    this.code = code;
  }
}

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Starts a sign-in: records what the browser must bring back and returns the
 * URL to send it to, plus the cookie value that binds the attempt to this browser.
 */
export function beginGoogleSignIn(db, google, { returnTo = '/', linkUserId = null, inviteCode = null, endpoints = GOOGLE }) {
  const browserSecret = secretToken();
  const state = secretToken();
  const nonce = secretToken();
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const nowIso = new Date().toISOString();

  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  db.prepare(`
    INSERT INTO oauth_states (state_hash, browser_hash, code_verifier, nonce, return_to, link_user_id, invite_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sha256(state), sha256(browserSecret), verifier, nonce, safeReturnPath(returnTo), linkUserId, inviteCode, nowIso);

  const url = new URL(endpoints.authorization);
  url.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  }).toString();
  return { url: url.toString(), browserSecret, maxAgeSeconds: STATE_MINUTES * 60 };
}

/** Only same-site paths, and never one a browser would read as another site. */
export function safeReturnPath(value) {
  return typeof value === 'string' && /^\/(?![/\\])[^\x00-\x1f\\]{0,500}$/.test(value) ? value : '/';
}

/**
 * Finishes a sign-in: checks the state against this browser, exchanges the
 * code (with the PKCE verifier) and verifies the ID token. Returns the
 * verified identity and what was recorded at the start.
 */
export async function completeGoogleSignIn(db, google, { query, browserSecret, endpoints = GOOGLE, fetchImpl = fetch }) {
  if (query.get('error')) {
    throw new GoogleSignInError(query.get('error') === 'access_denied' ? 'cancelled' : 'google_error', 'Google sign-in did not complete');
  }
  const state = query.get('state') || '';
  const code = query.get('code') || '';
  if (!state || !code || state.length > 200 || code.length > 2000) throw new GoogleSignInError('invalid', 'Google sign-in did not complete');
  // RFC 9207: Google says it sends the issuer back with the response; if it is
  // there it must be Google's.
  if (query.get('iss') && query.get('iss') !== endpoints.issuer) throw new GoogleSignInError('invalid', 'Unexpected issuer');

  const row = db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').get(sha256(state));
  const fresh = row && !row.used_at && Date.now() - Date.parse(row.created_at) < STATE_MINUTES * 60 * 1000;
  // The attempt must have been started in this same browser. Otherwise a
  // page could hand someone a completed sign-in into an account it controls.
  if (!fresh || !browserSecret || sha256(browserSecret) !== row.browser_hash) {
    throw new GoogleSignInError('expired', 'That sign-in attempt has expired or was started elsewhere');
  }
  db.prepare('UPDATE oauth_states SET used_at = ? WHERE state_hash = ?').run(new Date().toISOString(), row.state_hash);

  let tokenResponse;
  try {
    const res = await fetchImpl(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: google.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: row.code_verifier
      }).toString(),
      signal: AbortSignal.timeout(10_000)
    });
    tokenResponse = await res.json();
    if (!res.ok) throw new Error(`token endpoint answered ${res.status} ${tokenResponse?.error || ''}`);
  } catch (err) {
    console.error('[google] code exchange failed:', err.message);
    throw new GoogleSignInError('google_error', 'Google sign-in did not complete');
  }

  const claims = await verifyIdToken(tokenResponse?.id_token, { google, nonce: row.nonce, endpoints, fetchImpl });
  return { claims, state: row };
}

// ------------------------------------------------------------------ ID token

const jwksCache = new Map(); // url -> { keys: Map(kid -> KeyObject), expires, fetchedAt }

async function signingKey(kid, { endpoints, fetchImpl }) {
  const cached = jwksCache.get(endpoints.jwks);
  if (cached && cached.expires > Date.now()) {
    if (cached.keys.has(kid)) return cached.keys.get(kid);
    // An unknown key id may mean Google rotated its keys, so fetch again —
    // but not more than once a minute, however many bad tokens arrive.
    if (Date.now() - cached.fetchedAt < 60_000) return null;
  }

  const res = await fetchImpl(endpoints.jwks, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`key endpoint answered ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.use && jwk.use !== 'sig')) continue;
    try { keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })); } catch { /* skip malformed */ }
  }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;
  jwksCache.set(endpoints.jwks, { keys, expires: Date.now() + Math.min(maxAge, 86400) * 1000, fetchedAt: Date.now() });
  return keys.get(kid) || null;
}

export async function verifyIdToken(idToken, { google, nonce, endpoints = GOOGLE, fetchImpl = fetch, now = Date.now() }) {
  const fail = () => new GoogleSignInError('invalid', 'Google sign-in could not be verified');
  if (typeof idToken !== 'string' || idToken.length > 8192) throw fail();
  const parts = idToken.split('.');
  if (parts.length !== 3) throw fail();
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw fail(); }
  // Only the algorithm Google publishes. "none" and HMAC tricks are refused here.
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') throw fail();

  let key;
  try { key = await signingKey(header.kid, { endpoints, fetchImpl }); } catch (err) {
    console.error('[google] could not fetch signing keys:', err.message);
    throw new GoogleSignInError('google_error', 'Google sign-in did not complete');
  }
  if (!key) throw fail();
  const signedOk = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!signedOk) throw fail();

  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const issuers = [endpoints.issuer, endpoints.issuer.replace(/^https:\/\//, '')];
  if (!issuers.includes(claims.iss)) throw fail();
  if (!audiences.includes(google.clientId)) throw fail();
  if (audiences.length > 1 && claims.azp !== google.clientId) throw fail();
  if (!(Number(claims.exp) > seconds - CLOCK_SKEW_SECONDS)) throw fail();
  if (claims.iat !== undefined && Number(claims.iat) > seconds + CLOCK_SKEW_SECONDS) throw fail();
  if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) throw fail();
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw fail();
  return claims;
}

/**
 * Whether Google is the authority for the token's email address, so it can
 * be used to find an existing Hushlist account.
 */
export function googleIsAuthoritative(claims) {
  const email = String(claims.email || '').toLowerCase();
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!verified || !email.includes('@')) return false;
  const domain = email.split('@').pop();
  if (domain === 'gmail.com' || domain === 'googlemail.com') return true;
  return typeof claims.hd === 'string' && claims.hd.toLowerCase() === domain;
}

/** For tests: forget cached keys. */
export function resetGoogleKeyCache() {
  jwksCache.clear();
}
