import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, uid, secretToken, inTransaction } from './db/schema.mjs';
import { seedRetailerAdapters, seedDemoData } from './db/seed.mjs';
import { loadConfig } from './config.mjs';
import { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany } from './errors.mjs';
import {
  SESSION_COOKIE, sendJson, readJsonBody, parseCookies, sessionCookie, RateLimiter, serveStatic, csvCell
} from './http.mjs';
import { getViewerRole, sanitizeItemForViewer, ownerCanSeeClaims, safeJsonParse } from './services/surprise.mjs';
import {
  captureFromUrl, canonicalizeUrl, checkUrlSafety, cleanText, cleanPrice, cleanInt, cleanDate,
  cleanFieldConfidence, toProxiedImageUrl, importAmazonList, recheckItemPriceAndStock
} from './services/capture.mjs';
import {
  createClaim, verifyGuestClaim, transitionClaimState, handleOwnerDeleteOrGotIt, handleOwnerEditItem,
  markItemReceived, archiveList, reuseList, addContribution, withdrawContribution, purgeExpiredClaims,
  publicClaim
} from './services/claims.mjs';
import { sendNotification, generateFollowerDigest, setMailTransport, consoleMailTransport } from './services/notifications.mjs';
import { createSecretSantaExchange } from './services/secret-santa.mjs';
import {
  publicSelf, createSession, resolveSession, destroySession, revokeApiTokens, countApiTokens,
  startSignIn, completeSignIn, joinGroupByInvite
} from './services/auth.mjs';
import { deleteAccount } from './services/account.mjs';
import {
  getActiveUser, isGuardianOf, isGroupMember, isBlockedBy, inSameCircle, canNameAsCollaborator
} from './services/access.mjs';

const __filename = fileURLToPath(import.meta.url);
const PUBLIC_DIR = path.resolve(path.dirname(__filename), 'public');

const VISIBILITIES = ['private', 'specific', 'link'];
const PRIORITIES = ['most_wanted', 'high', 'normal', 'low'];
const KINDS = ['product', 'experience', 'cash', 'idea'];
const MAX_ITEMS_PER_LIST = 500;
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]+$/i;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  // No inline script and no inline style anywhere in the app.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

