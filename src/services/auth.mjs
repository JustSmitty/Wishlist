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
import { cleanText, daysInMonth } from './capture.mjs';
import { reapplyBlocksForEmail } from './access.mjs';

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
    follow_approval_required: Boolean(user.follow_approval_required),
    time_zone: user.time_zone || null
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
export function resolveSession(db, token, expectedKind) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  // A browser session is only valid as a cookie and an extension token only
  // as a bearer header. The kind decides what the credential may do, so it
  // must not depend on where the caller chose to put it.
  if (!session || session.kind !== expectedKind) return null;
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
export function startSignIn(db, { email, requester = null }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw badRequest('Enter a valid email address');

  const now = new Date();
  // Two limits. The tight one is per requester, so one person hammering an
  // address cannot use up its allowance and lock the real owner out. The
  // loose one is per address, and bounds how much mail anyone can cause.
  const since = (minutes) => new Date(now.getTime() - minutes * 60 * 1000).toISOString();
  const byRequester = db.prepare(
    'SELECT COUNT(*) AS n FROM auth_challenges WHERE email = ? AND requester IS ? AND created_at > ?'
  ).get(normalized, requester, since(15)).n;
  const byAddress = db.prepare(
    'SELECT COUNT(*) AS n FROM auth_challenges WHERE email = ? AND created_at > ?'
  ).get(normalized, since(60)).n;
  if (byRequester >= 5 || byAddress >= 20) {
    throw tooMany('Too many codes requested for this address. Try again in a few minutes.');
  }

  const id = secretToken('chl');
  const code = sixDigitCode();
  db.prepare(`
    INSERT INTO auth_challenges (id, email, code_hash, expires_at, created_at, requester)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, normalized, sha256(`${id}:${code}`),
    new Date(now.getTime() + CHALLENGE_MINUTES * 60 * 1000).toISOString(),
    now.toISOString(), requester
  );

  sendNotification(db, {
    recipientEmail: normalized,
    eventType: 'sign_in_code',
    subject: 'Your Hushlist sign-in code',
    body: `Your sign-in code is ${code}. It expires in ${CHALLENGE_MINUTES} minutes. If you did not ask for it, ignore this message.`,
    // The code goes to the mailbox only. What is kept is a record that one was sent.
    storedBody: `A sign-in code was sent. It expires in ${CHALLENGE_MINUTES} minutes.`
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

  // The code is required on every call until the challenge is used up,
  // including the second step where a new person supplies their name. The
  // challenge id alone is never enough.
  if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
    throw tooMany('Too many wrong codes. Request a new one.');
  }
  const ok = safeEqual(challenge.code_hash, sha256(`${challenge.id}:${String(code ?? '').trim()}`));
  if (!ok) {
    db.prepare('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);
    const left = MAX_CODE_ATTEMPTS - (challenge.attempts + 1);
    throw badRequest(left > 0 ? `That code is not right (${left} attempt${left === 1 ? '' : 's'} left)` : 'Too many wrong codes. Request a new one.');
  }
  if (!challenge.verified_at) {
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
      const day = month ? intInRange(profile?.birthday_day, 1, daysInMonth(month)) : null;
      db.prepare(`
        INSERT INTO users (id, name, email, birthday_month, birthday_day, is_dependent, is_admin, status, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?)
      `).run(userId, name, challenge.email, month, month ? day : null, adminEmails.has(challenge.email) ? 1 : 0, nowIso);

      db.prepare(`
        INSERT INTO lists (id, owner_id, name, occasion, visibility, surprise_mode, share_token, created_at)
        VALUES (?, ?, ?, 'Birthday', 'link', 1, ?, ?)
      `).run(uid('lst'), userId, `${name}'s wishlist`, secretToken('shr'), nowIso);

      // Blocks placed on this address before an earlier account was closed
      // apply to the new account too.
      reapplyBlocksForEmail(db, userId, challenge.email);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      created = true;
    } else if (adminEmails.size > 0 && Boolean(user.is_admin) !== adminEmails.has(challenge.email)) {
      // HUSHLIST_ADMIN_EMAILS is the source of truth whenever it is set:
      // adding an address grants the role, removing it takes the role away.
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(adminEmails.has(challenge.email) ? 1 : 0, user.id);
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
 * Adds a user to a group by its invite code. The invite code is the only way
 * in: a group id alone is not enough.
 */
export function joinGroupByInvite(db, userId, inviteCode, { quiet = false } = {}) {
  const code = String(inviteCode ?? '').trim().toUpperCase();
  let group = code ? db.prepare('SELECT * FROM groups WHERE UPPER(invite_code) = ?').get(code) : null;
  // Someone an organizer has blocked gets the same answer as a wrong code.
  if (group && db.prepare(`
    SELECT 1 FROM blocks b
    JOIN group_members gm ON gm.user_id = b.blocker_id AND gm.group_id = ? AND gm.role = 'organizer'
    WHERE b.blocked_id = ?
  `).get(group.id, userId)) group = null;
  if (!group) {
    if (quiet) return null;
    throw notFound('That invite code does not match a circle');
  }
  // Joining shares nothing by itself. Lists shared by link are open to circle
  // members anyway; a list scoped to particular circles stays scoped to them
  // until its owner chooses to add this one.
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(group.id, userId, 'member', new Date().toISOString());
  return { id: group.id, name: group.name };
}

function intInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Applies HUSHLIST_ADMIN_EMAILS to existing accounts. When the list is set it
 * decides who is an administrator, so an address taken off it loses the role
 * the next time the server starts (and at that person's next sign-in), not never.
 * When it is empty nothing changes: demo data keeps its sample administrator.
 */
export function syncAdmins(db, adminEmails) {
  if (!adminEmails || adminEmails.size === 0) return;
  const rows = db.prepare("SELECT id, email, is_admin FROM users WHERE status = 'active' AND email IS NOT NULL").all();
  for (const u of rows) {
    const should = adminEmails.has(u.email.toLowerCase()) ? 1 : 0;
    if (u.is_admin !== should) {
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(should, u.id);
      // A demoted administrator's open sessions end with the role.
      if (!should) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
  }
}

/** Removes sign-in challenges and sessions that can no longer be used. */
export function purgeExpiredAuth(db, now = new Date()) {
  db.prepare('DELETE FROM auth_challenges WHERE created_at < ?').run(new Date(now.getTime() - 24 * 3600 * 1000).toISOString());
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
}
