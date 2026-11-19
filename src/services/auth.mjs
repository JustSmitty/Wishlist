/**
 * Sessions and passwordless sign-in.
 *
 * Identity comes from a server-issued bearer token and nothing else. The
 * browser carries it in an HttpOnly cookie; the browser extension carries a
 * separately issued token in an Authorization header. Only SHA-256 hashes of
 * tokens are stored.
 *
 * Sign-in is a 6-digit code sent to the email address. A new address becomes
 * an account only after the code has been entered, so nobody can create or
 * enter an account for an address they cannot read.
 */

import { uid, secretToken, sixDigitCode, sha256, safeEqual, inTransaction } from '../db/schema.mjs';
import { badRequest, forbidden, notFound, tooMany } from '../errors.mjs';
import { sendNotification } from './notifications.mjs';
import { cleanText } from './capture.mjs';

const SESSION_DAYS = 30;
const API_TOKEN_DAYS = 365;
const CHALLENGE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** The subset of a user row that may be sent to that user's own browser. */
export function publicSelf(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    birthday_month: user.birthday_month,
    birthday_day: user.birthday_day,
    is_dependent: Boolean(user.is_dependent),
    is_admin: Boolean(user.is_admin),
    follow_approval_required: Boolean(user.follow_approval_required)
  };
}

export function createSession(db, userId, { kind = 'web', label = null } = {}) {
  const token = secretToken(kind === 'api' ? 'hlx' : 'hls');
  const now = new Date();
  const days = kind === 'api' ? API_TOKEN_DAYS : SESSION_DAYS;
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, kind, label, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sha256(token), userId, kind, label,
    now.toISOString(),
    new Date(now.getTime() + days * 86400 * 1000).toISOString()
  );
  return { token, maxAgeSeconds: days * 86400 };
}

/** Returns { user, session } for a live token, otherwise null. */
export function resolveSession(db, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!session) return null;
  if (session.expires_at <= new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
    return null;
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active' AND is_dependent = 0").get(session.user_id);
  if (!user) return null;
  return { user, session };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function revokeApiTokens(db, userId) {
  return db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'api'").run(userId).changes;
}

export function countApiTokens(db, userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND kind = 'api' AND expires_at > ?")
    .get(userId, new Date().toISOString()).n;
}

/**
 * Step 1: send a code. The response is identical whether or not the address
 * already has an account, so this cannot be used to discover who is a member.
 */
export function startSignIn(db, { email }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw badRequest('Enter a valid email address');

  const now = new Date();
  const recent = db.prepare(
    'SELECT COUNT(*) AS n FROM auth_challenges WHERE email = ? AND created_at > ?'
  ).get(normalized, new Date(now.getTime() - 15 * 60 * 1000).toISOString()).n;
  if (recent >= 5) throw tooMany('Too many codes requested for this address. Try again in a few minutes.');

  const id = uid('chl');
  const code = sixDigitCode();
  db.prepare(`
    INSERT INTO auth_challenges (id, email, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id, normalized, sha256(`${id}:${code}`),
    new Date(now.getTime() + CHALLENGE_MINUTES * 60 * 1000).toISOString(),
    now.toISOString()
  );

  sendNotification(db, {
    recipientEmail: normalized,
    eventType: 'sign_in_code',
    subject: 'Your Hushlist sign-in code',
    body: `Your sign-in code is ${code}. It expires in ${CHALLENGE_MINUTES} minutes. If you did not ask for it, ignore this message.`
  });

  return { challenge_id: id, code, expires_in_minutes: CHALLENGE_MINUTES };
}

/**
 * Step 2: check the code. Existing address → that account. New address →
 * { needs_profile: true } until a display name is supplied, then the account
 * is created (with a first list, and group membership if an invite code was given).
 */
export function completeSignIn(db, { challengeId, code, profile = null, adminEmails = new Set() }) {
  const nowIso = new Date().toISOString();
  const challenge = db.prepare('SELECT * FROM auth_challenges WHERE id = ?').get(String(challengeId ?? ''));
  if (!challenge || challenge.consumed_at || challenge.expires_at <= nowIso) {
    throw badRequest('That code has expired. Request a new one.');
  }

  if (!challenge.verified_at) {
    if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
      throw tooMany('Too many wrong codes. Request a new one.');
    }
    const ok = safeEqual(challenge.code_hash, sha256(`${challenge.id}:${String(code ?? '').trim()}`));
    if (!ok) {
      db.prepare('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);
      const left = MAX_CODE_ATTEMPTS - (challenge.attempts + 1);
      throw badRequest(left > 0 ? `That code is not right (${left} attempt${left === 1 ? '' : 's'} left)` : 'Too many wrong codes. Request a new one.');
    }
    db.prepare('UPDATE auth_challenges SET verified_at = ? WHERE id = ?').run(nowIso, challenge.id);
  }

  return inTransaction(db, () => {
    let user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(challenge.email);
    let created = false;

    if (user && user.status !== 'active') {
      throw forbidden('This account is not available');
    }

    if (!user) {
      const name = cleanText(profile?.name, 80);
      if (!name) return { needs_profile: true };

      const userId = uid('usr');
      const month = intInRange(profile?.birthday_month, 1, 12);
      const day = intInRange(profile?.birthday_day, 1, 31);
      db.prepare(`
        INSERT INTO users (id, name, email, birthday_month, birthday_day, is_dependent, is_admin, status, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?)
      `).run(userId, name, challenge.email, month, month ? day : null, adminEmails.has(challenge.email) ? 1 : 0, nowIso);

      db.prepare(`
        INSERT INTO lists (id, owner_id, name, occasion, visibility, surprise_mode, share_token, created_at)
        VALUES (?, ?, ?, 'Birthday', 'link', 1, ?, ?)
      `).run(uid('lst'), userId, `${name}'s wishlist`, secretToken('shr'), nowIso);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      created = true;
    } else if (adminEmails.has(challenge.email) && !user.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    let joinedGroup = null;
    const inviteCode = cleanText(profile?.invite_code, 64);
    if (inviteCode) joinedGroup = joinGroupByInvite(db, user.id, inviteCode, { quiet: true });

    db.prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id = ?').run(nowIso, challenge.id);
    return { user, created, joined_group: joinedGroup };
  });
}

/**
 * Adds a user to a group by its invite code and shares the user's lists with
 * it. The invite code is the only way in: a group id alone is not enough.
 */
export function joinGroupByInvite(db, userId, inviteCode, { quiet = false } = {}) {
  const group = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(String(inviteCode ?? '').trim());
  if (!group) {
    if (quiet) return null;
    throw notFound('That invite code does not match a circle');
  }
  const nowIso = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(group.id, userId, 'member', nowIso);
  const myLists = db.prepare("SELECT id FROM lists WHERE owner_id = ? AND visibility != 'private'").all(userId);
  for (const l of myLists) {
    db.prepare(`
      INSERT OR IGNORE INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at)
      VALUES (?, ?, 'group', ?, 'viewer', ?)
    `).run(uid('shr'), l.id, group.id, nowIso);
  }
  return { id: group.id, name: group.name };
}

function intInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