export function createApp(customDb = null, options = {}) {
  const config = { ...loadConfig(), ...options };
  const db = customDb || createDatabase();

  seedRetailerAdapters(db);
  if (config.demoMode) seedDemoData(db);
  setMailTransport(config.mailTransport === 'console' ? consoleMailTransport : null);

  const limiter = new RateLimiter();
  let lastPurge = 0;

  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  function limit(req, name, max, windowMs = 60_000) {
    if (!limiter.allow(`${name}:${clientIp(req)}`, max, windowMs)) throw tooMany();
  }

  /** Lazily closes lapsed holds, at most once every few seconds. */
  function purgeIfDue() {
    const now = Date.now();
    if (now - lastPurge < 15_000) return;
    lastPurge = now;
    purgeExpiredClaims(db);
  }

  function listDetail(list, viewerId, guestToken = null) {
    return formatListResponse(db, list, viewerId, guestToken);
  }

  async function route(req, res) {
    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname;
    const method = req.method;
    const isApi = pathname.startsWith('/api/');

    // ----- Cross-origin policy ------------------------------------------------
    // The browser extension is the only cross-origin caller. It authenticates
    // with a bearer token, never with cookies, so no credentials are allowed.
    const origin = req.headers.origin;
    if (origin && EXTENSION_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ----- Identity -----------------------------------------------------------
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1] || null;
    const cookieToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
    const bearerSession = isApi ? resolveSession(db, bearer) : null;
    const cookieSession = isApi && !bearerSession ? resolveSession(db, cookieToken) : null;
    const currentUser = (bearerSession || cookieSession)?.user || null;
    const viaCookie = Boolean(cookieSession);
    const guestToken = typeof req.headers['x-guest-token'] === 'string'
      ? req.headers['x-guest-token'].slice(0, 200)
      : null;

    // ----- Cross-site request forgery ----------------------------------------
    // SameSite=Lax already withholds the cookie from cross-site POSTs, and the
    // JSON content-type requirement forces a preflight that is never granted.
    // The Origin comparison is a third, independent check.
    const isWrite = !['GET', 'HEAD'].includes(method);
    if (isWrite && viaCookie && origin) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { /* malformed */ }
      if (originHost !== req.headers.host) throw forbidden('Cross-site request refused');
    }

    const requireUser = () => {
      if (!currentUser) throw unauthorized();
      return currentUser;
    };
    const requireAdmin = () => {
      if (!currentUser || !currentUser.is_admin) throw forbidden('Admin privileges required');
      return currentUser;
    };
    const body = () => readJsonBody(req);
    const getList = (id) => {
      const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(String(id ?? ''));
      if (!list) throw notFound('List not found');
      return list;
    };
    const requireListEditor = (list) => {
      if (!getViewerRole(db, list, requireUser().id).canEdit) throw forbidden('You cannot change this list');
    };

    if (isApi) purgeIfDue();

    // =========================================================================
    // Placeholder artwork and share target
    // =========================================================================
    if (pathname === '/api/image-proxy' && (method === 'GET' || method === 'HEAD')) {
      // Despite the path (kept so stored item.image values keep resolving),
      // nothing is fetched: this renders a local SVG label.
      const svg = renderPlaceholderSvg(urlObj.searchParams.get('label') || 'Gift', urlObj.searchParams.get('theme'));
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(method === 'HEAD' ? undefined : svg);
      return;
    }

    if (pathname === '/share-target' && method === 'GET') {
      const sharedUrl = (urlObj.searchParams.get('url') || urlObj.searchParams.get('text') || '').slice(0, 2048);
      const sharedTitle = (urlObj.searchParams.get('title') || '').slice(0, 300);
      res.writeHead(302, {
        Location: `/?sharedUrl=${encodeURIComponent(sharedUrl)}&sharedTitle=${encodeURIComponent(sharedTitle)}`
      });
      res.end();
      return;
    }

    // =========================================================================
    // Session and sign-in
    // =========================================================================
    if (pathname === '/api/session' && method === 'GET') {
      const dependents = currentUser ? db.prepare(`
        SELECT u.id, u.name, u.birthday_month, u.birthday_day, gl.relationship
        FROM guardian_links gl
        JOIN users u ON u.id = gl.dependent_id
        WHERE gl.guardian_id = ? AND u.status = 'active'
        ORDER BY u.name
      `).all(currentUser.id) : [];

      // The sample people are listed only in demo mode, where signing in as
      // any of them is the point. Otherwise this endpoint names nobody.
      const personas = config.demoMode ? db.prepare(`
        SELECT id, name, is_admin FROM users
        WHERE status = 'active' AND is_dependent = 0
        ORDER BY is_admin DESC, created_at ASC, name ASC LIMIT 12
      `).all().map(p => ({ id: p.id, name: p.name, is_admin: Boolean(p.is_admin) })) : [];

      return sendJson(res, 200, {
        current_user: publicSelf(currentUser),
        is_guest: !currentUser,
        dependents,
        api_tokens: currentUser ? countApiTokens(db, currentUser.id) : 0,
        demo: { enabled: config.demoMode, personas }
      });
    }

    if (pathname === '/api/auth/start' && method === 'POST') {
      limit(req, 'auth-start', 10);
      const b = await body();
      const started = startSignIn(db, { email: b.email });
      return sendJson(res, 200, {
        challenge_id: started.challenge_id,
        expires_in_minutes: started.expires_in_minutes,
        // Demo mode has no mailbox to deliver to, so the code is shown instead.
        ...(config.demoMode ? { demo_code: started.code } : {})
      });
    }

    if (pathname === '/api/auth/verify' && method === 'POST') {
      limit(req, 'auth-verify', 20);
      const b = await body();
      const result = completeSignIn(db, {
        challengeId: b.challenge_id,
        code: b.code,
        profile: b.name ? {
          name: b.name,
          birthday_month: b.birthday_month,
          birthday_day: b.birthday_day,
          invite_code: b.invite_code
        } : (b.invite_code ? { invite_code: b.invite_code } : null),
        adminEmails: config.adminEmails
      });
      if (result.needs_profile) return sendJson(res, 200, { needs_profile: true });
      const session = createSession(db, result.user.id);
      return sendJson(res, 200, {
        current_user: publicSelf(result.user),
        created: result.created,
        joined_group: result.joined_group
      }, { 'Set-Cookie': sessionCookie(session.token, session.maxAgeSeconds, { secure: config.secureCookies }) });
    }

    if (pathname === '/api/auth/demo-login' && method === 'POST') {
      if (!config.demoMode) throw notFound('Not found');
      const b = await body();
      const user = getActiveUser(db, b.user_id);
      if (!user || user.is_dependent) throw notFound('No such sample person');
      if (cookieToken) destroySession(db, cookieToken);
      const session = createSession(db, user.id);
      return sendJson(res, 200, { current_user: publicSelf(user) }, {
        'Set-Cookie': sessionCookie(session.token, session.maxAgeSeconds, { secure: config.secureCookies })
      });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      if (cookieToken) destroySession(db, cookieToken);
      return sendJson(res, 200, { signed_out: true }, {
        'Set-Cookie': sessionCookie('', 0, { secure: config.secureCookies })
      });
    }

    // Token for the browser extension. Shown once; only its hash is stored.
    if (pathname === '/api/auth/tokens' && method === 'POST') {
      const user = requireUser();
      if (!viaCookie) throw forbidden('Create tokens from the app, not with another token');
      limit(req, 'tokens', 10);
      revokeApiTokens(db, user.id);
      const created = createSession(db, user.id, { kind: 'api', label: 'Browser extension' });
      return sendJson(res, 201, { token: created.token });
    }
    if (pathname === '/api/auth/tokens' && method === 'DELETE') {
      const user = requireUser();
      return sendJson(res, 200, { revoked: revokeApiTokens(db, user.id) });
    }

    if (pathname === '/api/account' && method === 'PATCH') {
      const user = requireUser();
      const b = await body();
      const name = b.name !== undefined ? cleanText(b.name, 80) : user.name;
      if (!name) throw badRequest('Enter a display name');
      const month = b.birthday_month !== undefined ? nullableInt(b.birthday_month, 1, 12) : user.birthday_month;
      const day = b.birthday_day !== undefined ? nullableInt(b.birthday_day, 1, 31) : user.birthday_day;
      const approval = b.follow_approval_required !== undefined ? (b.follow_approval_required ? 1 : 0) : user.follow_approval_required;
      db.prepare('UPDATE users SET name = ?, birthday_month = ?, birthday_day = ?, follow_approval_required = ? WHERE id = ?')
        .run(name, month, month ? day : null, approval, user.id);
      return sendJson(res, 200, { current_user: publicSelf(getActiveUser(db, user.id)) });
    }

    if (pathname === '/api/account' && method === 'DELETE') {
      const user = requireUser();
      const b = await body();
      if (b.confirm !== true) throw badRequest('Confirm that you want to delete your account');
      deleteAccount(db, user.id);
      return sendJson(res, 200, { deleted: true }, {
        'Set-Cookie': sessionCookie('', 0, { secure: config.secureCookies })
      });
    }

    // Guardian creates a profile for a child. The child has no email or sign-in.
    if (pathname === '/api/dependents' && method === 'POST') {
      const user = requireUser();
      const b = await body();
      const childName = cleanText(b.name, 80);
      if (!childName) throw badRequest("Enter the child's name");
      if (b.co_guardian_id && !canNameAsCollaborator(db, user.id, b.co_guardian_id)) {
        throw badRequest('A co-guardian must be an adult in one of your circles');
      }
      const month = nullableInt(b.birthday_month, 1, 12);
      const day = nullableInt(b.birthday_day, 1, 31);
      const eventDate = b.event_date ? futureDateOrThrow(b.event_date) : null;

      const created = inTransaction(db, () => {
        const nowIso = new Date().toISOString();
        const childId = uid('usr');
        db.prepare(`
          INSERT INTO users (id, name, email, birthday_month, birthday_day, is_dependent, is_admin, status, created_at)
          VALUES (?, ?, NULL, ?, ?, 1, 0, 'active', ?)
        `).run(childId, childName, month, month ? day : null, nowIso);
        const link = db.prepare('INSERT OR IGNORE INTO guardian_links (guardian_id, dependent_id, relationship, created_at) VALUES (?, ?, ?, ?)');
        link.run(user.id, childId, cleanText(b.relationship, 60) || 'Parent / guardian', nowIso);
        if (b.co_guardian_id) link.run(b.co_guardian_id, childId, 'Parent / guardian', nowIso);

        const listId = uid('lst');
        db.prepare(`
          INSERT INTO lists (id, owner_id, name, occasion, event_date, visibility, surprise_mode, share_token, created_at)
          VALUES (?, ?, ?, 'Birthday', ?, 'specific', 1, ?, ?)
        `).run(listId, childId, `${childName}'s wishlist`, eventDate, secretToken('shr'), nowIso);
        // A child's list starts shared with the guardian's circles, not by public link.
        for (const g of db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(user.id)) {
          db.prepare(`
            INSERT OR IGNORE INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at)
            VALUES (?, ?, 'group', ?, 'viewer', ?)
          `).run(uid('shr'), listId, g.group_id, nowIso);
        }
        return { childId, listId };
      });

      return sendJson(res, 201, {
        dependent: { id: created.childId, name: childName },
        list: listDetail(getList(created.listId), user.id)
      });
    }

    // =========================================================================
    // Lists
    // =========================================================================
    if (pathname === '/api/lists' && method === 'GET') {
      // Only the caller's own lists. There is deliberately no way to list
      // other people's lists here: a share link must be known, not discovered.
      if (!currentUser) return sendJson(res, 200, { lists: [] });
      const rows = db.prepare(`
        SELECT l.* FROM lists l
        WHERE l.owner_id = ?
           OR l.co_owner_ids LIKE ?
           OR l.owner_id IN (SELECT dependent_id FROM guardian_links WHERE guardian_id = ?)
        ORDER BY l.archived_at IS NOT NULL ASC, l.created_at ASC
      `).all(currentUser.id, `%"${currentUser.id}"%`, currentUser.id);
      const lists = rows.map(l => listDetail(l, currentUser.id)).filter(l => l && l.can_edit);
      return sendJson(res, 200, { lists });
    }

    if (pathname === '/api/lists' && method === 'POST') {
      const user = requireUser();
      const b = await body();
      const ownerId = typeof b.owner_id === 'string' && b.owner_id ? b.owner_id : user.id;
      if (ownerId !== user.id && !isGuardianOf(db, user.id, ownerId)) {
        throw forbidden('You cannot create a list for this person');
      }
      const name = cleanText(b.name, 120);
      if (!name) throw badRequest('Give the list a name');
      const visibility = VISIBILITIES.includes(b.visibility) ? b.visibility : 'link';
      const eventDate = b.event_date ? futureDateOrThrow(b.event_date) : null;

      const coOwnerIds = Array.isArray(b.co_owner_ids) ? [...new Set(b.co_owner_ids)].slice(0, 5) : [];
      for (const id of coOwnerIds) {
        if (id === ownerId || !canNameAsCollaborator(db, user.id, id)) {
          throw badRequest('Co-owners must be adults in one of your circles');
        }
      }
      if (b.helper_user_id && !canNameAsCollaborator(db, user.id, b.helper_user_id)) {
        throw badRequest('A helper must be an adult in one of your circles');
      }
      const groupIds = (Array.isArray(b.group_ids) ? b.group_ids : (b.group_id ? [b.group_id] : [])).slice(0, 20);
      for (const gid of groupIds) {
        if (!isGroupMember(db, gid, user.id)) throw forbidden('You can only share with circles you belong to');
      }

      const listId = inTransaction(db, () => {
        const id = uid('lst');
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO lists (
            id, owner_id, co_owner_ids, name, occasion, event_date,
            visibility, surprise_mode, share_token, guest_claim_cap, claim_expiry_days, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, ownerId, JSON.stringify(coOwnerIds), name,
          cleanText(b.occasion, 40) || 'Birthday', eventDate, visibility,
          b.surprise_mode === false ? 0 : 1, secretToken('shr'),
          cleanInt(b.guest_claim_cap, 1, 20, 3), cleanInt(b.claim_expiry_days, 1, 60, 7), nowIso
        );
        const share = db.prepare(`
          INSERT OR REPLACE INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        if (b.helper_user_id) share.run(uid('shr'), id, 'user', b.helper_user_id, 'helper', nowIso);
        for (const gid of groupIds) share.run(uid('shr'), id, 'group', gid, 'viewer', nowIso);
        return id;
      });

      return sendJson(res, 201, { list: listDetail(getList(listId), user.id) });
    }

    const listMatch = pathname.match(/^\/api\/lists\/([^/]{1,200})$/);
    if (listMatch && method === 'GET') {
      const key = decodeSegment(listMatch[1]);
      const list = db.prepare('SELECT * FROM lists WHERE id = ? OR share_token = ?').get(key, key);
      const formatted = list ? listDetail(list, currentUser?.id || null, guestToken) : null;
      // "Not found" and "not allowed" are indistinguishable on purpose.
      if (!formatted) throw notFound('This list is not available');
      return sendJson(res, 200, { list: formatted }, { 'X-Robots-Tag': 'noindex, nofollow' });
    }

    if (listMatch && method === 'PATCH') {
      const user = requireUser();
      const list = getList(decodeSegment(listMatch[1]));
      requireListEditor(list);
      const b = await body();
      const nowIso = new Date().toISOString();
      const reply = () => sendJson(res, 200, { list: listDetail(getList(list.id), user.id) });

      if (b.action === 'archive') {
        archiveList(db, list);
        return reply();
      }

      if (b.action === 'reuse') {
        reuseList(db, list, { eventDate: b.event_date ? futureDateOrThrow(b.event_date) : null });
        return reply();
      }

      // Reveal after the occasion. The unlock time is decided here, from the
      // stored date; there is no client override. Givers are told when it happens.
      if (b.action === 'reveal') {
        if (list.revealed_at || list.surprise_mode === 0) return reply();
        const unlocksOn = revealUnlockDate(list);
        if (!unlocksOn || nowIso.slice(0, 10) < unlocksOn) {
          throw conflict(
            unlocksOn
              ? `This list stays sealed until ${unlocksOn}, a week after the occasion.`
              : 'Set the date of the occasion first. The list can be opened a week after it.',
            { code: 'reveal_locked', unlocks_on: unlocksOn }
          );
        }
        inTransaction(db, () => {
          db.prepare('UPDATE lists SET revealed_at = ? WHERE id = ?').run(nowIso, list.id);
          const givers = db.prepare(`
            SELECT DISTINCT claimer_user_id AS user_id, guest_email FROM claims
            WHERE list_id = ? AND status IN ('reserved', 'purchased', 'given') AND verified = 1
            UNION
            SELECT DISTINCT contributor_user_id, guest_email FROM contributions
            WHERE list_id = ? AND status IN ('pledged', 'paid_off_platform')
          `).all(list.id, list.id);
          for (const g of givers) {
            sendNotification(db, {
              recipientUserId: g.user_id,
              recipientEmail: g.guest_email,
              eventType: 'list_revealed',
              subject: `"${list.name}" has been opened`,
              body: `The occasion has passed and "${list.name}" was opened, so its owner can now see who gave what.`
            });
          }
        });
        return reply();
      }

      const updates = {};
      if (b.name !== undefined) {
        updates.name = cleanText(b.name, 120);
        if (!updates.name) throw badRequest('Give the list a name');
      }
      if (b.occasion !== undefined) updates.occasion = cleanText(b.occasion, 40) || list.occasion;
      if (b.event_date !== undefined && (b.event_date || null) !== list.event_date) {
        // A past date would move the reveal unlock into the past.
        updates.event_date = b.event_date ? futureDateOrThrow(b.event_date) : null;
        if (!updates.event_date && list.surprise_mode === 1 && list.event_date) {
          throw badRequest('A surprise list keeps its date. Change it to another date instead.');
        }
      }
      if (b.visibility !== undefined) {
        if (!VISIBILITIES.includes(b.visibility)) throw badRequest('Unknown visibility');
        updates.visibility = b.visibility;
      }
      if (b.surprise_mode !== undefined) {
        const next = b.surprise_mode ? 1 : 0;
        if (list.surprise_mode === 1 && next === 0) {
          // The answer depends only on something the owner already knows (the
          // list has items), never on whether anything has been claimed.
          const items = db.prepare('SELECT COUNT(*) AS n FROM items WHERE list_id = ?').get(list.id).n;
          if (items > 0) {
            throw conflict(
              'Surprise mode can only be switched off while a list is still empty. To see who gave what, open the list after the occasion.',
              { code: 'surprise_locked' }
            );
          }
        }
        updates.surprise_mode = next;
      }
      if (b.helper_user_id !== undefined && b.helper_user_id && !canNameAsCollaborator(db, user.id, b.helper_user_id)) {
        throw badRequest('A helper must be an adult in one of your circles');
      }

      inTransaction(db, () => {
        if (b.helper_user_id !== undefined) {
          db.prepare("DELETE FROM list_shares WHERE list_id = ? AND permission = 'helper'").run(list.id);
          if (b.helper_user_id) {
            db.prepare(`
              INSERT OR REPLACE INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at)
              VALUES (?, ?, 'user', ?, 'helper', ?)
            `).run(uid('shr'), list.id, b.helper_user_id, nowIso);
          }
        }
        const merged = { ...list, ...updates };
        db.prepare('UPDATE lists SET name = ?, occasion = ?, event_date = ?, visibility = ?, surprise_mode = ? WHERE id = ?')
          .run(merged.name, merged.occasion, merged.event_date, merged.visibility, merged.surprise_mode, list.id);
      });
      return reply();
    }

    // =========================================================================
    // Capture and items
    // =========================================================================
    if (pathname === '/api/capture' && method === 'POST') {
      const user = requireUser();
      limit(req, 'capture', 60);
      const b = await body();
      if (!b.url || typeof b.url !== 'string') throw badRequest('Paste a link first');

      const extracted = await captureFromUrl(db, {
        url: b.url,
        htmlSnapshot: b.html ?? null,
        clientExtracted: b.client_extracted ?? null,
        pathType: b.path_type || 'paste'
      });

      let duplicate = null;
      if (extracted.canonical_url) {
        const dup = db.prepare(`
          SELECT i.title, l.name AS list_name
          FROM items i JOIN lists l ON l.id = i.list_id
          WHERE l.owner_id = ? AND i.status = 'active'
            AND (i.canonical_url = ? OR (? != '' AND LOWER(i.title) = LOWER(?)))
          LIMIT 1
        `).get(user.id, extracted.canonical_url, extracted.title || '', extracted.title || '');
        if (dup) duplicate = { title: dup.title, list_name: dup.list_name };
      }
      return sendJson(res, 200, { capture: extracted, duplicate_warning: duplicate });
    }

    if (pathname === '/api/items' && method === 'POST') {
      const user = requireUser();
      const b = await body();
      const list = getList(b.list_id);
      const viewerCtx = getViewerRole(db, list, user.id);
      if (!viewerCtx.canEdit) throw forbidden('You cannot add items to this list');
      if (list.archived_at) throw conflict('This list is archived');

      const canonical = b.url ? canonicalizeUrl(b.url) : null;
      const title = cleanText(b.title, 300);
      if (!title) throw badRequest('Give the item a title');

      const count = db.prepare("SELECT COUNT(*) AS n FROM items WHERE list_id = ? AND status IN ('active', 'received')").get(list.id).n;
      if (count >= MAX_ITEMS_PER_LIST) throw conflict(`A list can hold up to ${MAX_ITEMS_PER_LIST} items`);

      if (!b.force_duplicate) {
        const dup = db.prepare(`
          SELECT i.title, l.name AS list_name
          FROM items i JOIN lists l ON l.id = i.list_id
          WHERE l.owner_id = ? AND i.status = 'active'
            AND ((? IS NOT NULL AND i.canonical_url = ?) OR LOWER(i.title) = LOWER(?))
          LIMIT 1
        `).get(list.owner_id, canonical, canonical, title);
        if (dup) {
          throw conflict(`"${dup.title}" is already on "${dup.list_name}".`, {
            duplicate_detected: true,
            existing_item: { title: dup.title, list_name: dup.list_name }
          });
        }
      }

      const kind = KINDS.includes(b.kind) ? b.kind : 'product';
      let price = null;
      if (b.price !== undefined && b.price !== null && b.price !== '') {
        price = cleanPrice(b.price);
        if (price === null) throw badRequest('Enter a valid price');
      }
      const currency = typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency) ? b.currency.toUpperCase() : 'USD';
      const defaultStore = kind === 'experience' ? 'Experience' : kind === 'cash' ? 'Gift fund' : kind === 'idea' ? 'Any store' : 'Any store';
      const alternates = (Array.isArray(b.alternate_sources) ? b.alternate_sources : []).slice(0, 10)
        .map(a => ({
          store: cleanText(a?.store, 80),
          url: typeof a?.url === 'string' && checkUrlSafety(a.url).safe ? canonicalizeUrl(a.url) : null,
          price: cleanPrice(a?.price)
        }))
        .filter(a => a.url);

      const itemId = uid('itm');
      inTransaction(db, () => {
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO items (
            id, list_id, kind, title, canonical_url, original_url, store, image, price, currency,
            variant, qty_wanted, always_wanted, allow_group_chip_in, priority, notes,
            any_similar, giving_instructions, alternate_sources, field_confidence, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          itemId, list.id, kind, title, canonical, canonical,
          cleanText(b.store, 120) || defaultStore,
          toProxiedImageUrl(b.image),
          price, currency,
          cleanText(b.variant, 200) || null,
          cleanInt(b.qty_wanted, 1, 999, 1),
          b.always_wanted ? 1 : 0,
          b.allow_group_chip_in ? 1 : 0,
          PRIORITIES.includes(b.priority) ? b.priority : 'normal',
          cleanText(b.notes, 2000) || null,
          b.any_similar ? 1 : 0,
          cleanText(b.giving_instructions, 500) || null,
          JSON.stringify(alternates),
          JSON.stringify(cleanFieldConfidence(b.field_confidence)),
          cleanInt(b.sort_order, 0, 100000, count),
          nowIso, nowIso
        );
        if (price !== null) {
          db.prepare('INSERT INTO price_snapshots (id, item_id, price, in_stock, checked_at) VALUES (?, ?, ?, 1, ?)')
            .run(uid('ps'), itemId, price, nowIso);
        }
        db.prepare(`
          INSERT INTO events (id, actor_id, entity_type, entity_id, list_id, action, details, is_spoiler, at)
          VALUES (?, ?, 'item', ?, ?, 'item_added', ?, 0, ?)
        `).run(uid('ev'), user.id, itemId, list.id, JSON.stringify({ title }), nowIso);
        db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)')
          .run(uid('ae'), 'item_saved', JSON.stringify({ item_kind: kind }), nowIso);
      });

      const created = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
      return sendJson(res, 201, { item: sanitizeItemForViewer(db, created, list, viewerCtx, user.id) });
    }

    // Owner records a new price or stock state for an item.
    const priceMatch = pathname.match(/^\/api\/items\/([^/]{1,100})\/recheck$/);
    if (priceMatch && method === 'POST') {
      const user = requireUser();
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(decodeSegment(priceMatch[1]));
      if (!item) throw notFound('Item not found');
      if (!getViewerRole(db, getList(item.list_id), user.id).canEdit) throw forbidden('You cannot change this item');
      const b = await body();
      const report = recheckItemPriceAndStock(db, {
        itemId: item.id,
        newPrice: b.new_price,
        newInStock: b.in_stock !== false,
        sendNotificationFn: sendNotification
      });
      return sendJson(res, 200, { recheck: report });
    }

    const itemMatch = pathname.match(/^\/api\/items\/([^/]{1,100})$/);
    if (itemMatch && method === 'PATCH') {
      const user = requireUser();
      const itemId = decodeSegment(itemMatch[1]);
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
      if (!item) throw notFound('Item not found');
      const list = getList(item.list_id);
      const viewerCtx = getViewerRole(db, list, user.id);
      if (!viewerCtx.canEdit) throw forbidden('You cannot change items on this list');

      const b = await body();
      const nowIso = new Date().toISOString();

      if (b.action === 'got_it') {
        return sendJson(res, 200, { result: handleOwnerDeleteOrGotIt(db, { itemId, ownerId: user.id, mode: 'got_it' }) });
      }
      if (b.action === 'mark_received') {
        return sendJson(res, 200, markItemReceived(db, { itemId, actorId: user.id, outsideApp: Boolean(b.outside_app) }));
      }
      if (b.action === 'toggle_thank_you') {
        db.prepare('UPDATE items SET thank_you_sent = ?, thank_you_note = ?, updated_at = ? WHERE id = ?')
          .run(b.thank_you_sent ? 1 : 0, cleanText(b.thank_you_note, 1000) || null, nowIso, itemId);
        return sendJson(res, 200, { updated: true });
      }

      if (b.action === 'move_to_list' || b.action === 'copy_to_list') {
        const target = db.prepare('SELECT * FROM lists WHERE id = ?').get(String(b.target_list_id ?? ''));
        // The caller must be an editor of the destination too, and both lists
        // must belong to the same person.
        if (!target || target.id === list.id || target.owner_id !== list.owner_id ||
            !getViewerRole(db, target, user.id).canEdit) {
          throw badRequest('Choose another of your lists');
        }
        if (target.archived_at) throw conflict('That list is archived');
        if (item.status !== 'active') throw conflict('Only active items can be moved or copied');

        if (b.action === 'move_to_list') {
          // Claims travel with the item. Moving from a sealed list to one
          // whose owner can see claims would unseal them, so it is refused —
          // for every item, claimed or not, so the refusal says nothing.
          if (!ownerCanSeeClaims(list) && ownerCanSeeClaims(target)) {
            throw conflict('Items on a surprise list can only move to another surprise list. Copy it instead.');
          }
          inTransaction(db, () => {
            db.prepare('UPDATE items SET list_id = ?, updated_at = ? WHERE id = ?').run(target.id, nowIso, itemId);
            db.prepare('UPDATE claims SET list_id = ?, updated_at = ? WHERE item_id = ?').run(target.id, nowIso, itemId);
            db.prepare('UPDATE contributions SET list_id = ? WHERE item_id = ?').run(target.id, itemId);
          });
          return sendJson(res, 200, { moved: true, target_list_id: target.id });
        }

        const targetCount = db.prepare("SELECT COUNT(*) AS n FROM items WHERE list_id = ? AND status IN ('active', 'received')").get(target.id).n;
        if (targetCount >= MAX_ITEMS_PER_LIST) throw conflict(`A list can hold up to ${MAX_ITEMS_PER_LIST} items`);
        const copyId = uid('itm');
        db.prepare(`
          INSERT INTO items (
            id, list_id, kind, title, canonical_url, original_url, store, image, price, currency,
            variant, qty_wanted, always_wanted, allow_group_chip_in, priority, notes,
            any_similar, giving_instructions, alternate_sources, field_confidence, sort_order, created_at, updated_at
          )
          SELECT ?, ?, kind, title, canonical_url, original_url, store, image, price, currency,
                 variant, qty_wanted, always_wanted, allow_group_chip_in, priority, notes,
                 any_similar, giving_instructions, alternate_sources, field_confidence, sort_order, ?, ?
          FROM items WHERE id = ?
        `).run(copyId, target.id, nowIso, nowIso, itemId);
        return sendJson(res, 201, { copied: true, new_item_id: copyId, target_list_id: target.id });
      }

      if (b.action === 'reorder') {
        const order = cleanInt(b.sort_order, 0, 100000, 0);
        db.prepare('UPDATE items SET sort_order = ?, updated_at = ? WHERE id = ?').run(order, nowIso, itemId);
        return sendJson(res, 200, { reordered: true, sort_order: order });
      }

      const updated = handleOwnerEditItem(db, { itemId, ownerId: user.id, updates: b });
      return sendJson(res, 200, { item: sanitizeItemForViewer(db, updated, list, viewerCtx, user.id) });
    }

    if (itemMatch && method === 'DELETE') {
      const user = requireUser();
      const result = handleOwnerDeleteOrGotIt(db, { itemId: decodeSegment(itemMatch[1]), ownerId: user.id, mode: 'deleted' });
      return sendJson(res, 200, { result });
    }

    // =========================================================================
    // Claims and pledges
    // =========================================================================
    if (pathname === '/api/claims' && method === 'POST') {
      limit(req, 'claims', 30);
      const b = await body();
      const claim = createClaim(db, {
        itemId: b.item_id,
        claimerUserId: currentUser?.id || null,
        guestEmail: currentUser ? null : b.guest_email,
        guestName: currentUser ? null : b.guest_name,
        qty: b.qty ?? 1,
        showNameToGivers: b.show_name_to_givers !== false,
        orderNote: b.order_note
      });
      const { verification_code: code, ...safe } = claim;
      return sendJson(res, 201, {
        claim: { ...safe, ...(config.demoMode && code ? { demo_verification_code: code } : {}) }
      });
    }

    if (pathname === '/api/claims/verify' && method === 'POST') {
      limit(req, 'verify', 25);
      const b = await body();
      return sendJson(res, 200, { claim: verifyGuestClaim(db, { claimId: b.claim_id, code: b.code }) });
    }

    const claimMatch = pathname.match(/^\/api\/claims\/([^/]{1,100})$/);
    if (claimMatch && method === 'PATCH') {
      limit(req, 'claim-update', 120);
      const claimId = decodeSegment(claimMatch[1]);
      const b = await body();
      const existing = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
      const isOwn = Boolean(existing && (
        (currentUser && existing.claimer_user_id === currentUser.id) ||
        (!existing.claimer_user_id && guestToken && existing.manage_token === guestToken)
      ));
      const actor = { claimId, actorId: currentUser?.id || null, manageToken: guestToken };

      if (b.action === 'click_out' || b.action === 'answer_return_prompt') {
        // Same response for "no such claim" and "not yours".
        if (!isOwn) throw notFound('Reservation not found');
        const nowIso = new Date().toISOString();
        if (b.action === 'click_out') {
          db.prepare('UPDATE claims SET clicked_out_at = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, claimId);
          return sendJson(res, 200, { clicked_out_at: nowIso });
        }
        if (!['bought', 'not_yet', 'released'].includes(b.answer)) throw badRequest('Unknown answer');
        db.prepare('UPDATE claims SET return_prompt_answered = ?, updated_at = ? WHERE id = ?').run(b.answer, nowIso, claimId);
        if (b.answer === 'bought' && existing.status === 'reserved') {
          return sendJson(res, 200, { claim: transitionClaimState(db, { ...actor, newState: 'purchased', reason: 'Confirmed after visiting the store' }) });
        }
        if (b.answer === 'released') {
          return sendJson(res, 200, { claim: transitionClaimState(db, { ...actor, newState: 'released', reason: 'Released after visiting the store' }) });
        }
        return sendJson(res, 200, { claim: publicClaim(db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId)) });
      }

      if (!currentUser && !guestToken) throw unauthorized();
      const updated = transitionClaimState(db, {
        ...actor,
        newState: String(b.status ?? ''),
        reason: b.reason,
        orderNote: b.order_note
      });
      return sendJson(res, 200, { claim: updated });
    }

    if (pathname === '/api/contributions' && method === 'POST') {
      const user = requireUser();
      limit(req, 'pledge', 30);
      const b = await body();
      const contribution = addContribution(db, {
        itemId: b.item_id,
        contributorUserId: user.id,
        pledgedAmount: b.pledged_amount,
        showNameToGivers: b.show_name_to_givers !== false,
        note: b.note
      });
      return sendJson(res, 201, { contribution });
    }

    const contributionMatch = pathname.match(/^\/api\/contributions\/([^/]{1,100})$/);
    if (contributionMatch && method === 'DELETE') {
      const user = requireUser();
      return sendJson(res, 200, withdrawContribution(db, { contributionId: decodeSegment(contributionMatch[1]), actorId: user.id }));
    }

    // =========================================================================
    // People I shop for, my gifts, secret ideas
    // =========================================================================
    if (pathname === '/api/dashboard' && method === 'GET') {
      const user = requireUser();

      const candidates = db.prepare(`
        SELECT DISTINCT u.id, u.name, u.birthday_month, u.birthday_day, u.is_dependent
        FROM users u
        WHERE u.status = 'active' AND u.id != ? AND (
          u.id IN (SELECT target_id FROM follows WHERE follower_id = ? AND target_type = 'user' AND status = 'approved')
          OR u.id IN (SELECT dependent_id FROM guardian_links WHERE guardian_id = ?)
          OR u.id IN (
            SELECT gm2.user_id FROM group_members gm1
            JOIN group_members gm2 ON gm1.group_id = gm2.group_id
            WHERE gm1.user_id = ?
          )
        )
        ORDER BY u.name ASC
        LIMIT 200
      `).all(user.id, user.id, user.id, user.id);

      const people = candidates
        .filter(person => !isBlockedBy(db, user.id, person.id))
        .map(person => {
          const lists = [];
          let unclaimedCount = 0;
          const topPriorities = [];

          for (const l of db.prepare('SELECT * FROM lists WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at ASC').all(person.id)) {
            const formatted = listDetail(l, user.id);
            // Lists the viewer co-owns are theirs, not somewhere to shop.
            if (!formatted || formatted.viewer_role === 'owner') continue;
            let open = 0;
            for (const it of formatted.items) {
              if (it.status !== 'active' || it.claim_summary?.is_fully_claimed) continue;
              open++;
              if (it.priority === 'most_wanted' || it.priority === 'high') {
                topPriorities.push({ id: it.id, title: it.title, price: it.price, store: it.store, kind: it.kind, priority: it.priority, list_id: l.id });
              }
            }
            unclaimedCount += open;
            lists.push({
              id: formatted.id, name: formatted.name, occasion: formatted.occasion, event_date: formatted.event_date,
              item_count: formatted.items.filter(i => i.status === 'active').length, unclaimed_count: open
            });
          }

          const occasions = db.prepare('SELECT * FROM occasions WHERE user_id = ?').all(person.id);
          const nextOccasion = computeNextOccasion(person, occasions);

          const myClaims = db.prepare(`
            SELECT c.qty, i.price AS item_price
            FROM claims c
            JOIN items i ON i.id = c.item_id
            JOIN lists l ON l.id = c.list_id
            WHERE c.claimer_user_id = ? AND l.owner_id = ? AND c.status IN ('reserved', 'purchased', 'given')
          `).all(user.id, person.id);
          const myPledges = db.prepare(`
            SELECT c.pledged_amount
            FROM contributions c
            JOIN lists l ON l.id = c.list_id
            WHERE c.contributor_user_id = ? AND l.owner_id = ? AND c.status IN ('pledged', 'paid_off_platform')
          `).all(user.id, person.id);
          const spent = Math.round((
            myClaims.reduce((s, c) => s + (c.item_price || 0) * (c.qty || 1), 0) +
            myPledges.reduce((s, c) => s + (c.pledged_amount || 0), 0)
          ) * 100) / 100;

          const budgets = db.prepare('SELECT * FROM budgets WHERE owner_id = ? AND subject_user_id = ? ORDER BY created_at DESC').all(user.id, person.id);
          const budget = budgets.find(bd => nextOccasion && bd.occasion === nextOccasion.kind) || budgets[0] || null;

          // Secret ideas are shared within a circle. Following someone is not
          // enough, and the person they are about never sees them (they are
          // not in their own "people" list, and this checks again).
          const secretIdeas = (person.id !== user.id && inSameCircle(db, user.id, person.id))
            ? db.prepare(`
                SELECT si.id, si.title, si.url, si.estimated_price, si.note, si.author_id, si.created_at, u.name AS author_name
                FROM secret_ideas si
                JOIN users u ON u.id = si.author_id
                WHERE si.subject_user_id = ?
                ORDER BY si.created_at DESC
                LIMIT 50
              `).all(person.id).map(si => ({
                id: si.id, title: si.title, url: si.url, estimated_price: si.estimated_price, note: si.note,
                author_name: si.author_name, is_mine: si.author_id === user.id, created_at: si.created_at
              }))
            : null;

          return {
            person: {
              id: person.id, name: person.name,
              birthday_month: person.birthday_month, birthday_day: person.birthday_day,
              is_dependent: Boolean(person.is_dependent)
            },
            next_occasion: nextOccasion,
            unclaimed_count: unclaimedCount,
            top_priorities: topPriorities.slice(0, 3),
            lists,
            budget: {
              limit: budget ? budget.amount : null,
              occasion: budget ? budget.occasion : (nextOccasion?.kind || 'Birthday'),
              spent,
              over_budget: budget ? spent > budget.amount : false
            },
            can_share_secret_ideas: secretIdeas !== null,
            secret_ideas: secretIdeas || []
          };
        });

      const myClaimsTracker = db.prepare(`
        SELECT c.id, c.status, c.qty, c.order_note, c.expires_at, c.clicked_out_at, c.return_prompt_answered, c.updated_at,
               i.id AS item_id, i.title AS item_title, i.price AS item_price, i.store AS item_store, i.kind AS item_kind,
               i.canonical_url AS item_url, i.variant AS item_variant, i.status AS item_status,
               l.id AS list_id, l.name AS list_name, l.event_date AS list_event_date,
               u.name AS recipient_name, u.id AS recipient_id
        FROM claims c
        JOIN items i ON i.id = c.item_id
        JOIN lists l ON l.id = c.list_id
        JOIN users u ON u.id = l.owner_id
        WHERE c.claimer_user_id = ? AND c.status IN ('reserved', 'purchased', 'given', 'withdrawn')
        ORDER BY c.updated_at DESC
        LIMIT 500
      `).all(user.id);

      const myPledgesTracker = db.prepare(`
        SELECT c.id, c.pledged_amount, c.status, c.note, c.created_at,
               i.id AS item_id, i.title AS item_title, i.price AS item_price, i.kind AS item_kind,
               l.id AS list_id, l.name AS list_name, u.name AS recipient_name
        FROM contributions c
        JOIN items i ON i.id = c.item_id
        JOIN lists l ON l.id = c.list_id
        JOIN users u ON u.id = l.owner_id
        WHERE c.contributor_user_id = ? AND c.status IN ('pledged', 'paid_off_platform')
        ORDER BY c.created_at DESC
        LIMIT 200
      `).all(user.id);

      return sendJson(res, 200, {
        people_i_shop_for: people,
        my_claims_tracker: myClaimsTracker,
        my_pledges: myPledgesTracker
      });
    }

    if (pathname === '/api/secret-ideas' && method === 'POST') {
      const user = requireUser();
      limit(req, 'secret-ideas', 30);
      const b = await body();
      const subject = getActiveUser(db, b.subject_user_id);
      if (!subject || subject.id === user.id || !inSameCircle(db, user.id, subject.id)) {
        throw forbidden('Secret ideas can only be shared about someone in one of your circles');
      }
      const title = cleanText(b.title, 200);
      if (!title) throw badRequest('Describe the idea');
      const id = uid('sec');
      db.prepare(`
        INSERT INTO secret_ideas (id, subject_user_id, author_id, title, url, estimated_price, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, subject.id, user.id, title,
        b.url ? canonicalizeUrl(b.url) : null,
        cleanPrice(b.estimated_price),
        cleanText(b.note, 500) || null,
        new Date().toISOString()
      );
      return sendJson(res, 201, { secret_idea: { id, title } });
    }

    const secretMatch = pathname.match(/^\/api\/secret-ideas\/([^/]{1,100})$/);
    if (secretMatch && method === 'DELETE') {
      const user = requireUser();
      const row = db.prepare('SELECT * FROM secret_ideas WHERE id = ?').get(decodeSegment(secretMatch[1]));
      if (!row || (row.author_id !== user.id && !user.is_admin) || row.subject_user_id === user.id) {
        throw notFound('Idea not found');
      }
      db.prepare('DELETE FROM secret_ideas WHERE id = ?').run(row.id);
      return sendJson(res, 200, { removed: true });
    }

    // =========================================================================
    // Follows
    // =========================================================================
    if (pathname === '/api/follows' && method === 'GET') {
      const user = requireUser();
      // Follows of me, of my lists, and of the children I look after.
      const followersOfMe = db.prepare(`
        SELECT f.id, f.status, f.target_type, f.target_id, f.created_at, u.name AS follower_name
        FROM follows f
        JOIN users u ON u.id = f.follower_id
        WHERE (f.target_type = 'user' AND (f.target_id = ? OR f.target_id IN (SELECT dependent_id FROM guardian_links WHERE guardian_id = ?)))
           OR (f.target_type = 'list' AND f.target_id IN (SELECT id FROM lists WHERE owner_id = ?))
        ORDER BY f.created_at DESC
        LIMIT 500
      `).all(user.id, user.id, user.id);
      const whoIFollow = db.prepare(`
        SELECT f.id, f.status, f.target_id, f.created_at, u.name AS target_name
        FROM follows f
        JOIN users u ON u.id = f.target_id
        WHERE f.follower_id = ? AND f.target_type = 'user' AND f.status != 'blocked'
        ORDER BY f.created_at DESC
        LIMIT 500
      `).all(user.id);
      return sendJson(res, 200, { followers_of_me: followersOfMe, who_i_follow: whoIFollow });
    }

    if (pathname === '/api/follows' && method === 'POST') {
      const user = requireUser();
      limit(req, 'follow', 30);
      const b = await body();
      const targetType = b.target_type === 'list' ? 'list' : 'user';
      const targetId = String(b.target_id ?? '');

      let owner = null;
      if (targetType === 'user') {
        owner = getActiveUser(db, targetId);
      } else {
        const l = db.prepare('SELECT * FROM lists WHERE id = ?').get(targetId);
        // A list can only be followed by someone who can already open it.
        if (l && getViewerRole(db, l, user.id).canView) owner = getActiveUser(db, l.owner_id);
      }
      if (!owner || owner.id === user.id) throw notFound('Nothing to follow there');
      if (isBlockedBy(db, user.id, owner.id)) throw notFound('Nothing to follow there');

      const existing = db.prepare('SELECT * FROM follows WHERE follower_id = ? AND target_type = ? AND target_id = ?')
        .get(user.id, targetType, targetId);
      if (existing?.status === 'blocked') throw notFound('Nothing to follow there');
      if (existing) return sendJson(res, 200, { follow: publicFollow(existing) });

      // Following shows that person's link-shared lists on your dashboard, so
      // it needs their say-so unless you are already in a circle together.
      const autoApprove = inSameCircle(db, user.id, owner.id) && !owner.follow_approval_required;
      const status = autoApprove ? 'approved' : 'pending';
      const followId = uid('fol');
      const nowIso = new Date().toISOString();
      db.prepare('INSERT INTO follows (id, follower_id, target_type, target_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(followId, user.id, targetType, targetId, status, nowIso);

      const recipients = owner.is_dependent
        ? db.prepare('SELECT guardian_id AS id FROM guardian_links WHERE dependent_id = ?').all(owner.id).map(r => r.id)
        : [owner.id];
      for (const id of recipients) {
        sendNotification(db, {
          recipientUserId: id,
          eventType: 'new_follower',
          subject: status === 'pending' ? `${user.name} asked to follow ${owner.is_dependent ? owner.name : 'you'}` : `${user.name} is following ${owner.is_dependent ? owner.name : 'you'}`,
          body: status === 'pending'
            ? `${user.name} would like to follow ${owner.is_dependent ? `${owner.name}'s` : 'your'} wishlists. Approve or decline from the Gifting page.`
            : `${user.name} started following ${owner.is_dependent ? `${owner.name}'s` : 'your'} wishlists.`
        });
      }
      return sendJson(res, 201, { follow: publicFollow(db.prepare('SELECT * FROM follows WHERE id = ?').get(followId)) });
    }

    const followMatch = pathname.match(/^\/api\/follows\/([^/]{1,100})$/);
    if (followMatch && (method === 'PATCH' || method === 'DELETE')) {
      const user = requireUser();
      const fol = db.prepare('SELECT * FROM follows WHERE id = ?').get(decodeSegment(followMatch[1]));
      const ownerId = fol
        ? (fol.target_type === 'user' ? fol.target_id : db.prepare('SELECT owner_id FROM lists WHERE id = ?').get(fol.target_id)?.owner_id)
        : null;
      const isTargetOwner = Boolean(ownerId && (ownerId === user.id || isGuardianOf(db, user.id, ownerId)));
      const isFollower = Boolean(fol && fol.follower_id === user.id);
      if (!fol || (!isTargetOwner && !isFollower)) throw notFound('Follow not found');

      if (method === 'DELETE') {
        // A blocked follower cannot erase the block by deleting the row.
        if (!isTargetOwner && fol.status === 'blocked') throw notFound('Follow not found');
        db.prepare('DELETE FROM follows WHERE id = ?').run(fol.id);
        return sendJson(res, 200, { removed: true });
      }

      // Approving, declining and blocking belong to the person being followed.
      if (!isTargetOwner) throw forbidden('Only the person being followed can change this');
      const b = await body();
      if (!['approved', 'blocked', 'pending'].includes(b.status)) throw badRequest('Unknown status');
      db.prepare('UPDATE follows SET status = ? WHERE id = ?').run(b.status, fol.id);
      return sendJson(res, 200, { follow: publicFollow(db.prepare('SELECT * FROM follows WHERE id = ?').get(fol.id)) });
    }

    // =========================================================================
    // Notifications, budgets
    // =========================================================================
    if (pathname === '/api/notifications/digest' && method === 'POST') {
      const user = requireUser();
      return sendJson(res, 200, { digest: generateFollowerDigest(db, { followerUserId: user.id }) });
    }

    if (pathname === '/api/notifications' && method === 'GET') {
      // Signed-in people see their own messages. Guests see nothing here: a
      // verification code is proof of mailbox access and is never readable by API.
      if (!currentUser) return sendJson(res, 200, { notifications: [] });
      const rows = db.prepare(`
        SELECT id, event_type, subject, body, transactional, scheduled_for, sent_at, created_at
        FROM notifications_outbox
        WHERE recipient_user_id = ? OR (recipient_user_id IS NULL AND LOWER(recipient_email) = LOWER(?))
        ORDER BY created_at DESC LIMIT 100
      `).all(currentUser.id, currentUser.email || '');
      return sendJson(res, 200, { notifications: rows.map(n => ({ ...n, transactional: Boolean(n.transactional) })) });
    }

    if (pathname === '/api/budgets' && method === 'POST') {
      const user = requireUser();
      const b = await body();
      const subject = getActiveUser(db, b.subject_user_id);
      if (!subject || subject.id === user.id) throw badRequest('Choose a person');
      const amount = cleanPrice(b.amount, 1_000_000);
      if (amount === null || amount <= 0) throw badRequest('Enter a budget greater than zero');
      db.prepare(`
        INSERT INTO budgets (id, owner_id, subject_user_id, occasion, amount, currency, created_at)
        VALUES (?, ?, ?, ?, ?, 'USD', ?)
        ON CONFLICT(owner_id, subject_user_id, occasion) DO UPDATE SET amount = excluded.amount
      `).run(uid('bdg'), user.id, subject.id, cleanText(b.occasion, 40) || 'Birthday', amount, new Date().toISOString());
      return sendJson(res, 200, { saved: true });
    }

    // =========================================================================
    // Import and export
    // =========================================================================
    if (pathname === '/api/import/amazon' && method === 'POST') {
      const user = requireUser();
      limit(req, 'import', 10);
      const b = await body();
      const report = importAmazonList(db, {
        listId: b.list_id,
        canEdit: (list) => getViewerRole(db, list, user.id).canEdit && !list.archived_at,
        amazonListUrl: b.amazon_list_url,
        itemsPayload: b.items ?? []
      });
      return sendJson(res, 200, { report });
    }

    if (pathname === '/api/export' && method === 'GET') {
      const user = requireUser();
      const format = urlObj.searchParams.get('format') === 'csv' ? 'csv' : 'json';

      const myLists = db.prepare(`
        SELECT id, name, occasion, event_date, visibility, surprise_mode, archived_at, created_at
        FROM lists WHERE owner_id = ?
      `).all(user.id);
      const myItems = db.prepare(`
        SELECT i.title, i.kind, i.store, i.price, i.currency, i.variant, i.qty_wanted, i.priority,
               i.canonical_url, i.notes, i.status, l.name AS list_name
        FROM items i JOIN lists l ON l.id = i.list_id
        WHERE l.owner_id = ? AND i.status NOT IN ('deleted', 'got_it')
      `).all(user.id);
      // Only claims this person made for others. Claims ON their own lists are
      // never exported: that would be the surprise.
      const claimsIMade = db.prepare(`
        SELECT c.status, c.qty, c.order_note, c.created_at, i.title AS item_title, i.store, i.price, i.currency, u.name AS recipient_name
        FROM claims c
        JOIN items i ON i.id = c.item_id
        JOIN lists l ON l.id = c.list_id
        JOIN users u ON u.id = l.owner_id
        WHERE c.claimer_user_id = ?
      `).all(user.id);

      if (format === 'csv') {
        const header = 'RecordType,ListOrRecipient,Title,KindOrStatus,Store,Price,Currency,Variant,Qty,Priority,URL,Notes';
        const lines = [
          ...myItems.map(i => ['WishlistItem', i.list_name, i.title, i.kind, i.store, i.price ?? '', i.currency, i.variant ?? '', i.qty_wanted, i.priority, i.canonical_url ?? '', i.notes ?? '']),
          ...claimsIMade.map(c => ['MyClaim', c.recipient_name, c.item_title, c.status, c.store ?? '', c.price ?? '', c.currency || 'USD', '', c.qty, '', '', c.order_note ?? ''])
        ].map(row => row.map(csvCell).join(','));
        const csv = [header, ...lines].join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="hushlist-export.csv"',
          'Cache-Control': 'no-store'
        });
        res.end(csv);
        return;
      }

      const payload = JSON.stringify({
        exported_at: new Date().toISOString(),
        user: { id: user.id, name: user.name, email: user.email },
        lists: myLists,
        items: myItems,
        my_claims_for_others: claimsIMade
      }, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="hushlist-export.json"',
        'Cache-Control': 'no-store'
      });
      res.end(payload);
      return;
    }

    // =========================================================================
    // Circles (groups) and Secret Santa
    // =========================================================================
    if (pathname === '/api/groups' && method === 'GET') {
      if (!currentUser) return sendJson(res, 200, { groups: [] });
      const groups = db.prepare(`
        SELECT g.*, me.role AS my_role FROM groups g
        JOIN group_members me ON me.group_id = g.id AND me.user_id = ?
        ORDER BY g.created_at ASC
      `).all(currentUser.id).map(g => {
        const members = db.prepare(`
          SELECT u.id, u.name, gm.role
          FROM group_members gm JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = ? AND u.status = 'active'
          ORDER BY gm.role DESC, u.name ASC
        `).all(g.id);
        const exchanges = db.prepare('SELECT * FROM secret_santa_exchanges WHERE group_id = ? ORDER BY created_at DESC LIMIT 20').all(g.id).map(ex => {
          // Each person can read exactly one pairing: their own.
          const mine = db.prepare(`
            SELECT u.id, u.name FROM secret_santa_pairings p
            JOIN users u ON u.id = p.recipient_user_id
            WHERE p.exchange_id = ? AND p.giver_user_id = ?
          `).get(ex.id, currentUser.id);
          return {
            id: ex.id, name: ex.name, event_date: ex.event_date, budget_limit: ex.budget_limit,
            participant_count: db.prepare('SELECT COUNT(*) AS n FROM secret_santa_pairings WHERE exchange_id = ?').get(ex.id).n,
            my_assigned_recipient: mine || null
          };
        });
        return {
          id: g.id, name: g.name, description: g.description, my_role: g.my_role,
          invite_code: g.invite_code, members, exchanges
        };
      });
      return sendJson(res, 200, { groups });
    }

    if (pathname === '/api/groups' && method === 'POST') {
      const user = requireUser();
      limit(req, 'group-create', 10);
      const b = await body();
      const name = cleanText(b.name, 80);
      if (!name) throw badRequest('Give the circle a name');
      const id = uid('grp');
      const nowIso = new Date().toISOString();
      inTransaction(db, () => {
        db.prepare('INSERT INTO groups (id, name, description, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, name, cleanText(b.description, 300) || null, secretToken().slice(0, 12).toUpperCase(), user.id, nowIso);
        db.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'organizer', ?)").run(id, user.id, nowIso);
      });
      return sendJson(res, 201, { group: { id, name } });
    }

    if (pathname === '/api/groups/join' && method === 'POST') {
      const user = requireUser();
      limit(req, 'group-join', 10);
      const b = await body();
      return sendJson(res, 200, { group: joinGroupByInvite(db, user.id, cleanText(b.invite_code, 64)) });
    }

    if (pathname === '/api/secret-santa' && method === 'POST') {
      const user = requireUser();
      limit(req, 'santa', 10);
      const b = await body();
      const groupId = String(b.group_id ?? '');
      const today = new Date().toISOString().slice(0, 10);
      // One live draw per circle. Re-rolling would let an organizer keep
      // drawing until they liked their own result.
      const live = db.prepare('SELECT 1 FROM secret_santa_exchanges WHERE group_id = ? AND event_date >= ?').get(groupId, today);
      if (live && isGroupMember(db, groupId, user.id)) {
        throw conflict('Names have already been drawn for this circle. A new draw is possible after that exchange date.');
      }
      const exchange = createSecretSantaExchange(db, {
        groupId,
        name: b.name,
        eventDate: b.event_date,
        budgetLimit: b.budget_limit ?? 50,
        exclusions: b.exclusions ?? [],
        createdBy: user.id
      });
      return sendJson(res, 201, { exchange });
    }

    // =========================================================================
    // Reports and admin
    // =========================================================================
    if (pathname === '/api/reports' && method === 'POST') {
      limit(req, 'reports', 5);
      const b = await body();
      const targetType = ['list', 'item', 'user'].includes(b.target_type) ? b.target_type : null;
      const targetId = cleanText(b.target_id, 100);
      if (!targetType || !targetId) throw badRequest('Say what you are reporting');
      const reportId = uid('rep');
      const nowIso = new Date().toISOString();
      db.prepare(`
        INSERT INTO abuse_reports (id, reporter_id, target_type, target_id, reason, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?)
      `).run(reportId, currentUser?.id || null, targetType, targetId, cleanText(b.reason, 1000) || 'No reason given', nowIso);

      // Reporting a person also blocks them, whether or not they follow you yet.
      if (currentUser && targetType === 'user' && b.block !== false && targetId !== currentUser.id && getActiveUser(db, targetId)) {
        db.prepare(`
          INSERT INTO follows (id, follower_id, target_type, target_id, status, created_at)
          VALUES (?, ?, 'user', ?, 'blocked', ?)
          ON CONFLICT(follower_id, target_type, target_id) DO UPDATE SET status = 'blocked'
        `).run(uid('fol'), targetId, currentUser.id, nowIso);
      }
      return sendJson(res, 201, { report_id: reportId, status: 'open' });
    }

    if (pathname === '/api/admin' && method === 'GET') {
      const admin = requireAdmin();
      // Lists the admin owns or co-owns in surprise mode are excluded: being
      // an administrator does not entitle anyone to their own surprise.
      const ownSealed = db.prepare(`
        SELECT id FROM lists
        WHERE surprise_mode = 1 AND revealed_at IS NULL AND (owner_id = ? OR co_owner_ids LIKE ?)
      `).all(admin.id, `%"${admin.id}"%`).map(l => l.id);
      const hidden = new Set(ownSealed);

      const claimAudit = db.prepare(`
        SELECT ce.id, ce.from_state, ce.to_state, ce.actor, ce.reason, ce.at, c.list_id, i.title AS item_title
        FROM claim_events ce
        JOIN claims c ON c.id = ce.claim_id
        JOIN items i ON i.id = c.item_id
        ORDER BY ce.at DESC LIMIT 200
      `).all().filter(r => !hidden.has(r.list_id)).slice(0, 50).map(({ list_id, ...rest }) => rest);

      const overridable = db.prepare(`
        SELECT c.id, c.status, c.qty, c.list_id, u.name AS claimer_name, c.guest_name,
               i.title AS item_title, l.name AS list_name
        FROM claims c
        JOIN items i ON i.id = c.item_id
        JOIN lists l ON l.id = c.list_id
        LEFT JOIN users u ON u.id = c.claimer_user_id
        WHERE c.status IN ('reserved', 'purchased', 'pending_verification')
        ORDER BY c.updated_at DESC LIMIT 500
      `).all().filter(r => !hidden.has(r.list_id)).slice(0, 200).map(({ list_id, guest_name, claimer_name, ...rest }) => ({
        ...rest, claimer_name: claimer_name || guest_name || 'Guest'
      }));

      return sendJson(res, 200, {
        retailer_adapters: db.prepare('SELECT * FROM retailer_adapters ORDER BY store_name ASC').all(),
        abuse_reports: db.prepare('SELECT * FROM abuse_reports ORDER BY created_at DESC LIMIT 200').all(),
        claim_audit_log: claimAudit,
        overridable_claims: overridable,
        analytics_events: db.prepare('SELECT event_name, properties, created_at FROM analytics_events ORDER BY created_at DESC LIMIT 100').all()
      });
    }

    if (pathname === '/api/admin/claims/override' && method === 'POST') {
      const admin = requireAdmin();
      const b = await body();
      const reason = cleanText(b.reason, 300);
      if (!b.claim_id || !reason) throw badRequest('A reservation and a reason are required');
      const updated = transitionClaimState(db, {
        claimId: b.claim_id, newState: 'released', actorId: admin.id, asAdmin: true, reason
      });
      return sendJson(res, 200, { claim: { id: updated.id, status: updated.status } });
    }

    const reportMatch = pathname.match(/^\/api\/admin\/reports\/([^/]{1,100})$/);
    if (reportMatch && method === 'PATCH') {
      const admin = requireAdmin();
      const reportId = decodeSegment(reportMatch[1]);
      const b = await body();
      if (!['resolved', 'dismissed', 'open'].includes(b.status)) throw badRequest('Unknown status');
      const changed = db.prepare('UPDATE abuse_reports SET status = ?, resolved_by = ?, resolution_note = ? WHERE id = ?')
        .run(b.status, admin.id, cleanText(b.resolution_note, 500) || null, reportId).changes;
      if (!changed) throw notFound('Report not found');
      return sendJson(res, 200, { report: db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(reportId) });
    }

    if (pathname === '/api/admin/adapters' && method === 'POST') {
      requireAdmin();
      const b = await body();
      const domain = String(b.domain ?? '').trim().toLowerCase().replace(/^www\./, '');
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) || domain.length > 253) {
        throw badRequest('Enter a valid domain');
      }
      const storeName = cleanText(b.store_name, 80);
      if (!storeName) throw badRequest('Enter the store name');
      const selector = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
      db.prepare(`
        INSERT INTO retailer_adapters (
          domain, store_name, title_selector, price_selector, image_selector, variant_selector, client_only, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          store_name = excluded.store_name, title_selector = excluded.title_selector,
          price_selector = excluded.price_selector, image_selector = excluded.image_selector,
          variant_selector = excluded.variant_selector, client_only = excluded.client_only, updated_at = excluded.updated_at
      `).run(
        domain, storeName, selector(b.title_selector), selector(b.price_selector),
        selector(b.image_selector), selector(b.variant_selector), b.client_only ? 1 : 0, new Date().toISOString()
      );
      return sendJson(res, 200, { saved: true });
    }

    // =========================================================================
    // Front end
    // =========================================================================
    if (!isApi && (method === 'GET' || method === 'HEAD')) {
      if (await serveStatic(req, res, PUBLIC_DIR, pathname)) return;
      throw notFound('Not found');
    }

    throw notFound('Not found');
  }

  async function handleRequest(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      await route(req, res);
    } catch (err) {
      respondWithError(res, err);
    }
  }

  const server = http.createServer((req, res) => {
    // Nothing a client sends may reject this promise unhandled: in Node that
    // terminates the whole process.
    handleRequest(req, res).catch(err => respondWithError(res, err));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;

  return { server, db, handleRequest, config };
}

function respondWithError(res, err) {
  try {
    if (res.headersSent || res.writableEnded) {
      // Too late to say anything useful; make sure the socket is not left hanging.
      res.destroy();
      return;
    }
    if (err instanceof AppError) {
      return sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
    }
    if (err instanceof TypeError && /Invalid URL/i.test(err.message)) {
      return sendJson(res, 400, { error: 'Malformed request' });
    }
    console.error('[hushlist] unexpected error:', err);
    sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
  } catch (fatal) {
    console.error('[hushlist] failed to send error response:', fatal);
    try { res.destroy(); } catch { /* already gone */ }
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest('Malformed URL');
  }
}

function nullableInt(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`Enter a whole number between ${min} and ${max}`);
  return n;
}

/**
 * A real YYYY-MM-DD date that is not in the past (one day of slack for time
 * zones). Occasion dates drive the reveal unlock, so "set it to last year,
 * then reveal" must not be possible.
 */
function futureDateOrThrow(value) {
  const date = cleanDate(value);
  if (!date) throw badRequest('Enter the date as YYYY-MM-DD');
  const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
  if (date < yesterday) throw badRequest('Pick today or a later date');
  return date;
}

/** The first day an owner may open a surprise list: seven days after the occasion. */
function revealUnlockDate(list) {
  const date = cleanDate(list.event_date);
  if (!date) return null;
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 7 * 86400 * 1000).toISOString().slice(0, 10);
}

function publicFollow(f) {
  return { id: f.id, target_type: f.target_type, target_id: f.target_id, status: f.status, created_at: f.created_at };
}

function formatListResponse(db, list, viewerUserId = null, guestClaimToken = null) {
  const viewerCtx = getViewerRole(db, list, viewerUserId, guestClaimToken);
  if (!viewerCtx.canView) return null;

  const owner = db.prepare('SELECT id, name, is_dependent FROM users WHERE id = ?').get(list.owner_id);
  const rawItems = db.prepare(`
    SELECT * FROM items
    WHERE list_id = ? AND status IN ('active', 'received')
    ORDER BY
      CASE priority WHEN 'most_wanted' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ASC,
      sort_order ASC, created_at ASC
    LIMIT ${MAX_ITEMS_PER_LIST}
  `).all(list.id);

  const response = {
    id: list.id,
    owner_id: list.owner_id,
    owner_name: owner?.name || 'Someone',
    owner_is_dependent: Boolean(owner?.is_dependent),
    name: list.name,
    occasion: list.occasion,
    event_date: list.event_date,
    visibility: list.visibility,
    surprise_mode: Boolean(list.surprise_mode),
    revealed_at: list.revealed_at,
    archived_at: list.archived_at,
    created_at: list.created_at,
    viewer_role: viewerCtx.role,
    viewer_in_circle: Boolean(viewerCtx.isGroupMember),
    can_edit: Boolean(viewerCtx.canEdit),
    can_see_claims: Boolean(viewerCtx.canSeeClaims),
    can_release_claims: Boolean(viewerCtx.canReleaseClaims),
    items: rawItems.map(item => sanitizeItemForViewer(db, item, list, viewerCtx, viewerUserId))
  };

  // The share link is for people who manage the list, or lists that are
  // link-shared anyway (where every viewer could copy the address bar).
  if (viewerCtx.canEdit || list.visibility === 'link') response.share_token = list.share_token;

  if (viewerCtx.canEdit) {
    response.co_owner_ids = safeJsonParse(list.co_owner_ids, []);
    response.guest_claim_cap = list.guest_claim_cap;
    response.claim_expiry_days = list.claim_expiry_days;
    response.reveal_unlocks_on = revealUnlockDate(list);
    response.helpers = db.prepare(`
      SELECT u.id, u.name FROM list_shares ls
      JOIN users u ON u.id = ls.grantee_id
      WHERE ls.list_id = ? AND ls.grantee_type = 'user' AND ls.permission = 'helper'
    `).all(list.id);
    response.shared_with_groups = db.prepare(`
      SELECT g.id, g.name FROM list_shares ls
      JOIN groups g ON g.id = ls.grantee_id
      WHERE ls.list_id = ? AND ls.grantee_type = 'group'
    `).all(list.id);
  }

  return response;
}

/**
 * Next occasion for a person: the nearest upcoming stored occasion (yearly
 * ones roll forward), else their birthday. Never throws on bad stored dates.
 */
function computeNextOccasion(person, occasions = []) {
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const candidates = [];

  const nextYearly = (month, day) => {
    if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;
    for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
      const ms = Date.UTC(year, month - 1, day);
      if (new Date(ms).getUTCMonth() === month - 1 && ms >= todayMs) return ms;
    }
    return null;
  };

  for (const occ of occasions) {
    const date = cleanDate(occ.date);
    if (!date) continue;
    let ms = Date.parse(`${date}T00:00:00Z`);
    if (ms < todayMs && occ.recurs) ms = nextYearly(Number(date.slice(5, 7)), Number(date.slice(8, 10)));
    if (ms === null || ms < todayMs) continue;
    candidates.push({ label: occ.label, kind: occ.kind, ms });
  }

  const birthdayMs = nextYearly(person.birthday_month, person.birthday_day);
  if (birthdayMs !== null && !candidates.some(c => c.kind === 'Birthday')) {
    candidates.push({ label: `${person.name}'s birthday`, kind: 'Birthday', ms: birthdayMs });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.ms - b.ms);
  const best = candidates[0];
  return {
    label: best.label,
    kind: best.kind,
    date: new Date(best.ms).toISOString().slice(0, 10),
    days_remaining: Math.round((best.ms - todayMs) / 86400000)
  };
}

const PLACEHOLDER_PALETTES = new Map(Object.entries({
  indigo: ['#312e81', '#4f46e5', '#e0e7ff'],
  emerald: ['#064e3b', '#10b981', '#d1fae5'],
  forest: ['#14532d', '#16a34a', '#dcfce7'],
  amber: ['#78350f', '#d97706', '#fef3c7'],
  rose: ['#881337', '#e11d48', '#ffe4e6'],
  teal: ['#134e4a', '#0d9488', '#ccfbf1'],
  blue: ['#1e3a8a', '#2563eb', '#dbeafe'],
  purple: ['#581c87', '#9333ea', '#f3e8ff'],
  slate: ['#0f172a', '#334155', '#f1f5f9']
}));

function renderPlaceholderSvg(label, theme) {
  const [c1, c2, textCol] = PLACEHOLDER_PALETTES.get(String(theme)) || PLACEHOLDER_PALETTES.get('indigo');
  const text = cleanText(label, 32).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="280" viewBox="0 0 400 280">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
  <rect width="400" height="280" rx="18" fill="url(#g)"/>
  <circle cx="340" cy="50" r="70" fill="#fff" fill-opacity="0.08"/>
  <circle cx="60" cy="230" r="90" fill="#fff" fill-opacity="0.06"/>
  <text x="32" y="148" fill="${textCol}" font-family="system-ui, sans-serif" font-size="22" font-weight="700">${text}</text>
</svg>`;
}

// Start the server when run directly.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const { server, config } = createApp();
  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`Hushlist is running at http://${shown}:${config.port}`);
    console.log(config.demoMode
      ? 'Demo mode: sample family loaded, one-click sign-in enabled, reachable from this machine only. Set HUSHLIST_DEMO=0 to turn it off.'
      : 'Demo mode is off. Sign-in codes are written to this log until an email provider is configured.');
  });
}
